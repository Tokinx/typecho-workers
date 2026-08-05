import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { _resetCaches } from '../../../tests/__mocks__/cloudflare-workers';
import type { PluginInitContext } from 'typecho/plugin-sdk';
import init from './index';
import {
  loadEarlyRequestSharedData,
  notifyEarlyRequestInvalidation,
  registerEarlyRequestLoaders,
  resetEarlyRequestProvidersForTests,
} from '@/lib/early-request';
import {
  CACHE_CONTROL_KEY,
  CACHE_PLUGIN_ID,
  buildControlDocument,
  classifyCacheDomain,
  earlyRequestProvider,
  normalizeCacheConfig,
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

const defaultSettings = {
  cacheScopes: ['home', 'post', 'page', 'note', 'archive', 'other'],
  l1Ttl: '86400',
  l2Ttl: '604800',
  bypassCookieNames: '',
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

function requestContext(url = 'https://example.com/') {
  const request = new Request(url);
  return {
    request,
    url: new URL(url),
    env: { TYPECHO_CACHE: env.TYPECHO_CACHE },
  };
}

beforeEach(() => {
  _resetCaches();
  resetCacheProviderForTests();
  resetEarlyRequestProvidersForTests();
  env.TYPECHO_CACHE = null as any;
  vi.restoreAllMocks();
});

describe('typecho-plugin-cache provider', () => {
  it('serves a warm L1 response without running the D1 renderer again', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>first</html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));

    const first = await earlyRequestProvider.handle(requestContext(), next);
    const second = await earlyRequestProvider.handle(requestContext(), next);

    expect(first.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(second.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(await second.text()).toContain('first');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('serves L2 and refills L1 after the local edge cache is cold', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, l1Ttl: '259200' });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    await earlyRequestProvider.handle(requestContext('https://example.com/archives/1/'), next);
    _resetCaches();

    const response = await earlyRequestProvider.handle(requestContext('https://example.com/archives/1/'), next);
    expect(response.headers.get('X-Typecho-Cache')).toBe('L2');
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=259200');
    expect(await response.text()).toContain('from d1');
    expect(next).toHaveBeenCalledTimes(1);

    const refilled = await earlyRequestProvider.handle(requestContext('https://example.com/archives/1/'), next);
    expect(refilled.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(refilled.headers.get('Cache-Control')).toContain('s-maxage=259200');
  });

  it('disables L1 reads and writes while keeping L2 available', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, l1Ttl: '0', l2Ttl: '86400' });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html' },
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
      headers: { 'Content-Type': 'text/html' },
    }));

    const first = await earlyRequestProvider.handle(requestContext('https://example.com/archives/3/'), next);
    const second = await earlyRequestProvider.handle(requestContext('https://example.com/archives/3/'), next);

    expect(first.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(second.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(next).toHaveBeenCalledOnce();
    expect(kv.getKeys.some(key => key.includes(':p:'))).toBe(false);
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);
  });

  it('passes through D1 on every request when both cache layers are disabled', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, l1Ttl: 0, l2Ttl: 0 });
    const next = vi.fn(async () => new Response('<html>from d1</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));

    const first = await earlyRequestProvider.handle(requestContext('https://example.com/archives/4/'), next);
    const second = await earlyRequestProvider.handle(requestContext('https://example.com/archives/4/'), next);

    expect(first.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(second.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(first.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(second.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(next).toHaveBeenCalledTimes(2);
    expect(kv.getKeys.some(key => key.includes(':p:') || key.includes(':g:'))).toBe(false);
    expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);
  });

  it('advances a generation so the next request renders again', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    let render = 0;
    const next = vi.fn(async () => new Response(`<html>${++render}</html>`, {
      headers: { 'Content-Type': 'text/html' },
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
      return new Response('<html>coalesced</html>', { headers: { 'Content-Type': 'text/html' } });
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

  it('allows ordinary cookies but bypasses configured cookies and unsafe query variants', async () => {
    const kv = new MemoryKv();
    await activate(kv, { ...defaultSettings, bypassCookieNames: 'experiment' });
    const next = vi.fn(async () => new Response('<html>private variant</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    const ordinaryCookie = requestContext();
    ordinaryCookie.request = new Request(ordinaryCookie.request, { headers: { Cookie: 'theme=dark' } });
    const bypassCookie = requestContext();
    bypassCookie.request = new Request(bypassCookie.request, { headers: { Cookie: 'experiment=one' } });
    const caseVariantCookie = requestContext();
    caseVariantCookie.request = new Request(caseVariantCookie.request, { headers: { Cookie: 'Experiment=one' } });
    const password = requestContext('https://example.com/archives/1/?password=secret');
    const unknown = requestContext('https://example.com/?feature=one');
    const authorization = requestContext();
    authorization.request = new Request(authorization.request, { headers: { Authorization: 'Bearer secret' } });
    const noCache = requestContext();
    noCache.request = new Request(noCache.request, { headers: { 'Cache-Control': 'no-cache' } });

    const ordinaryResponse = await earlyRequestProvider.handle(ordinaryCookie, next);
    expect(ordinaryResponse.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect((await earlyRequestProvider.handle(caseVariantCookie, next)).headers.get('X-Typecho-Cache')).toBe('L1');
    for (const context of [bypassCookie, password, unknown, authorization, noCache]) {
      const response = await earlyRequestProvider.handle(context, next);
      expect(response.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    }
    expect(next).toHaveBeenCalledTimes(6);
  });

  it('serves authenticated cache hits but never stores authenticated misses', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const publicNext = vi.fn(async () => new Response('<html>public</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    await earlyRequestProvider.handle(requestContext(), publicNext);

    const authenticatedHit = requestContext();
    authenticatedHit.request = new Request(authenticatedHit.request, {
      headers: { Cookie: '__typecho_uid=1; __typecho_authCode=token' },
    });
    const hit = await earlyRequestProvider.handle(authenticatedHit, publicNext);
    expect(hit.headers.get('X-Typecho-Cache')).toBe('L1');

    await earlyRequestProvider.invalidate!({ reason: 'test', domains: ['all'] });
    const privateNext = vi.fn(async () => new Response('<html>private toolbar</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    const miss = await earlyRequestProvider.handle(authenticatedHit, privateNext);
    expect(miss.headers.get('X-Typecho-Cache')).toBe('BYPASS');

    const anonymous = await earlyRequestProvider.handle(requestContext(), publicNext);
    expect(anonymous.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(await anonymous.text()).toContain('public');
    expect(privateNext).toHaveBeenCalledOnce();
    expect(publicNext).toHaveBeenCalledTimes(2);
  });

  it('serves an authenticated request from L2 after the local L1 is cold', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>public</html>', {
      headers: { 'Content-Type': 'text/html' },
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

  it('does not let an authenticated miss enter the anonymous in-flight queue', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    let releasePrivate!: () => void;
    const privateGate = new Promise<void>(resolve => { releasePrivate = resolve; });
    const authenticated = requestContext();
    authenticated.request = new Request(authenticated.request, {
      headers: { Cookie: '__typecho_uid=1; __typecho_authCode=token' },
    });
    const privateNext = vi.fn(async () => {
      await privateGate;
      return new Response('<html>private toolbar</html>', { headers: { 'Content-Type': 'text/html' } });
    });
    const publicNext = vi.fn(async () => new Response('<html>public</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));

    const privateResponsePromise = earlyRequestProvider.handle(authenticated, privateNext);
    await Promise.resolve();
    const publicResponse = await earlyRequestProvider.handle(requestContext(), publicNext);
    releasePrivate();
    const privateResponse = await privateResponsePromise;

    expect(publicResponse.headers.get('X-Typecho-Cache')).toBe('MISS');
    expect(await publicResponse.text()).toContain('public');
    expect(privateResponse.headers.get('X-Typecho-Cache')).toBe('BYPASS');
    expect(await privateResponse.text()).toContain('private toolbar');
    expect(privateNext).toHaveBeenCalledOnce();
    expect(publicNext).toHaveBeenCalledOnce();
  });

  it('treats an unapproved-comment cookie as read-only on a cold cache', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const context = requestContext('https://example.com/archives/1/');
    context.request = new Request(context.request, {
      headers: { Cookie: '__typecho_unapproved_comment=private-token' },
    });
    const privateNext = vi.fn(async () => new Response('<html>waiting comment</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    const response = await earlyRequestProvider.handle(context, privateNext);
    expect(response.headers.get('X-Typecho-Cache')).toBe('BYPASS');

    const publicNext = vi.fn(async () => new Response('<html>public</html>', {
      headers: { 'Content-Type': 'text/html' },
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
      await loadEarlyRequestSharedData(domain, 'stable-key', d1Read, {});
      expect(d1Read).toHaveBeenCalledOnce();

      resetEarlyRequestProvidersForTests();
      resetCacheProviderForTests();
      registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
      const unexpectedD1Read = vi.fn(async () => ({ domain, source: 'unexpected' }));
      const fromKv = await loadEarlyRequestSharedData(domain, 'stable-key', unexpectedD1Read, {});
      expect(fromKv).toEqual({ domain, source: 'd1' });
      expect(unexpectedD1Read).not.toHaveBeenCalled();
    }

    const sharedKeys = [...kv.store.keys()].filter(key => key.includes(':s:'));
    expect(sharedKeys).toHaveLength(4);
    for (const key of sharedKeys) {
      expect(kv.putOptions.get(key)?.expirationTtl).toBe(604_800);
    }
  });

  it('stores public comment projections for at most one minute', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });

    await loadEarlyRequestSharedData('comments', 'cid:42:page:1', async () => ({ comments: [] }), {});

    const entry = [...kv.putOptions.entries()].find(([key]) => key.includes(':s:comments:'));
    expect(entry?.[1]?.expirationTtl).toBe(60);
  });

  it('advances only the requested shared-data generation', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const firstSidebarRead = vi.fn(async () => ({ value: 1 }));
    const firstOptionsRead = vi.fn(async () => ({ value: 1 }));
    await loadEarlyRequestSharedData('sidebar', 'shared', firstSidebarRead, {});
    await loadEarlyRequestSharedData('options', 'shared', firstOptionsRead, {});

    await notifyEarlyRequestInvalidation({
      reason: 'comment-visible',
      domains: [],
      sharedDomains: ['sidebar'],
    });
    const refreshedSidebar = vi.fn(async () => ({ value: 2 }));
    const unexpectedOptionsRead = vi.fn(async () => ({ value: 2 }));
    expect(await loadEarlyRequestSharedData('sidebar', 'shared', refreshedSidebar, {})).toEqual({ value: 2 });
    expect(await loadEarlyRequestSharedData('options', 'shared', unexpectedOptionsRead, {})).toEqual({ value: 1 });
    expect(refreshedSidebar).toHaveBeenCalledOnce();
    expect(unexpectedOptionsRead).not.toHaveBeenCalled();
  });

  it('fails open to the shared-data fallback when KV reads fail or the binding is missing', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    kv.failGet = true;
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const failedKvFallback = vi.fn(async () => ({ source: 'd1' }));
    expect(await loadEarlyRequestSharedData('options', 'failed-kv', failedKvFallback, {}))
      .toEqual({ source: 'd1' });
    expect(failedKvFallback).toHaveBeenCalledOnce();

    resetEarlyRequestProvidersForTests();
    resetCacheProviderForTests();
    env.TYPECHO_CACHE = null as any;
    registerEarlyRequestLoaders({ [CACHE_PLUGIN_ID]: async () => earlyRequestProvider });
    const missingKvFallback = vi.fn(async () => ({ source: 'd1-no-kv' }));
    expect(await loadEarlyRequestSharedData('sidebar', 'missing-kv', missingKvFallback, {}))
      .toEqual({ source: 'd1-no-kv' });
    expect(missingKvFallback).toHaveBeenCalledOnce();
  });

  it('normalizes tracking parameters without multiplying cached variants', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    const next = vi.fn(async () => new Response('<html>same</html>', {
      headers: { 'Content-Type': 'text/html' },
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
      new Response(`<html>${'x'.repeat(5 * 1024 * 1024)}</html>`, { headers: { 'Content-Type': 'text/html' } }),
    ];
    for (const original of scenarios) {
      const kv = new MemoryKv();
      await activate(kv);
      const next = vi.fn(async () => original.clone());
      const response = await earlyRequestProvider.handle(requestContext(), next);
      if (original.headers.get('Content-Type') === 'text/html' && !original.headers.has('Set-Cookie') && !original.headers.get('Cache-Control')) {
        expect(response.headers.get('X-Typecho-Cache')).toBe('MISS');
        expect([...kv.store.keys()].some(key => key.includes(':p:'))).toBe(false);
      } else {
        expect(response.headers.get('X-Typecho-Cache')).toBe('BYPASS');
      }
      _resetCaches();
      resetCacheProviderForTests();
    }
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

  it('deactivation removes the control document', async () => {
    const kv = new MemoryKv();
    await activate(kv);
    expect(kv.store.has(CACHE_CONTROL_KEY)).toBe(true);
    await earlyRequestProvider.lifecycle!({ type: 'deactivate' });
    expect(kv.store.has(CACHE_CONTROL_KEY)).toBe(false);
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
});

describe('CDN rewriting', () => {
  it('normalizes the new L1 and L2 TTL options and ignores legacy fields', () => {
    for (const value of [0, 3_600, 43_200, 86_400, 259_200, 604_800, 2_592_000]) {
      expect(normalizeCacheConfig({ l1Ttl: value }).l1Ttl).toBe(value);
    }
    for (const value of [0, 86_400, 259_200, 604_800]) {
      expect(normalizeCacheConfig({ l2Ttl: String(value) }).l2Ttl).toBe(value);
    }
    expect(normalizeCacheConfig({ l1Ttl: 0, l2Ttl: '0' })).toMatchObject({
      l1Ttl: 0,
      l2Ttl: 0,
      bypassCookieNames: [],
    });
    const defaults = normalizeCacheConfig({ listTtl: 86_400, detailTtl: 86_400 });
    expect(defaults).toMatchObject({ l1Ttl: 86_400, l2Ttl: 604_800 });
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
        bypassCookieNames: 'analytics_id,\nThemePreference, invalid name',
      },
    });
    expect(accepted).toMatchObject({ success: true });
    expect(accepted.settings.staticExtensions).toBe('jpg,png');
    expect(accepted.settings.bypassCookieNames).toBe('analytics_id,ThemePreference');
    expect(accepted.settings.l2Ttl).toBe('604800');
    expect(accepted.settings.listTtl).toBeUndefined();
    expect(accepted.settings.detailTtl).toBeUndefined();

    const disabled = hook({ success: true }, {
      pluginId: 'typecho-plugin-cache',
      settings: { ...defaultSettings, l1Ttl: 0, l2Ttl: '0' },
    });
    expect(disabled.settings.l1Ttl).toBe('0');
    expect(disabled.settings.l2Ttl).toBe('0');
  });

  it('renders binding status and performs a scoped manual invalidation', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
    const page = hooks.get('admin:page')!('', { slug: 'cache', csrfToken: 'csrf' });
    expect(page).toContain('TYPECHO_CACHE 已连接');
    expect(page).toContain('data-cache-domain="home"');

    const result = await hooks.get('plugin:typecho-plugin-cache:action')!({ handled: false }, {
      action: 'invalidate',
      payload: { domain: 'home' },
    });
    expect(result).toMatchObject({ handled: true, success: true });
    expect([...kv.store.keys()]).toContain('typecho:edge-cache:v1:g:home');
  });

  it('invalidates all page and shared-data generations on a manual full refresh', async () => {
    const kv = new MemoryKv();
    env.TYPECHO_CACHE = kv as any;
    const hooks = collectHooks();
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
