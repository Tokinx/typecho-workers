import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, cache as platformCache } from 'cloudflare:workers';
import { _resetCaches } from '../../../tests/__mocks__/cloudflare-workers';
import type { PluginInitContext } from 'typecho/plugin-sdk';
import init from './index';
import {
  createSharedCacheTrace,
  formatSharedCacheTrace,
  loadEarlyRequestSharedData,
  notifyEarlyRequestInvalidation,
  registerEarlyRequestLoaders,
  resetEarlyRequestProvidersForTests,
} from '@/lib/early-request';
import { loadQueryCache } from '@/lib/query-cache';
import {
  CACHE_BYPASS_REASON_HEADER,
  CACHE_CONTROL_KEY,
  CACHE_PLUGIN_ID,
  buildControlDocument,
  classifyCacheDomain,
  earlyRequestProvider,
  LAST_REFRESH_KEY,
  normalizeCacheConfig,
  normalizeCacheUrl,
  PUBLIC_HTML_HEADER,
  resetCacheProviderForTests,
  rewriteHtmlString,
  rewriteResourceUrl,
} from './cache';

class MemoryKv implements KVNamespace {
  store = new Map<string, string>();
  getKeys: string[] = [];
  putOptions = new Map<string, KVNamespacePutOptions | undefined>();
  failGet = false;
  put = vi.fn(async (
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ) => {
    this.store.set(key, typeof value === 'string' ? value : String(value));
    this.putOptions.set(key, options);
  });
  delete = vi.fn(async (key: string) => {
    this.store.delete(key);
  });

  async get<T = unknown>(key: string, options?: KVNamespaceGetOptions<any>): Promise<T | string | ArrayBuffer | null> {
    this.getKeys.push(key);
    if (this.failGet) throw new Error('KV unavailable');
    const value = this.store.get(key);
    if (value === undefined) return null;
    if (options?.type === 'json') return JSON.parse(value) as T;
    if (options?.type === 'arrayBuffer') return new TextEncoder().encode(value).buffer;
    return value;
  }
}

class MemoryD1 implements D1Database {
  rows = new Map<string, { value: string; expiresAt: number }>();

  prepare = vi.fn((sql: string) => {
    const statement = {
      sql,
      values: [] as unknown[],
      bind: vi.fn((...values: unknown[]) => {
        statement.values = values;
        return statement;
      }),
      first: vi.fn(async <T>() => {
        if (!sql.includes('FROM typecho_db_cache')) return null as T | null;
        const row = this.rows.get(String(statement.values[0]));
        const now = Number(statement.values[1]);
        return row && row.expiresAt > now ? { ...row } as T : null;
      }),
      all: vi.fn(async <T>() => ({ results: [] as T[] })),
      run: vi.fn(async () => {
        if (sql.startsWith('DELETE FROM typecho_db_cache')) {
          const now = Number(statement.values[0]);
          let changes = 0;
          for (const [key, row] of this.rows) {
            if (row.expiresAt <= now) {
              this.rows.delete(key);
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        return { success: true };
      }),
    };
    return statement;
  }) as unknown as D1Database['prepare'];

  batch = vi.fn(async (statements: D1PreparedStatement[]) => {
    for (const statement of statements as Array<D1PreparedStatement & { sql?: string; values?: unknown[] }>) {
      const values = statement.values || [];
      if (statement.sql?.startsWith('DELETE FROM typecho_db_cache')) {
        const now = Number(values[0]);
        for (const [key, row] of this.rows) {
          if (row.expiresAt <= now) this.rows.delete(key);
        }
      } else if (statement.sql?.startsWith('INSERT INTO typecho_db_cache')) {
        this.rows.set(String(values[0]), {
          value: String(values[1]),
          expiresAt: Number(values[2]),
        });
      }
    }
    return [];
  }) as unknown as D1Database['batch'];
}

const defaultSettings = {
  cacheScopes: ['home', 'post', 'page', 'note', 'archive', 'other'],
  l1Ttl: '604800',
  l2Ttl: '259200',
  l3Ttl: '21600',
  staticCdnUrl: '',
  staticExtensions: 'jpg,png,css,js,zip',
  avatarCdnUrl: '',
};

async function activate(kv: MemoryKv, settings: Record<string, unknown> = defaultSettings): Promise<void> {
  env.TYPECHO_CACHE = kv as any;
  await earlyRequestProvider.lifecycle!({
    type: 'activate',
    settings,
    options: {
      siteUrl: 'https://example.com',
      permalinkPattern: '/archives/{cid}/',
      pagePattern: '/{slug}.html',
      categoryPattern: '/category/{slug}/',
    },
  });
}

function requestContext(url = 'https://example.com/', d1: D1Database | null = null) {
  const request = new Request(url);
  return {
    request,
    url: new URL(url),
    env: { TYPECHO_CACHE: env.TYPECHO_CACHE, DB: d1 },
  };
}

beforeEach(() => {
  _resetCaches();
  resetCacheProviderForTests();
  resetEarlyRequestProvidersForTests();
  env.TYPECHO_CACHE = null as any;
  env.DB = null as any;
  vi.restoreAllMocks();
});

describe('typecho-plugin-cache provider', () => {
  it('serves a warm L1 response without running the D1 renderer again', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>first</html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8', [PUBLIC_HTML_HEADER]: '1' },
    }));

    const first = await earlyRequestProvider.handle(requestContext(), next);
    const second = await earlyRequestProvider.handle(requestContext(), next);

    expect(first.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=0');
    expect(first.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=604800');
    expect(first.headers.get('Cache-Tag')).toBe('tc:all, tc:home');
    expect(second.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(second.headers.get('Cache-Tag')).toBe('tc:all, tc:home');
    expect(await second.text()).toContain('first');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('serves L2 and refills L1 after the local edge cache is cold', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, l1Ttl: '259200' });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    await earlyRequestProvider.handle(requestContext('https://example.com/archives/1/'), next);
    _resetCaches();

    const response = await earlyRequestProvider.handle(requestContext('https://example.com/archives/1/'), next);
    expect(response.headers.get('X-Typecho-Cache')).toBe('L2');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=259200');
    expect(response.headers.get('Cache-Tag')).toBe('tc:all, tc:post');
    expect(await response.text()).toContain('from d1');
    expect(next).toHaveBeenCalledTimes(1);

    const refilled = await earlyRequestProvider.handle(requestContext('https://example.com/archives/1/'), next);
    expect(refilled.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(refilled.headers.get('Cache-Control')).toBe('public, max-age=0');
    expect(refilled.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=259200');
    expect(refilled.headers.get('Cache-Tag')).toBe('tc:all, tc:post');
  });

  it('disables L1 reads and writes while keeping L2 available', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, l1Ttl: '0', l2Ttl: '86400' });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));

    const first = await earlyRequestProvider.handle(requestContext('https://example.com/archives/2/'), next);
    const second = await earlyRequestProvider.handle(requestContext('https://example.com/archives/2/'), next);

    expect(first.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(first.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(second.headers.get('X-Typecho-Cache')).toBe('L2');
    expect(second.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(next).toHaveBeenCalledOnce();
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(true);
  });

  it('disables L2 page reads and writes while retaining L1 hits', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, l1Ttl: '86400', l2Ttl: '0' });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));

    const first = await earlyRequestProvider.handle(requestContext('https://example.com/archives/3/'), next);
    const second = await earlyRequestProvider.handle(requestContext('https://example.com/archives/3/'), next);

    expect(first.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(second.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(next).toHaveBeenCalledOnce();
    expect(kv.getKeys.some(key => key.includes(':p:'))).toBe(false);
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);
  });

  it('serves an L3 hit without L1 or L2 and without rendering D1 again', async () => {
    const kv = new MemoryKv();
    const d1 = new MemoryD1();
    await activate(kv, { ...defaultSettings, l1Ttl: '0', l2Ttl: '0', l3Ttl: '21600' });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));

    const first = await earlyRequestProvider.handle(requestContext('https://example.com/archives/5/', d1), next);
    const second = await earlyRequestProvider.handle(requestContext('https://example.com/archives/5/', d1), next);

    expect(first.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(second.headers.get('X-Typecho-Cache')).toBe('L3');
    expect(second.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(await second.text()).toContain('from d1');
    expect(next).toHaveBeenCalledOnce();
    expect(kv.getKeys.some(key => key.includes(':p:'))).toBe(false);
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);
    expect(d1.rows.size).toBe(1);
  });

  it('promotes an L3 hit into enabled L1 and L2 caches', async () => {
    const kv = new MemoryKv();
    const d1 = new MemoryD1();
    await activate(kv, { ...defaultSettings, l3Ttl: '21600' });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const url = 'https://example.com/archives/6/';

    await earlyRequestProvider.handle(requestContext(url, d1), next);
    const pageKey = [...kv.store.keys()].find(key => key.includes(':p:'))!;
    kv.store.delete(pageKey);
    _resetCaches();

    const l3 = await earlyRequestProvider.handle(requestContext(url, d1), next);
    expect(l3.headers.get('X-Typecho-Cache')).toBe('L3');
    expect(next).toHaveBeenCalledOnce();
    expect(kv.store.has(pageKey)).toBe(true);

    const l1 = await earlyRequestProvider.handle(requestContext(url, d1), next);
    expect(l1.headers.get('X-Typecho-Cache')).toBe('L1');
  });

  it('does not read or write L3 when its TTL is disabled', async () => {
    const kv = new MemoryKv();
    const d1 = new MemoryD1();
    await activate(kv, { ...defaultSettings, l1Ttl: '0', l2Ttl: '86400', l3Ttl: '0' });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));

    await earlyRequestProvider.handle(requestContext('https://example.com/archives/7/', d1), next);
    expect(d1.prepare).not.toHaveBeenCalled();
    expect(d1.rows.size).toBe(0);
  });

  it('falls through to D1 when the L3 row is expired', async () => {
    const kv = new MemoryKv();
    const d1 = new MemoryD1();
    await activate(kv, { ...defaultSettings, l1Ttl: '0', l2Ttl: '0', l3Ttl: '21600' });
    const next = vi.fn(async () => new Response(`<html>${next.mock.calls.length}</html>`, {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const url = 'https://example.com/archives/8/';

    await earlyRequestProvider.handle(requestContext(url, d1), next);
    const row = [...d1.rows.values()][0]!;
    row.expiresAt = 0;
    const response = await earlyRequestProvider.handle(requestContext(url, d1), next);

    expect(response.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('passes through D1 on every request when all cache layers are disabled', async () => {
    const kv = new MemoryKv();
    const d1 = new MemoryD1();
    await activate(kv, { ...defaultSettings, l1Ttl: 0, l2Ttl: 0, l3Ttl: 0 });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));

    const first = await earlyRequestProvider.handle(requestContext('https://example.com/archives/4/', d1), next);
    const second = await earlyRequestProvider.handle(requestContext('https://example.com/archives/4/', d1), next);

    expect(first.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(second.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(first.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(second.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(next).toHaveBeenCalledTimes(2);
    expect(d1.prepare).not.toHaveBeenCalled();
    expect(kv.getKeys.some(key => key.includes(':p:') || key.includes(':g:'))).toBe(false);
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);
  });

  it('advances a generation so the next request renders again', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    let render = 0;
    const next = vi.fn(async () => new Response(`<html>${++render}</html>`, {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    await earlyRequestProvider.handle(requestContext(), next);
    expect(await earlyRequestProvider.invalidate!({ reason: 'post', domains: ['all'] })).toBe(true);
    const response = await earlyRequestProvider.handle(requestContext(), next);
    expect(response.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(await response.text()).toContain('2');
  });

  it('coalesces concurrent cache misses into one D1 render per isolate', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    let releaseRender!: () => void;
    let markStarted!: () => void;
    const renderGate = new Promise<void>(resolve => { releaseRender = resolve; });
    const renderStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const next = vi.fn(async () => {
      markStarted();
      await renderGate;
      return new Response('<html>coalesced</html>', { headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' } });
    });

    const first = earlyRequestProvider.handle(requestContext(), next);
    await renderStarted;
    const second = earlyRequestProvider.handle(requestContext(), next);
    releaseRender();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(next).toHaveBeenCalledOnce();
    expect(await firstResponse.text()).toContain('coalesced');
    expect(await secondResponse.text()).toContain('coalesced');
  });

  it('allows ordinary cookies but bypasses unsafe query and request variants', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>private variant</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const ordinaryCookie = requestContext();
    ordinaryCookie.request = new Request(ordinaryCookie.request, { headers: { Cookie: 'theme=dark' } });
    const caseVariantCookie = requestContext();
    caseVariantCookie.request = new Request(caseVariantCookie.request, { headers: { Cookie: 'Experiment=one' } });
    const password = requestContext('https://example.com/archives/1/?password=secret');
    const unknown = requestContext('https://example.com/?feature=one');
    const authorization = requestContext();
    authorization.request = new Request(authorization.request, { headers: { Authorization: 'Bearer secret' } });
    const noStore = requestContext();
    noStore.request = new Request(noStore.request, { headers: { 'Cache-Control': 'no-store' } });

    const ordinaryResponse = await earlyRequestProvider.handle(ordinaryCookie, next);
    expect(ordinaryResponse.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect((await earlyRequestProvider.handle(caseVariantCookie, next)).headers.get('X-Typecho-Cache')).toBe('L1');

    const passwordResponse = await earlyRequestProvider.handle(password, next);
    expect(passwordResponse.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(passwordResponse.headers.get(CACHE_BYPASS_REASON_HEADER)).toBe('unsafe-query');

    const unknownResponse = await earlyRequestProvider.handle(unknown, next);
    expect(unknownResponse.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(unknownResponse.headers.get(CACHE_BYPASS_REASON_HEADER)).toBe('unsafe-query');

    const authorizationResponse = await earlyRequestProvider.handle(authorization, next);
    expect(authorizationResponse.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(authorizationResponse.headers.get(CACHE_BYPASS_REASON_HEADER)).toBe('authorization');

    const noStoreResponse = await earlyRequestProvider.handle(noStore, next);
    expect(noStoreResponse.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(noStoreResponse.headers.get(CACHE_BYPASS_REASON_HEADER)).toBe('cache-control');

    expect(next).toHaveBeenCalledTimes(5);
  });

  it('treats request no-cache as read-only so warm pages still hit', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>public</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    await earlyRequestProvider.handle(requestContext(), next);

    const hardRefresh = requestContext();
    hardRefresh.request = new Request(hardRefresh.request, { headers: { 'Cache-Control': 'no-cache' } });
    const hit = await earlyRequestProvider.handle(hardRefresh, next);
    expect(hit.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(hit.headers.get(CACHE_BYPASS_REASON_HEADER)).toBeNull();
    expect(next).toHaveBeenCalledOnce();

    await earlyRequestProvider.invalidate!({ reason: 'test', domains: ['all'] });
    const cold = await earlyRequestProvider.handle(hardRefresh, next);
    expect(cold.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(cold.headers.get(CACHE_BYPASS_REASON_HEADER)).toBe('cache-control');
  });

  it('strips common tracking query params so they share the public cache key', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>tracked</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const miss = await earlyRequestProvider.handle(
      requestContext('https://example.com/?from=rss&utm_source=newsletter&ref=home'),
      next,
    );
    expect(miss.headers.get('X-Typecho-Cache')).toBe('MISS');
    const hit = await earlyRequestProvider.handle(requestContext('https://example.com/'), next);
    expect(hit.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('lets an authenticated cold request populate the shared public page cache', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const publicNext = vi.fn(async () => new Response('<html>public</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    await earlyRequestProvider.handle(requestContext(), publicNext);

    const authenticatedHit = requestContext();
    authenticatedHit.request = new Request(authenticatedHit.request, {
      headers: { Cookie: '__typecho_uid=1; __typecho_authCode=token' },
    });
    const hit = await earlyRequestProvider.handle(authenticatedHit, publicNext);
    expect(hit.headers.get('X-Typecho-Cache')).toBe('L1');

    await earlyRequestProvider.invalidate!({ reason: 'test', domains: ['all'] });
    const authenticatedNext = vi.fn(async () => new Response('<html>public after login</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const miss = await earlyRequestProvider.handle(authenticatedHit, authenticatedNext);
    expect(miss.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(await miss.text()).toContain('public after login');

    const anonymous = await earlyRequestProvider.handle(requestContext(), publicNext);
    expect(anonymous.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(await anonymous.text()).toContain('public after login');
    expect(authenticatedNext).toHaveBeenCalledOnce();
    expect(publicNext).toHaveBeenCalledOnce();
  });

  it('treats publish-time warm-up requests as read-write despite no-cache', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const warmupNext = vi.fn(async () => new Response('<html>warmed</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const warmup = requestContext();
    warmup.request = new Request(warmup.request, {
      headers: { 'Cache-Control': 'no-cache', 'X-Typecho-Cache-Warmup': '1' },
    });
    const miss = await earlyRequestProvider.handle(warmup, warmupNext);
    expect(miss.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(warmupNext).toHaveBeenCalledOnce();

    // Plain no-cache requests may read the warmed entry (read-only) but do not write.
    const plainNoCache = requestContext();
    plainNoCache.request = new Request(plainNoCache.request, { headers: { 'Cache-Control': 'no-cache' } });
    const hit = await earlyRequestProvider.handle(plainNoCache, warmupNext);
    expect(hit.headers.get('X-Typecho-Cache')).toBe('L1');

    // The warmed entry is shared: an anonymous visitor gets it from L1.
    const anonymous = await earlyRequestProvider.handle(requestContext(), warmupNext);
    expect(anonymous.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(await anonymous.text()).toContain('warmed');
  });

  it('memoizes URL hashes across repeat hits', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>memo hash</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const url = 'https://example.com/archives/42/';
    const first = await earlyRequestProvider.handle(requestContext(url), next);
    expect(first.headers.get('X-Typecho-Cache')).toBe('MISS');

    const digestSpy = vi.spyOn(crypto.subtle, 'digest');
    try {
      await earlyRequestProvider.handle(requestContext(url), next);
      await earlyRequestProvider.handle(requestContext(url), next);
      expect(digestSpy).not.toHaveBeenCalled();
    } finally {
      digestSpy.mockRestore();
    }

    // Resetting the provider memo re-hashes on the next request.
    resetCacheProviderForTests();
    const digestSpyAfterReset = vi.spyOn(crypto.subtle, 'digest');
    try {
      await earlyRequestProvider.handle(requestContext(url), next);
      expect(digestSpyAfterReset).toHaveBeenCalledTimes(1);
    } finally {
      digestSpyAfterReset.mockRestore();
    }
  });

  it('does not cache an unmarked response from a non-public theme', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>private theme</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    const response = await earlyRequestProvider.handle(requestContext(), next);

    expect(response.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);
  });

  it('serves an authenticated request from L2 after the local L1 is cold', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>public</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    await earlyRequestProvider.handle(requestContext(), next);
    _resetCaches();

    const authenticated = requestContext();
    authenticated.request = new Request(authenticated.request, {
      headers: { Cookie: '__typecho_uid=1; __typecho_authCode=token' },
    });
    const response = await earlyRequestProvider.handle(authenticated, next);
    expect(response.headers.get('X-Typecho-Cache')).toBe('L2');
    expect(next).toHaveBeenCalledOnce();
  });

  it('coalesces authenticated and anonymous cold requests into one public render', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    let releaseRender!: () => void;
    const renderGate = new Promise<void>(resolve => { releaseRender = resolve; });
    let markRenderStarted!: () => void;
    const renderStarted = new Promise<void>(resolve => { markRenderStarted = resolve; });
    const authenticated = requestContext();
    authenticated.request = new Request(authenticated.request, {
      headers: { Cookie: '__typecho_uid=1; __typecho_authCode=token' },
    });
    const authenticatedNext = vi.fn(async () => {
      markRenderStarted();
      await renderGate;
      return new Response('<html>public from login</html>', { headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' } });
    });
    const publicNext = vi.fn(async () => new Response('<html>public</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));

    const authenticatedResponsePromise = earlyRequestProvider.handle(authenticated, authenticatedNext);
    await renderStarted;
    const publicResponsePromise = earlyRequestProvider.handle(requestContext(), publicNext);
    releaseRender();
    const [authenticatedResponse, publicResponse] = await Promise.all([
      authenticatedResponsePromise,
      publicResponsePromise,
    ]);

    expect(['MISS', 'L1']).toContain(publicResponse.headers.get('X-Typecho-Cache'));
    expect(await publicResponse.text()).toContain('public from login');
    expect(authenticatedResponse.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(await authenticatedResponse.text()).toContain('public from login');
    expect(authenticatedNext).toHaveBeenCalledOnce();
    expect(publicNext).not.toHaveBeenCalled();
  });

  it('stores a marked Warm response from a sensitive cookie request', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const context = requestContext('https://example.com/archives/1/');
    context.request = new Request(context.request, {
      headers: { Cookie: '__typecho_uid=1; __typecho_authCode=token' },
    });
    const next = vi.fn(async () => new Response('<html>warm public</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));

    const response = await earlyRequestProvider.handle(context, next);

    expect(response.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(response.headers.has(PUBLIC_HTML_HEADER)).toBe(false);
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(true);
    expect(await response.text()).toContain('warm public');
  });

  it('treats an unapproved-comment cookie as read-only on a cold cache', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const context = requestContext('https://example.com/archives/1/');
    context.request = new Request(context.request, {
      headers: { Cookie: '__typecho_unapproved_comment=private-token' },
    });
    // The theme marks the page as public HTML, so a cacheable response is
    // produced. It must still never be stored: the submitter's pending
    // comment would otherwise leak to visitors without the cookie.
    const privateNext = vi.fn(async () => new Response('<html>waiting comment</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const response = await earlyRequestProvider.handle(context, privateNext);
    expect(response.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(response.headers.has('Cloudflare-CDN-Cache-Control')).toBe(false);
    expect(response.headers.has('Cache-Tag')).toBe(false);
    expect(await response.text()).toContain('waiting comment');
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);

    const publicNext = vi.fn(async () => new Response('<html>public</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const anonymous = await earlyRequestProvider.handle(requestContext('https://example.com/archives/1/'), publicNext);
    expect(anonymous.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(await anonymous.text()).toContain('public');
  });

  it('stores and reloads each shared data domain from KV for seven days', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });

    for (const domain of ['options', 'navigation', 'sidebar', 'metas'] as const) {
      const d1Read = vi.fn(async () => ({ domain, source: 'd1' }));
      await loadEarlyRequestSharedData(domain, 'stable-key', d1Read);
      expect(d1Read).toHaveBeenCalledOnce();

      resetEarlyRequestProvidersForTests();
      resetCacheProviderForTests();
      registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
      const unexpectedD1Read = vi.fn(async () => ({ domain, source: 'unexpected' }));
      const fromKv = await loadEarlyRequestSharedData(domain, 'stable-key', unexpectedD1Read);
      expect(fromKv).toEqual({ domain, source: 'd1' });
      expect(unexpectedD1Read).not.toHaveBeenCalled();
    }

    const sharedKeys = [...kv.store.keys()].filter(key => key.includes(':s:'));
    expect(sharedKeys).toHaveLength(4);
    for (const key of sharedKeys) {
      expect(kv.putOptions.get(key)?.expirationTtl).toBe(604_800);
    }
  });

  it('stores public comment projections for seven days', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });

    await loadEarlyRequestSharedData('comments', 'cid:42:page:1', async () => ({ comments: [] }));

    const entry = [...kv.putOptions.entries()].find(([key]) => key.includes(':s:comments:'));
    expect(entry?.[1]?.expirationTtl).toBe(604_800);
  });

  it('reports query cache source without exposing the cache key', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });

    const missTrace = createSharedCacheTrace();
    await loadEarlyRequestSharedData(
      'comments',
      'private-query-key-auth-code',
      async () => ({ source: 'd1' }),
      missTrace,
    );
    expect(formatSharedCacheTrace(missTrace)).toBe('comments=MISS');
    expect(formatSharedCacheTrace(missTrace)).not.toContain('private-query-key-auth-code');

    const kvTrace = createSharedCacheTrace();
    await loadEarlyRequestSharedData(
      'comments',
      'private-query-key-auth-code',
      async () => ({ source: 'unexpected' }),
      kvTrace,
    );
    expect(formatSharedCacheTrace(kvTrace)).toBe('comments=KV');

    await earlyRequestProvider.lifecycle!({
      type: 'config',
      settings: { ...defaultSettings, frontendDataCacheBackend: 'none' },
      options: { siteUrl: 'https://example.com' },
    });
    const bypassTrace = createSharedCacheTrace();
    await loadEarlyRequestSharedData(
      'comments',
      'uncached-query',
      async () => ({ source: 'd1' }),
      bypassTrace,
    );
    expect(formatSharedCacheTrace(bypassTrace)).toBe('comments=BYPASS');
  });

  it('reports a D1 query-cache hit separately from a page L3 hit', async () => {
    const d1 = new MemoryD1();
    env.DB = d1 as any;
    await earlyRequestProvider.sync!({
      request: new Request('https://example.com/'),
      active: true,
      options: {
        [`plugin:${CACHE_PLUGIN_ID}`]: JSON.stringify({
          ...defaultSettings,
          frontendDataCacheBackend: 'd1',
        }),
      },
    });
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });

    const firstTrace = createSharedCacheTrace();
    await loadEarlyRequestSharedData(
      'comments',
      'd1-query-key',
      async () => ({ source: 'd1-origin' }),
      firstTrace,
    );
    expect(formatSharedCacheTrace(firstTrace)).toBe('comments=MISS');

    resetEarlyRequestProvidersForTests();
    resetCacheProviderForTests();
    await earlyRequestProvider.sync!({
      request: new Request('https://example.com/'),
      active: true,
      options: {
        [`plugin:${CACHE_PLUGIN_ID}`]: JSON.stringify({
          ...defaultSettings,
          frontendDataCacheBackend: 'd1',
        }),
      },
    });
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const d1Trace = createSharedCacheTrace();
    await loadEarlyRequestSharedData(
      'comments',
      'd1-query-key',
      async () => ({ source: 'unexpected' }),
      d1Trace,
    );
    expect(formatSharedCacheTrace(d1Trace)).toBe('comments=D1');
  });

  it('isolates viewer query values and stores authenticated entries for seven days', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const db = {};
    const viewer = (uid: number, group: string, authCode: string) => ({
      db,
      isLoggedIn: true,
      user: { uid, group, authCode },
    } as any);

    expect(await loadQueryCache(viewer(1, 'administrator', 'session-a'), {
      domain: 'notes', scope: 'viewer', key: { page: 1 },
    }, async () => ({ value: 'first' }))).toEqual({ value: 'first' });
    expect(await loadQueryCache(viewer(2, 'administrator', 'session-b'), {
      domain: 'notes', scope: 'viewer', key: { page: 1 },
    }, async () => ({ value: 'second' }))).toEqual({ value: 'second' });
    expect(await loadQueryCache(viewer(1, 'editor', 'session-a'), {
      domain: 'notes', scope: 'viewer', key: { page: 1 },
    }, async () => ({ value: 'role-changed' }))).toEqual({ value: 'role-changed' });
    expect(await loadQueryCache(viewer(1, 'administrator', 'session-c'), {
      domain: 'notes', scope: 'viewer', key: { page: 1 },
    }, async () => ({ value: 'rotated' }))).toEqual({ value: 'rotated' });

    const entries = [...kv.putOptions.entries()].filter(([key]) => key.includes(':s:notes:'));
    expect(entries).toHaveLength(4);
    expect(entries.every(([, options]) => options?.expirationTtl === 604_800)).toBe(true);
    expect(entries.some(([key]) => key.includes('session-a') || key.includes(':1:'))).toBe(false);
  });

  it('uses D1 query storage without a KV binding and advances its own generation', async () => {
    const d1 = new MemoryD1();
    env.DB = d1 as any;
    env.TYPECHO_CACHE = null as any;
    const settings = {
      ...defaultSettings,
      adminDataCacheBackend: 'd1',
    };
    const request = new Request('https://example.com/admin');
    await earlyRequestProvider.sync!({
      request,
      active: true,
      options: { [`plugin:${CACHE_PLUGIN_ID}`]: JSON.stringify(settings) },
    });
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const context = {
      db: {},
      isLoggedIn: true,
      user: { uid: 7, group: 'administrator', authCode: 'auth-code' },
    } as any;
    const firstLoader = vi.fn(async () => ({ count: 1 }));
    expect(await loadQueryCache(context, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, firstLoader)).toEqual({ count: 1 });
    expect(firstLoader).toHaveBeenCalledOnce();
    expect([...d1.rows.keys()].some(key => key.startsWith('typecho:edge-cache:v2:d:admin-dashboard:'))).toBe(true);
    expect([...d1.rows.keys()].some(key => key.startsWith('typecho:edge-cache:v1:p:'))).toBe(false);

    resetEarlyRequestProvidersForTests();
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const cachedLoader = vi.fn(async () => ({ count: 2 }));
    expect(await loadQueryCache(context, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, cachedLoader)).toEqual({ count: 1 });
    expect(cachedLoader).not.toHaveBeenCalled();

    await notifyEarlyRequestInvalidation({
      reason: 'dashboard-write', domains: [], sharedDomains: ['admin-dashboard'],
    });
    const refreshedLoader = vi.fn(async () => ({ count: 3 }));
    expect(await loadQueryCache(context, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, refreshedLoader)).toEqual({ count: 3 });
    expect(refreshedLoader).toHaveBeenCalledOnce();
  });

  it('routes frontend query data to its selected D1 backend', async () => {
    const d1 = new MemoryD1();
    env.DB = d1 as any;
    await earlyRequestProvider.sync!({
      request: new Request('https://example.com/'),
      active: true,
      options: {
        [`plugin:${CACHE_PLUGIN_ID}`]: JSON.stringify({
          ...defaultSettings,
          frontendDataCacheBackend: 'd1',
        }),
      },
    });
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const loader = vi.fn(async () => ({ entries: [] }));
    expect(await loadQueryCache({ db: {}, isLoggedIn: false } as any, {
      domain: 'archive', key: { page: 1 },
    }, loader)).toEqual({ entries: [] });
    expect(loader).toHaveBeenCalledOnce();
    expect([...d1.rows.keys()].some(key => key.startsWith('typecho:edge-cache:v2:d:archive:'))).toBe(true);
  });

  it('invalidates both data stores and L0 when a data backend is switched', async () => {
    const kv = new MemoryKv();
    const d1 = new MemoryD1();
    env.DB = d1 as any;
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const context = {
      db: {},
      isLoggedIn: true,
      user: { uid: 8, group: 'administrator', authCode: 'switch-auth' },
    } as any;
    expect(await loadQueryCache(context, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, async () => ({ backend: 'kv' }))).toEqual({ backend: 'kv' });
    expect([...kv.store.keys()].some(key => key.includes(':s:admin-dashboard:'))).toBe(true);

    await earlyRequestProvider.lifecycle!({
      type: 'config',
      settings: {
        ...defaultSettings,
        adminDataCacheBackend: 'd1',
      },
      options: { siteUrl: 'https://example.com' },
    });

    const loader = vi.fn(async () => ({ backend: 'd1' }));
    expect(await loadQueryCache(context, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, loader)).toEqual({ backend: 'd1' });
    expect(loader).toHaveBeenCalledOnce();
    expect([...d1.rows.keys()].some(key => key.startsWith('typecho:edge-cache:v2:d:admin-dashboard:'))).toBe(true);
    expect([...d1.rows.keys()].some(key => key.startsWith('typecho:edge-cache:v2:dg:admin-dashboard'))).toBe(true);
  });

  it('keeps D1 page L3 rows separate from D1 query rows', async () => {
    const kv = new MemoryKv();
    const d1 = new MemoryD1();
    env.DB = d1 as any;
    await activate(kv, {
      ...defaultSettings,
      l1Ttl: '0',
      l2Ttl: '0',
      l3Ttl: '300',
      adminDataCacheBackend: 'd1',
    });
    await earlyRequestProvider.handle(requestContext('https://example.com/archives/44/', d1), async () =>
      new Response('<html>page L3</html>', { headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' } }),
    );
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    await loadQueryCache({
      db: {},
      isLoggedIn: true,
      user: { uid: 9, group: 'administrator', authCode: 'l3-query' },
    } as any, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, async () => ({ value: 'query' }));

    expect([...d1.rows.keys()].some(key => key.startsWith('typecho:edge-cache:v1:p:'))).toBe(true);
    expect([...d1.rows.keys()].some(key => key.startsWith('typecho:edge-cache:v2:d:admin-dashboard:'))).toBe(true);
  });

  it('rejects viewer caching before an unverified context can reach KV', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    await expect(loadQueryCache({
      db: {},
      isLoggedIn: false,
      user: { uid: 1, group: 'administrator', authCode: 'forged' },
    } as any, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, async () => ({ value: 'forged' }))).rejects.toThrow('validated user');
    expect([...kv.store.keys()].some(key => key.includes(':s:admin-dashboard:'))).toBe(false);
  });

  it('configures frontend and admin data backends separately while accepting legacy settings', () => {
    const settings = normalizeCacheConfig({
      frontendDataCacheBackend: 'd1',
      adminDataCacheBackend: 'kv',
    });
    expect(settings.frontendDataCacheBackend).toBe('d1');
    expect(settings.adminDataCacheBackend).toBe('kv');
    expect(normalizeCacheConfig({}).frontendDataCacheBackend).toBe('kv');
    expect(normalizeCacheConfig({}).adminDataCacheBackend).toBe('kv');
    expect(normalizeCacheConfig({ frontendDataCacheBackend: 'none' }).frontendDataCacheBackend).toBe('none');
    expect(normalizeCacheConfig({ adminDataCacheBackend: 'none' }).adminDataCacheBackend).toBe('none');

    const legacy = normalizeCacheConfig({
      dataCacheBackends: [{ domain: 'admin-dashboard', backend: 'd1' }],
    });
    expect(legacy.legacyDataCacheBackends).toEqual([{ domain: 'admin-dashboard', backend: 'd1' }]);
    expect(() => normalizeCacheConfig({ dataCacheBackends: [
      { domain: 'notes', backend: 'kv' },
      { domain: 'notes', backend: 'd1' },
    ] })).toThrow('不能重复');
    expect(() => normalizeCacheConfig({ dataCacheBackends: [
      { domain: 'unknown', backend: 'kv' },
    ] })).toThrow('缓存域无效');
    expect(() => normalizeCacheConfig({ frontendDataCacheBackend: 'unknown' }))
      .toThrow('前台数据缓存后端无效');
  });

  it('does not cache a data group configured as uncached', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, adminDataCacheBackend: 'none' });
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const context = {
      db: {},
      isLoggedIn: true,
      user: { uid: 11, group: 'administrator', authCode: 'none-backend' },
    } as any;
    const firstLoader = vi.fn(async () => ({ value: 'fresh' }));
    expect(await loadQueryCache(context, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, firstLoader)).toEqual({ value: 'fresh' });
    const secondLoader = vi.fn(async () => ({ value: 'reloaded' }));
    expect(await loadQueryCache(context, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, secondLoader)).toEqual({ value: 'reloaded' });
    expect(firstLoader).toHaveBeenCalledOnce();
    expect(secondLoader).toHaveBeenCalledOnce();
    expect([...kv.store.keys()].some(key => key.includes(':s:admin-dashboard:'))).toBe(false);
  });

  it('advances only the requested shared-data generation', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const firstSidebarRead = vi.fn(async () => ({ value: 1 }));
    const firstOptionsRead = vi.fn(async () => ({ value: 1 }));
    await loadEarlyRequestSharedData('sidebar', 'shared', firstSidebarRead);
    await loadEarlyRequestSharedData('options', 'shared', firstOptionsRead);

    await notifyEarlyRequestInvalidation({
      reason: 'comment-visible',
      domains: [],
      sharedDomains: ['sidebar'],
    });
    const refreshedSidebar = vi.fn(async () => ({ value: 2 }));
    const unexpectedOptionsRead = vi.fn(async () => ({ value: 2 }));
    expect(await loadEarlyRequestSharedData('sidebar', 'shared', refreshedSidebar)).toEqual({ value: 2 });
    expect(await loadEarlyRequestSharedData('options', 'shared', unexpectedOptionsRead)).toEqual({ value: 1 });
    expect(refreshedSidebar).toHaveBeenCalledOnce();
    expect(unexpectedOptionsRead).not.toHaveBeenCalled();
  });

  it('does not repopulate a query cache when an in-flight read finishes after invalidation', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const context = {
      db: {},
      isLoggedIn: true,
      user: { uid: 10, group: 'administrator', authCode: 'concurrent-auth' },
    } as any;
    let startLoader!: () => void;
    let releaseLoader!: () => void;
    const started = new Promise<void>(resolve => { startLoader = resolve; });
    const release = new Promise<void>(resolve => { releaseLoader = resolve; });
    const staleLoader = vi.fn(async () => {
      startLoader();
      await release;
      return { value: 'stale' };
    });

    const staleRequest = loadQueryCache(context, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, staleLoader);
    await started;
    await notifyEarlyRequestInvalidation({
      reason: 'dashboard-write', domains: [], sharedDomains: ['admin-dashboard'],
    });
    releaseLoader();
    expect(await staleRequest).toEqual({ value: 'stale' });

    const freshLoader = vi.fn(async () => ({ value: 'fresh' }));
    expect(await loadQueryCache(context, {
      domain: 'admin-dashboard', scope: 'viewer', key: { view: 'dashboard' },
    }, freshLoader)).toEqual({ value: 'fresh' });
    expect(freshLoader).toHaveBeenCalledOnce();
  });

  it('fails open to the shared-data fallback when KV reads fail or the binding is missing', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    kv.failGet = true;
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const failedKvFallback = vi.fn(async () => ({ source: 'd1' }));
    expect(await loadEarlyRequestSharedData('options', 'failed-kv', failedKvFallback))
      .toEqual({ source: 'd1' });
    expect(failedKvFallback).toHaveBeenCalledOnce();

    resetEarlyRequestProvidersForTests();
    resetCacheProviderForTests();
    env.TYPECHO_CACHE = null as any;
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const missingKvFallback = vi.fn(async () => ({ source: 'd1-no-kv' }));
    expect(await loadEarlyRequestSharedData('sidebar', 'missing-kv', missingKvFallback))
      .toEqual({ source: 'd1-no-kv' });
    expect(missingKvFallback).toHaveBeenCalledOnce();
  });

  it('normalizes tracking parameters without multiplying cached variants', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>same</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    await earlyRequestProvider.handle(requestContext('https://example.com/?utm_source=a'), next);
    const response = await earlyRequestProvider.handle(requestContext('https://example.com/?utm_source=b'), next);
    expect(response.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not cache non-HTML, Set-Cookie, private, or oversized responses in KV', async () => {
    const scenarios = [
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
      new Response('<html>x</html>', { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'x=1' } }),
      new Response('<html>x</html>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private' } }),
      new Response(`<html>${'x'.repeat(5 * 1024 * 1024)}</html>`, { headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' } }),
    ];
    for (const original of scenarios) {
      const kv = new MemoryKv();
      await activate(kv);
      const next = vi.fn(async () => original.clone());
      const response = await earlyRequestProvider.handle(requestContext(), next);
      if (original.headers.get('Content-Type') === 'text/html' && original.headers.get(PUBLIC_HTML_HEADER) === '1' && !original.headers.has('Set-Cookie') && !original.headers.get('Cache-Control')) {
        expect(response.headers.get('X-Typecho-Cache')).toBe('MISS');
        expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);
      } else {
        expect(response.headers.get('X-Typecho-Cache')).toBe('BYPASS');
      }
      _resetCaches();
      resetCacheProviderForTests();
    }
  });

  it('preserves a non-HTML response own cache declaration when bypassing', async () => {
    // feed/sitemap/robots flow through the early-request provider but are not
    // plugin-cacheable (non-HTML). Their own s-maxage and platform header must
    // survive the BYPASS so the CDN / platform layer keeps caching them.
    const kv = new MemoryKv();
    await activate(kv);
    const feed = new Response('<rss></rss>', {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, s-maxage=1800',
        'Cloudflare-CDN-Cache-Control': 'public, max-age=1800',
      },
    });
    const next = vi.fn(async () => feed.clone());
    const response = await earlyRequestProvider.handle(requestContext('https://example.com/feed'), next);

    expect(response.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=1800');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=1800');
    expect(response.headers.has('Cache-Tag')).toBe(false);
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);
  });

  it('rebuilds a missing control document from the synced runtime config', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const context = requestContext();
    // Real request order: middleware syncs the activated plugin first, then
    // the early-request provider runs. The KV namespace has no control
    // document (e.g. namespace swapped), so the plugin must rebuild it.
    await earlyRequestProvider.sync!({
      request: context.request,
      active: true,
      options: {
        siteUrl: 'https://example.com',
        [`plugin:${CACHE_PLUGIN_ID}`]: JSON.stringify(defaultSettings),
      },
    });
    expect(kv.store.has(CACHE_CONTROL_KEY)).toBe(false);

    const next = vi.fn(async () => new Response('<html>rebuilt</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    }));
    const response = await earlyRequestProvider.handle(context, next);

    expect(response.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(kv.store.has(CACHE_CONTROL_KEY)).toBe(true);
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=604800');
    expect(await response.text()).toContain('rebuilt');

    // A later request (fresh Request object) reads the rebuilt control from KV.
    _resetCaches();
    const second = await earlyRequestProvider.handle(requestContext(), vi.fn(async () => new Response('<html>x</html>', {
      headers: { 'Content-Type': 'text/html', [PUBLIC_HTML_HEADER]: '1' },
    })));
    // L1 was reset above, so the L2 entry written by the first render serves.
    expect(['L1', 'L2']).toContain(second.headers.get('X-Typecho-Cache'));
  });

  it('does not rebuild the control document while the plugin is deactivated', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    await earlyRequestProvider.lifecycle!({ type: 'deactivate' });
    expect(kv.store.has(CACHE_CONTROL_KEY)).toBe(false);
    const context = requestContext();
    await earlyRequestProvider.sync!({ request: context.request, active: false, options: {} });

    const next = vi.fn(async () => new Response('<html>x</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    const response = await earlyRequestProvider.handle(context, next);
    // Deactivated plugin is fully hands-off: no cache header, no rebuild.
    expect(response.headers.get('X-Typecho-Cache')).toBeNull();
    expect(kv.store.has(CACHE_CONTROL_KEY)).toBe(false);
  });

  it('passes through a nested plugin-handled response instead of overriding with BYPASS', async () => {
    // A permalink rewrite re-runs the middleware chain: the render already
    // returned an inner plugin response (L1 hit with cache headers). The outer
    // pass must not override it with a BYPASS that drops the Cache-Tag.
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, l1Ttl: '86400' });
    const inner = new Response('<html>inner</html>', {
      headers: {
        'Content-Type': 'text/html',
        'X-Typecho-Cache': 'L1',
        'Cache-Control': 'public, max-age=0',
        'Cloudflare-CDN-Cache-Control': 'public, max-age=86400',
        'Cache-Tag': 'tc:all, tc:post',
      },
    });
    const next = vi.fn(async () => inner);
    const response = await earlyRequestProvider.handle(requestContext('https://example.com/2025/6053.html'), next);

    expect(response.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
    expect(response.headers.get('Cache-Tag')).toBe('tc:all, tc:post');
    expect(await response.text()).toContain('inner');
  });

  it('fails open when KV control lookup fails', async () => {
    const kv = new MemoryKv();
    kv.failGet = true;
    env.TYPECHO_CACHE = kv as any;
    const context = requestContext();
    const next = vi.fn(async () => {
      await earlyRequestProvider.sync!({
        request: context.request,
        active: true,
        options: {
          siteUrl: 'https://example.com',
          [`plugin:${CACHE_PLUGIN_ID}`]: JSON.stringify({
            ...defaultSettings,
            staticCdnUrl: 'https://cdn.example.com',
          }),
        },
      });
      return new Response('<img src="/fallback.jpg">', {
        headers: { 'Content-Type': 'text/html' },
      });
    });
    const response = await earlyRequestProvider.handle(context, next);
    expect(await response.text()).toContain('https://cdn.example.com/fallback.jpg');
    expect(response.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(next).toHaveBeenCalledOnce();
  });

  it('rewrites public HTML from D1 configuration when KV is not bound', async () => {
    const context = requestContext('http://localhost:4321/article');
    const settings = {
      ...defaultSettings,
      staticCdnUrl: 'https://cdn.example.com/assets',
      staticExtensions: 'jpg,jpeg,png,css,js,zip',
      avatarCdnUrl: 'https://avatar.example.com/avatar',
    };
    const next = vi.fn(async () => {
      await earlyRequestProvider.sync!({
        request: context.request,
        active: true,
        options: {
          siteUrl: 'http://localhost:4321',
          [`plugin:${CACHE_PLUGIN_ID}`]: JSON.stringify(settings),
        },
      });
      return new Response([
        '<img src="/usr/uploads/2026/08/avatar.jpeg">',
        '<img src="http://localhost:4321/usr/uploads/2026/08/avatar.jpeg">',
        '<img src="https://www.gravatar.com/avatar/hash?d=identicon&amp;s=40">',
      ].join(''), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });

    const response = await earlyRequestProvider.handle(context, next);
    const html = await response.text();

    expect(response.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(html.match(/https:\/\/cdn\.example\.com\/assets\/usr\/uploads\/2026\/08\/avatar\.jpeg/g))
      .toHaveLength(2);
    expect(html).toContain('https://avatar.example.com/avatar/hash?d=identicon&amp;s=40');
  });

  it('does not rewrite HTML when the plugin is inactive', async () => {
    const context = requestContext('https://example.com/article');
    const next = vi.fn(async () => {
      await earlyRequestProvider.sync!({
        request: context.request,
        active: false,
        options: {
          [`plugin:${CACHE_PLUGIN_ID}`]: JSON.stringify({
            ...defaultSettings,
            staticCdnUrl: 'https://cdn.example.com',
          }),
        },
      });
      return new Response('<img src="/original.jpg">', {
        headers: { 'Content-Type': 'text/html' },
      });
    });

    const response = await earlyRequestProvider.handle(context, next);
    expect(await response.text()).toContain('src="/original.jpg"');
    expect(response.headers.has('X-Typecho-Cache')).toBe(false);
  });

  it('never calls the D1 renderer twice after a cache miss has begun', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => {
      throw new Error('renderer failed');
    });

    await expect(earlyRequestProvider.handle(requestContext(), next)).rejects.toThrow('renderer failed');
    expect(next).toHaveBeenCalledOnce();
  });

  it('deactivation removes the control document and purges the platform cache', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const purgeSpy = vi.spyOn(platformCache, 'purge');
    expect(kv.store.has(CACHE_CONTROL_KEY)).toBe(true);
    await earlyRequestProvider.lifecycle!({ type: 'deactivate' });
    expect(kv.store.has(CACHE_CONTROL_KEY)).toBe(false);
    expect(purgeSpy).toHaveBeenCalledWith({ tags: ['tc:all'] });
  });

  it('purges the platform cache when the plugin configuration changes', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const purgeSpy = vi.spyOn(platformCache, 'purge');
    await earlyRequestProvider.lifecycle!({
      type: 'config',
      settings: { ...defaultSettings, l1Ttl: '86400' },
    });
    expect(purgeSpy).toHaveBeenCalledWith({ tags: ['tc:all'] });
  });
});

describe('cache domain classification', () => {
  it('recognizes custom post, page, and category permalink patterns', () => {
    const control = buildControlDocument(defaultSettings, {
      siteUrl: 'https://example.com',
      permalinkPattern: '/articles/{year}/{slug}/',
      pagePattern: '/pages/{slug}/',
      categoryPattern: '/topics/{slug}/',
    });

    expect(classifyCacheDomain('/articles/2026/hello/', control)).toBe('post');
    expect(classifyCacheDomain('/pages/about/', control)).toBe('page');
    expect(classifyCacheDomain('/topics/cloudflare/', control)).toBe('archive');
    expect(classifyCacheDomain('/topics/cloudflare/page/3/', control)).toBe('archive');
  });

  it('strips tracking params and rejects unsafe query keys', () => {
    expect(normalizeCacheUrl(new URL('https://example.com/?from=rss&utm_campaign=x'), 'home'))
      .toBe('https://example.com/');
    expect(normalizeCacheUrl(new URL('https://example.com/?ref=nav&source=share'), 'home'))
      .toBe('https://example.com/');
    expect(normalizeCacheUrl(new URL('https://example.com/?feature=one'), 'home')).toBeNull();
    expect(normalizeCacheUrl(new URL('https://example.com/archives/1/?password=x'), 'post')).toBeNull();
  });
});

describe('CDN rewriting', () => {
  it('normalizes the new L1 and L2 TTL options and ignores legacy fields', () => {
    for (const value of [0, 3_600, 43_200, 86_400, 259_200, 604_800, 2_592_000]) {
      expect(normalizeCacheConfig({ l1Ttl: value }).l1Ttl).toBe(value);
    }
    for (const value of [0, 86_400, 259_200, 604_800]) {
      expect(normalizeCacheConfig({ l2Ttl: String(value) }).l2Ttl).toBe(value);
    }
    for (const value of [0, 300, 3_600, 21_600, 43_200, 86_400]) {
      expect(normalizeCacheConfig({ l3Ttl: String(value) }).l3Ttl).toBe(value);
    }
    expect(normalizeCacheConfig({ l1Ttl: 0, l2Ttl: '0', l3Ttl: '0' })).toMatchObject({
      l1Ttl: 0,
      l2Ttl: 0,
      l3Ttl: 0,
    });
    const defaults = normalizeCacheConfig({ listTtl: 86_400, detailTtl: 86_400 });
    expect(defaults).toMatchObject({ l1Ttl: 604_800, l2Ttl: 259_200, l3Ttl: 21_600 });
    expect(defaults).not.toHaveProperty('listTtl');
    expect(defaults).not.toHaveProperty('detailTtl');
  });

  it('rewrites selected same-origin assets and Gravatar while preserving other URLs', () => {
    const config = normalizeCacheConfig({
      ...defaultSettings,
      staticCdnUrl: 'https://cdn.example.com/static',
      avatarCdnUrl: 'https://avatar.example.com',
    });
    expect(rewriteResourceUrl('/themes/site.CSS?v=1', config, 'https://example.com', 'https://example.com'))
      .toBe('https://cdn.example.com/static/themes/site.CSS?v=1');
    expect(rewriteResourceUrl('https://example.com/usr/uploads/a.jpg#x', config, 'https://example.com', 'https://example.com'))
      .toBe('https://cdn.example.com/static/usr/uploads/a.jpg#x');
    expect(rewriteResourceUrl('https://third.example/a.jpg', config, 'https://example.com', 'https://example.com'))
      .toBe('https://third.example/a.jpg');
    expect(rewriteResourceUrl('https://www.gravatar.com/avatar/hash?s=40', config, 'https://example.com', 'https://example.com'))
      .toBe('https://avatar.example.com/avatar/hash?s=40');
  });

  it('does not rewrite Astro and Vite development internals', () => {
    const config = normalizeCacheConfig({
      ...defaultSettings,
      staticCdnUrl: 'https://cdn.example.com',
    });
    for (const internalUrl of [
      '/@id/astro/runtime/client/dev-toolbar/entrypoint.js',
      '/@vite/client.js',
      '/__open-in-editor.js',
      '/node_modules/.vite/deps/client.js?v=1',
    ]) {
      expect(rewriteResourceUrl(internalUrl, config, 'https://example.com', 'https://example.com'))
        .toBe(internalUrl);
    }
    expect(rewriteResourceUrl(
      '/themes/typecho-theme-warm/style.css',
      config,
      'https://example.com',
      'https://example.com',
    )).toBe('https://cdn.example.com/themes/typecho-theme-warm/style.css');
  });

  it('joins Avatar CDN bases with exactly one avatar path segment', () => {
    for (const [avatarCdnUrl, expected] of [
      ['https://avatar.example.com', 'https://avatar.example.com/avatar/hash?s=40'],
      ['https://avatar.example.com/avatar', 'https://avatar.example.com/avatar/hash?s=40'],
      ['https://avatar.example.com/images/avatar/', 'https://avatar.example.com/images/avatar/hash?s=40'],
    ]) {
      const config = normalizeCacheConfig({ ...defaultSettings, avatarCdnUrl });
      expect(rewriteResourceUrl(
        'https://secure.gravatar.com/avatar/hash?s=40',
        config,
        'https://example.com',
        'https://example.com',
      )).toBe(expected);
    }
  });

  it('rewrites srcset and resource attributes without changing unrelated markup', () => {
    const config = normalizeCacheConfig({
      ...defaultSettings,
      staticCdnUrl: 'https://cdn.example.com',
    });
    const html = '<img src="/a.jpg" srcset="/a.jpg 1x, /a.png 2x"><a href="/file.zip">下载</a><p data-id="1">正文</p>';
    const rewritten = rewriteHtmlString(html, config, 'https://example.com', 'https://example.com');
    expect(rewritten).toContain('src="https://cdn.example.com/a.jpg"');
    expect(rewritten).toContain('srcset="https://cdn.example.com/a.jpg 1x, https://cdn.example.com/a.png 2x"');
    expect(rewritten).toContain('href="https://cdn.example.com/file.zip"');
    expect(rewritten).toContain('<p data-id="1">正文</p>');
  });

  it('preserves data URLs while rewriting other srcset candidates', () => {
    const config = normalizeCacheConfig({
      ...defaultSettings,
      staticCdnUrl: 'https://cdn.example.com',
    });
    const html = '<img srcset="data:image/png;base64,AAAA 1x, /a.png 2x">';
    const rewritten = rewriteHtmlString(html, config, 'https://example.com', 'https://example.com');
    expect(rewritten).toContain('data:image/png;base64,AAAA 1x');
    expect(rewritten).toContain('https://cdn.example.com/a.png 2x');
  });
});

describe('plugin registration and controls', () => {
  function collectHooks() {
    const hooks = new Map<string, (...args: any[]) => any>();
    init({
      pluginId: 'typecho-plugin-cache',
      HookPoints: {} as any,
      addHook: ((point: string, _id: string, handler: (...args: any[]) => any) => hooks.set(point, handler)) as any,
    } satisfies PluginInitContext);
    return hooks;
  }

  it('registers config, CSP, admin, action, and system hooks', () => {
    const hooks = collectHooks();
    for (const name of [
      'system:begin',
      'plugin:config:beforeSave',
      'csp:directives',
      'comment:avatarMap',
      'admin:page',
      'admin:footer',
      'plugin:typecho-plugin-cache:action:auth',
      'plugin:typecho-plugin-cache:action',
    ]) expect(hooks.has(name)).toBe(true);
  });

  it('injects a "缓存管理" nav item under the settings menu for administrators', () => {
    const hooks = collectHooks();
    const footer = hooks.get('admin:footer')!('', { user: { group: 'administrator' }, activeMenu: 'cache' });

    // 插入到「设置」组（导航第 4 个 li 的子菜单），菜单名「缓存管理」
    expect(footer).toContain('li:nth-child(4) > menu');
    expect(footer).toContain('/admin/plugin/cache');
    expect(footer).toContain('>缓存管理</a>');
    expect(footer).toContain('item.className="focus"');

    // 非管理员不注入
    const guest = hooks.get('admin:footer')!('', { user: { group: 'contributor' } });
    expect(guest).not.toContain('缓存管理');
  });

  it('rejects invalid CDN configuration and normalizes valid settings', () => {
    const hook = collectHooks().get('plugin:config:beforeSave')!;
    const rejected = hook({ success: true }, {
      pluginId: 'typecho-plugin-cache',
      settings: { ...defaultSettings, staticCdnUrl: 'javascript:alert(1)' },
    });
    expect(rejected).toMatchObject({ success: false });

    const accepted = hook({ success: true }, {
      pluginId: 'typecho-plugin-cache',
      settings: {
        ...defaultSettings,
        staticExtensions: '.JPG, png, bad/ext',
      },
    });
    expect(accepted).toMatchObject({ success: true });
    expect(accepted.settings.staticExtensions).toBe('jpg,png');
    expect(accepted.settings.bypassCookieNames).toBeUndefined();
    expect(accepted.settings.l2Ttl).toBe('259200');
    expect(accepted.settings.l3Ttl).toBe('21600');
    expect(accepted.settings.frontendDataCacheBackend).toBe('kv');
    expect(accepted.settings.adminDataCacheBackend).toBe('kv');
    expect(accepted.settings.listTtl).toBeUndefined();
    expect(accepted.settings.detailTtl).toBeUndefined();

    const migrated = hook({ success: true }, {
      pluginId: 'typecho-plugin-cache',
      settings: {
        ...defaultSettings,
        dataCacheBackends: [{ domain: 'admin-dashboard', backend: 'd1' }],
        bypassCookieNames: 'experiment',
      },
    });
    expect(migrated.settings.dataCacheBackends).toBeUndefined();
    expect(migrated.settings.bypassCookieNames).toBeUndefined();
    expect(migrated.settings.frontendDataCacheBackend).toBe('kv');
    expect(migrated.settings.adminDataCacheBackend).toBe('kv');

    const disabled = hook({ success: true }, {
      pluginId: 'typecho-plugin-cache',
      settings: { ...defaultSettings, l1Ttl: 0, l2Ttl: '0', l3Ttl: 0 },
    });
    expect(disabled.settings.l1Ttl).toBe('0');
    expect(disabled.settings.l2Ttl).toBe('0');
    expect(disabled.settings.l3Ttl).toBe('0');
  });

  it('renders binding status and performs a scoped manual invalidation', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const page = await hooks.get('admin:page')!('', { slug: 'cache', csrfToken: 'csrf' });
    expect(page).toContain('TYPECHO_CACHE 已连接');
    // 三模块平铺：快捷刷新 / 按需刷新 / 维护；状态徽章并入状态条
    expect(page).toContain('ec-status-line');
    expect(page).toContain('快捷刷新');
    expect(page).toContain('按需刷新');
    expect(page).toContain('>维护<');
    // 容器保持 Typecho 后台栅格类；不再限宽居中（内容铺满内容区）
    expect(page).toContain('<section id="edge-cache-app" class="col-mb-12">');
    expect(page).not.toContain('max-width:760px');
    expect(page).toContain('ec-scene-grid');
    expect(page).toContain('class="ec-module ec-action"');
    // 按需刷新：HTML 域 checkbox + 数据缓存组 checkbox
    expect(page).toContain('type="checkbox" value="home"');
    expect(page).toContain('data-cache-domain="home"');
    expect(page).toContain('data-cache-data="frontend"');
    expect(page).toContain('data-cache-data="admin"');
    expect(page).toContain('id="cache-refresh-btn"');
    // 快捷刷新场景按钮
    expect(page).toContain('id="ec-quick-frontend"');
    expect(page).toContain('id="ec-quick-admin"');
    expect(page).toContain('id="ec-quick-all"');
    expect(page).toContain('>前台立即更新</button>');
    // 维护区清理按钮
    expect(page).toContain('id="ec-compact-btn"');
    // disabled 状态下按钮文字保持白色可读
    expect(page).toContain('#cache-refresh-btn{color:#fff !important}');
    expect(page).toContain('<section id="edge-cache-app" class="col-mb-12">');
    // 未记录过手动刷新时状态条显示暂无记录
    expect(page).toContain('暂无记录');
    // 标题旁注入「设置」链接，指向插件配置页
    expect(page).toContain('typecho-page-title');
    expect(page).toContain('/admin/plugin-config?id=typecho-plugin-cache');
    expect(page).toContain("link.textContent='设置'");

    // 旧字段 domain 兼容
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domain: 'home' },
    });
    expect(result).toMatchObject({ handled: true, success: true });
    expect([...kv.store.keys()]).toContain('typecho:edge-cache:v1:g:home');
  });

  it('invalidates a batch of checked cache domains via the domains field', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const purgeSpy = vi.spyOn(platformCache, 'purge');
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domains: ['post', 'page', 'note'] },
    });
    expect(result).toMatchObject({ handled: true, success: true });
    expect([...kv.store.keys()]).toEqual(expect.arrayContaining([
      'typecho:edge-cache:v1:g:post',
      'typecho:edge-cache:v1:g:page',
      'typecho:edge-cache:v1:g:note',
    ]));
    expect([...kv.store.keys()]).not.toContain('typecho:edge-cache:v1:g:home');
    expect(purgeSpy).toHaveBeenCalledWith({ tags: ['tc:post', 'tc:page', 'tc:note'] });

    // 空数组退化为全量刷新
    const empty = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domains: [] },
    });
    expect(empty).toMatchObject({ handled: true, success: true });
    expect([...kv.store.keys()]).toContain('typecho:edge-cache:v1:g:all');
    expect(purgeSpy).toHaveBeenCalledWith({ tags: ['tc:all'] });

    // 非法域被拒绝
    const invalid = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domains: ['post', 'bogus'] },
    });
    expect(invalid).toMatchObject({ handled: true, success: false, error: '缓存域无效' });
    // 非法域不触发平台层清除
    expect(purgeSpy).toHaveBeenCalledTimes(2);
  });

  it('bumps only the publish-affected domains and leaves g:all alone', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const purgeSpy = vi.spyOn(platformCache, 'purge');
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domains: ['home', 'archive', 'other', 'post'] },
    });
    expect(result).toMatchObject({ handled: true, success: true });
    expect([...kv.store.keys()].filter((key) => key.startsWith('typecho:edge-cache:v1:g:'))).toEqual([
      'typecho:edge-cache:v1:g:home',
      'typecho:edge-cache:v1:g:archive',
      'typecho:edge-cache:v1:g:other',
      'typecho:edge-cache:v1:g:post',
    ]);
    expect([...kv.store.keys()]).not.toContain('typecho:edge-cache:v1:g:all');
    expect(purgeSpy).toHaveBeenCalledWith({ tags: ['tc:home', 'tc:archive', 'tc:other', 'tc:post'] });
  });

  it('invalidates all page and shared-data generations on a manual full refresh', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const purgeSpy = vi.spyOn(platformCache, 'purge');
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domain: 'all' },
    });
    expect(result).toMatchObject({ handled: true, success: true });
    expect([...kv.store.keys()]).toEqual(expect.arrayContaining([
      'typecho:edge-cache:v1:g:all',
      'typecho:edge-cache:v1:sg:options',
      'typecho:edge-cache:v1:sg:navigation',
      'typecho:edge-cache:v1:sg:sidebar',
      'typecho:edge-cache:v1:sg:metas',
    ]));
    expect(purgeSpy).toHaveBeenCalledWith({ tags: ['tc:all'] });
  });

  it('invalidates only the frontend data group, leaving HTML generations untouched', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const purgeSpy = vi.spyOn(platformCache, 'purge');
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domains: [], data: ['frontend'] },
    });
    expect(result).toMatchObject({
      handled: true,
      success: true,
      groups: { html: [], data: ['frontend'] },
    });
    const keys = [...kv.store.keys()];
    for (const domain of ['options', 'navigation', 'sidebar', 'metas', 'comments', 'notes', 'archive', 'content']) {
      expect(keys).toContain(`typecho:edge-cache:v1:sg:${domain}`);
    }
    expect(keys.some(key => key.startsWith('typecho:edge-cache:v1:sg:admin-'))).toBe(false);
    expect(keys.some(key => key.startsWith('typecho:edge-cache:v1:g:'))).toBe(false);
    expect(purgeSpy).not.toHaveBeenCalled();
    // 手动刷新会记录时间戳，供管理页状态条展示
    const stamp = kv.store.get(LAST_REFRESH_KEY);
    expect(stamp).toBeTruthy();
    expect(Number.isNaN(Date.parse(stamp!))).toBe(false);
  });

  it('invalidates only the admin data group', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { data: ['admin'] },
    });
    expect(result).toMatchObject({ handled: true, success: true, groups: { html: [], data: ['admin'] } });
    const keys = [...kv.store.keys()];
    for (const domain of ['admin-dashboard', 'admin-content', 'admin-comments', 'admin-metas', 'admin-media', 'admin-users', 'admin-options']) {
      expect(keys).toContain(`typecho:edge-cache:v1:sg:${domain}`);
    }
    expect(keys.some(key => key.startsWith('typecho:edge-cache:v1:sg:options'))).toBe(false);
    expect(keys.some(key => key.startsWith('typecho:edge-cache:v1:g:'))).toBe(false);
  });

  it('combines HTML domains with data groups in one refresh', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const purgeSpy = vi.spyOn(platformCache, 'purge');
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domains: ['home', 'post'], data: ['frontend', 'admin'] },
    });
    expect(result).toMatchObject({
      handled: true,
      success: true,
      groups: { html: ['home', 'post'], data: ['frontend', 'admin'] },
    });
    const keys = [...kv.store.keys()];
    expect(keys).toEqual(expect.arrayContaining([
      'typecho:edge-cache:v1:g:home',
      'typecho:edge-cache:v1:g:post',
      'typecho:edge-cache:v1:sg:options',
      'typecho:edge-cache:v1:sg:admin-content',
    ]));
    expect(keys).not.toContain('typecho:edge-cache:v1:g:all');
    expect(purgeSpy).toHaveBeenCalledWith({ tags: ['tc:home', 'tc:post'] });
  });

  it('expands the data group "all" to every shared domain', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domains: [], data: ['all'] },
    });
    expect(result).toMatchObject({ handled: true, success: true, groups: { html: [], data: ['all'] } });
    const sharedKeys = [...kv.store.keys()].filter(key => key.startsWith('typecho:edge-cache:v1:sg:'));
    expect(sharedKeys).toHaveLength(15);
  });

  it('rejects unknown data groups without side effects', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const purgeSpy = vi.spyOn(platformCache, 'purge');
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domains: ['home'], data: ['bogus'] },
    });
    expect(result).toMatchObject({ handled: true, success: false, error: '数据缓存组无效' });
    expect([...kv.store.keys()]).toEqual([]);
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it('reports a clear error when targeted data caches are disabled', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, frontendDataCacheBackend: 'none', adminDataCacheBackend: 'none' });
    const hooks = collectHooks();
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { data: ['frontend'] },
    });
    expect(result).toMatchObject({ handled: true, success: false, error: '缓存后端不可用或所选缓存组未启用' });
  });

  it('compacts expired D1 cache rows and reports the deleted count', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const d1 = new MemoryD1();
    env.DB = d1 as any;
    const now = Math.floor(Date.now() / 1000);
    d1.rows.set('typecho:edge-cache:v1:p:expired', { value: '"old"', expiresAt: now - 100 });
    d1.rows.set('typecho:edge-cache:v1:p:fresh', { value: '"new"', expiresAt: now + 3_600 });
    const hooks = collectHooks();
    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, { action: 'compact' });
    expect(result).toMatchObject({ handled: true, success: true, compacted: 1 });
    expect(d1.rows.has('typecho:edge-cache:v1:p:expired')).toBe(false);
    expect(d1.rows.has('typecho:edge-cache:v1:p:fresh')).toBe(true);

    // DB 不可用时优雅报错
    env.DB = null as any;
    const noDb = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, { action: 'compact' });
    expect(noDb).toMatchObject({ handled: true, success: false, error: 'DB 不可用' });
  });

  it('renders cache tier summary from the plugin config in the status bar', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const page = await hooks.get('admin:page')!('', {
      slug: 'cache',
      csrfToken: 'csrf',
      options: {
        siteUrl: 'https://example.com',
        'plugin:typecho-plugin-cache': JSON.stringify({
          ...defaultSettings,
          l1Ttl: '86400',
          l3Ttl: '300',
          frontendDataCacheBackend: 'd1',
          adminDataCacheBackend: 'none',
        }),
      },
    });
    expect(page).toContain('页面缓存 L1 1 天 / L2 3 天 / L3 5 分钟');
    expect(page).toContain('前台数据 D1');
    expect(page).toContain('后台数据 不缓存');
  });

  it('renders the last manual refresh timestamp after an invalidation', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const before = await hooks.get('admin:page')!('', { slug: 'cache', csrfToken: 'csrf' });
    expect(before).toContain('暂无记录');
    await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domain: 'all' },
    });
    const stamp = kv.store.get(LAST_REFRESH_KEY);
    expect(stamp).toBeTruthy();
    const after = await hooks.get('admin:page')!('', { slug: 'cache', csrfToken: 'csrf' });
    expect(after).not.toContain('暂无记录');
    expect(after).toContain(`data-ec-last-refresh="${stamp}"`);
  });

  it('injects configured CDN origins into CSP without a KV binding', async () => {
    env.TYPECHO_CACHE = null as any;
    const hooks = collectHooks();
    const settings = {
      ...defaultSettings,
      staticCdnUrl: 'https://cdn.example.com/assets',
      avatarCdnUrl: 'https://avatar.example.com',
    };
    await hooks.get('system:begin')!({
      options: {
        siteUrl: 'https://example.com',
        [`plugin:typecho-plugin-cache`]: JSON.stringify(settings),
      },
    });

    const directives = await hooks.get('csp:directives')!({
      'img-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'font-src': ["'self'"],
      'media-src': ["'self'"],
    });
    expect(directives['img-src']).toContain('https://cdn.example.com');
    expect(directives['img-src']).toContain('https://avatar.example.com');
    for (const name of ['script-src', 'style-src', 'font-src', 'media-src']) {
      expect(directives[name]).toContain('https://cdn.example.com');
    }
  });

  it('rewrites avatar URLs returned by the public comments API', () => {
    const hook = collectHooks().get('comment:avatarMap')!;
    const avatars = hook({
      1: 'https://www.gravatar.com/avatar/hash?d=identicon&s=40',
    }, {
      request: new Request('https://example.com/api/comments?cid=1'),
      options: {
        siteUrl: 'https://example.com',
        [`plugin:${CACHE_PLUGIN_ID}`]: JSON.stringify({
          ...defaultSettings,
          avatarCdnUrl: 'https://avatar.example.com/avatar',
        }),
      },
    });

    expect(avatars).toEqual({
      1: 'https://avatar.example.com/avatar/hash?d=identicon&s=40',
    });
  });

  it('does not let stale D1 options overwrite a newer KV control document', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, staticCdnUrl: 'https://new-cdn.example.com' });
    const before = kv.store.get(CACHE_CONTROL_KEY);
    const hooks = collectHooks();

    await hooks.get('system:begin')!({
      options: {
        siteUrl: 'https://example.com',
        [`plugin:typecho-plugin-cache`]: JSON.stringify({
          ...defaultSettings,
          staticCdnUrl: 'https://stale-cdn.example.com',
        }),
      },
    });

    expect(kv.store.get(CACHE_CONTROL_KEY)).toBe(before);
  });
});
