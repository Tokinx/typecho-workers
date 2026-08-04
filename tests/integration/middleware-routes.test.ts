/**
 * Middleware redirect-loop smoke tests.
 *
 * Sends real GET requests through the middleware to verify that no path
 * produces a 302 redirect when the DB is seeded and ready.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { resetIsolateBoot } from '@/lib/isolate-boot';

let testDb: TestDatabase;

// We need env.DB to be a real-enough D1 stub so ensureTablesReady doesn't throw.
// The test DB is a @libsql/client SQLite file — we don't need the D1 stub for
// anything except middleware's table-existence check.
function createD1Stub(db: TestDatabase) {
  return {
    prepare: (sql: string) => ({
      first: () => Promise.resolve(
        sql.includes('runtimeSchemaVersion')
          ? { runtimeSchemaVersion: '20260730' }
          : { name: 'typecho_options' } as any,
      ),
      all: () => Promise.resolve({
        results: [
          { name: 'email' },
          { name: 'lastSentAt' },
          { name: 'uid' },
          { name: 'tokenHash' },
          { name: 'expiresAt' },
        ],
      }),
      run: () => Promise.resolve({}),
      bind: (): any => ({}),
    }),
    batch: (_stmts: any[]) => Promise.resolve([]),
    dump: () => Promise.resolve([]),
    exec: () => Promise.resolve({}),
  };
}

let d1Stub: ReturnType<typeof createD1Stub>;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => testDb, schema: actual.schema };
});

vi.mock('cloudflare:workers', () => ({
  env: {
    get DB() { return d1Stub; },
    BUCKET: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() },
    TYPECHO_CACHE: null as any,
  },
  caches: { default: { match: vi.fn(), put: vi.fn(), delete: vi.fn() } },
}));

import { schema } from '@/db';
import { advanceOptionsSnapshotGeneration } from '@/lib/options-snapshot-generation';
import { onRequest } from '@/middleware';
import { env as workerEnv } from 'cloudflare:workers';
import { earlyRequestProvider, resetCacheProviderForTests } from '@/plugins/typecho-plugin-cache/cache';

const SITE = 'http://localhost:4321';

interface TestCase {
  method: string;
  path: string;
  expectStatus: number;
}

const routes: TestCase[] = [
  // Static/bypass paths
  { method: 'GET', path: '/install', expectStatus: 200 },
  { method: 'GET', path: '/api/install', expectStatus: 200 },
  { method: 'GET', path: '/css/admin.css', expectStatus: 200 },
  { method: 'GET', path: '/vendor/jquery.js', expectStatus: 200 },
  { method: 'GET', path: '/js/test.js', expectStatus: 200 },
  { method: 'GET', path: '/plugin-assets/x/y.js', expectStatus: 200 },
  { method: 'GET', path: '/usr/uploads/2026/07/image.jpg', expectStatus: 200 },

  // Public pages
  { method: 'GET', path: '/', expectStatus: 200 },
  { method: 'GET', path: '/admin/login', expectStatus: 200 },
  { method: 'GET', path: '/admin/forgot-password', expectStatus: 200 },
  { method: 'GET', path: '/admin/reset-password', expectStatus: 200 },
  { method: 'GET', path: '/sitemap.xml', expectStatus: 200 },
  { method: 'GET', path: '/robots.txt', expectStatus: 200 },

  // Admin pages (no auth cookie → should still return 200, not 302 loop)
  { method: 'GET', path: '/admin/', expectStatus: 200 },
  { method: 'GET', path: '/admin/preview', expectStatus: 200 },
  { method: 'GET', path: '/admin/write-post', expectStatus: 200 },
  { method: 'GET', path: '/admin/manage-posts', expectStatus: 200 },

  // Feed routes
  { method: 'GET', path: '/feed/', expectStatus: 200 },
  { method: 'GET', path: '/category/test/feed.xml', expectStatus: 200 },
  { method: 'GET', path: '/tag/test/feed.xml', expectStatus: 200 },
  { method: 'GET', path: '/author/1/feed.xml', expectStatus: 200 },
];

describe('Middleware: no redirect loops when DB is ready', () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    d1Stub = createD1Stub(testDb);
    // Seed minimal config so middleware doesn't redirect to /install
    await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE });
    await testDb.insert(schema.options).values({ name: 'installed', user: 0, value: '1' });
    await testDb.insert(schema.options).values({ name: 'secret', user: 0, value: 'test-secret-32-chars-long!!!!!' });
    await testDb.insert(schema.options).values({ name: 'title', user: 0, value: 'Test Blog' });
    await testDb.insert(schema.options).values({ name: 'theme', user: 0, value: 'typecho-theme-minimal' });
  });

  for (const { method, path, expectStatus } of routes) {
    it(`${method} ${path} → ${expectStatus}`, async () => {
      const request = new Request(`${SITE}${path}`, { method });
      const ctx = {
        request,
        url: new URL(`${SITE}${path}`),
        locals: { runtime: undefined },
        redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
        rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      } as any;

      const response = await onRequest(ctx, async () => new Response('ok', { status: 200 })) as Response;
      if (response.status !== expectStatus) {
        const location = response.headers.get('Location') || '(none)';
        throw new Error(`${method} ${path} returned ${response.status} (Location: ${location}), expected ${expectStatus}`);
      }
      expect(response.status).toBe(expectStatus);
    });
  }

  it('rewrites paginated custom category permalinks to the built-in route', async () => {
    await testDb.insert(schema.options).values({ name: 'categoryPattern', user: 0, value: '/topics/{slug}/' });
    advanceOptionsSnapshotGeneration(testDb as any);

    const request = new Request(`${SITE}/topics/guides/page/2/?sort=latest`);
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const next = vi.fn(async () => new Response('category page', { status: 200 }));

    const response = await onRequest(ctx, next) as Response;

    expect(response.status).toBe(200);
    expect(ctx.locals._page).toBe(2);
    expect(next).toHaveBeenCalledWith('/category/guides/?sort=latest');
  });

  it('does not cache public HTML when the cache plugin has no KV control state', async () => {
    const waitUntil = vi.fn();
    const putSpy = vi.spyOn(caches.default, 'put');
    const request = new Request(`${SITE}/cache-write`, { method: 'GET' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil } },
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;

    const response = await onRequest(
      ctx,
      async () => new Response('cache me', { status: 200 }),
    ) as Response;

    expect(response.status).toBe(200);
    expect(putSpy).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    putSpy.mockRestore();
  });

  it('bypasses all D1 bootstrap work for public uploads', async () => {
    resetIsolateBoot();
    d1Stub = {
      prepare: vi.fn(() => {
        throw new Error('uploads must not touch D1');
      }),
      batch: vi.fn(() => {
        throw new Error('uploads must not touch D1');
      }),
    } as any;

    const request = new Request(`${SITE}/usr/uploads/2026/07/image.jpg`);
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
    } as any;
    const response = await onRequest(
      ctx,
      async () => new Response('image', { status: 200 }),
    ) as Response;

    expect(response.status).toBe(200);
    expect(d1Stub.prepare).not.toHaveBeenCalled();
    expect(d1Stub.batch).not.toHaveBeenCalled();
  });

  it('serves a warm early-provider L1 hit before any D1 bootstrap work', async () => {
    const values = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string, options?: { type?: string }) => {
        const value = values.get(key);
        if (value === undefined) return null;
        return options?.type === 'json' ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      delete: vi.fn(async (key: string) => { values.delete(key); }),
    };
    workerEnv.TYPECHO_CACHE = kv as any;
    resetCacheProviderForTests();
    await earlyRequestProvider.lifecycle!({
      type: 'activate',
      settings: {
        cacheScopes: ['other'],
        l1Ttl: '86400',
        listTtl: '86400',
        detailTtl: '604800',
        staticCdnUrl: '',
        staticExtensions: 'css,js,png',
        avatarCdnUrl: '',
      },
      options: {
        siteUrl: SITE,
        permalinkPattern: '/archives/{cid}/',
        pagePattern: '/{slug}.html',
      },
    });

    d1Stub = createD1Stub(testDb);
    resetIsolateBoot();
    const url = `${SITE}/early-zero-d1`;
    const makeContext = () => ({
      request: new Request(url),
      url: new URL(url),
      locals: {},
      redirect: (path: string) => new Response(null, { status: 302, headers: { Location: path } }),
      rewrite: (path: string) => new Response(null, { status: 302, headers: { Location: path } }),
    } as any);
    const next = vi.fn(async () => new Response('<html>cached before D1</html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));
    expect((await onRequest(makeContext(), next) as Response).headers.get('X-Typecho-Cache')).toBe('MISS');

    resetIsolateBoot();
    d1Stub = {
      prepare: vi.fn(() => { throw new Error('L1 hit must not touch D1'); }),
      batch: vi.fn(() => { throw new Error('L1 hit must not touch D1'); }),
    } as any;
    const hit = await onRequest(makeContext(), next) as Response;
    expect(hit.headers.get('X-Typecho-Cache')).toBe('L1');
    expect(await hit.text()).toContain('cached before D1');
    expect(d1Stub.prepare).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();

    await earlyRequestProvider.lifecycle!({ type: 'deactivate' });
    workerEnv.TYPECHO_CACHE = null as any;
    resetCacheProviderForTests();
  });

  // ── Error handling: specific error types ──

  it('returns 302→/install when tables truly missing, not 500', async () => {
    resetIsolateBoot();
    // Override D1 stub to report no tables
    d1Stub = createD1Stub(testDb);
    (d1Stub as any).prepare = () => ({
      first: () => Promise.resolve(null), // no typecho_options table
      bind: () => ({}),
    });

    const request = new Request(`${SITE}/`, { method: 'GET' });
    const ctx = { request, url: new URL(`${SITE}/`), locals: {}, redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }), rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }) } as any;
    const response = await onRequest(ctx, async () => new Response('ok', { status: 200 })) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/install');
  });

  it('returns 500 when D1 unreachable, not 302 redirect', async () => {
    resetIsolateBoot();
    // Simulate D1 failure (not tables-missing)
    d1Stub = {
      prepare: () => { throw new Error('D1 unreachable'); },
      batch: () => Promise.resolve([]),
    } as any;

    const request = new Request(`${SITE}/`, { method: 'GET' });
    const ctx = { request, url: new URL(`${SITE}/`), locals: {}, redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }), rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }) } as any;
    const response = await onRequest(ctx, async () => new Response('ok', { status: 200 })) as Response;
    expect(response.status).toBe(500);
  });
});
describe('Middleware: activated plugin routes (registry imported by middleware)', () => {
  // The middleware statically imports virtual:typecho-plugin-registry (stubbed
  // in tests/__mocks__/plugin-registry.ts with the workspace plugin loaders),
  // so loaders are already registered before setActivatedPlugins runs on this
  // first request — the exact ordering production relies on for a cold
  // isolate. Without that import this test 404s, proving the regression.
  beforeAll(async () => {
    // Later error-handling tests replace d1Stub and reset isolate boot; the
    // plugin-route tests need a healthy D1 stub again.
    d1Stub = createD1Stub(testDb);
    resetIsolateBoot();
    // Invalidate any 60s options snapshot so loadOptions re-reads the rows below.
    advanceOptionsSnapshotGeneration(testDb as any);
    await testDb.insert(schema.options).values({
      name: 'activatedPlugins',
      user: 0,
      value: JSON.stringify(['typecho-plugin-webdav']),
    });
    await testDb.insert(schema.options).values({
      name: 'plugin:typecho-plugin-webdav',
      user: 0,
      value: JSON.stringify({
        routePath: '/webdav',
        protocolEnabled: 'true',
        mounts: [{ mount: '', provider: 'r2', bindingName: 'BUCKET', prefix: '' }],
      }),
    });
  });

  it('claims GET /webdav with a Basic-auth challenge instead of 404', async () => {
    const request = new Request(`${SITE}/webdav`, { method: 'GET' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const response = await onRequest(ctx, async () => new Response('not found', { status: 404 })) as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic realm="Typecho WebDAV"');
  });

  it('answers OPTIONS /webdav with 204 and DAV capabilities', async () => {
    const request = new Request(`${SITE}/webdav`, { method: 'OPTIONS' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const response = await onRequest(ctx, async () => new Response('not found', { status: 404 })) as Response;
    expect(response.status).toBe(204);
    expect(response.headers.get('DAV')).toBe('1, 2');
  });

  it('leaves non-WebDAV paths untouched (still 404)', async () => {
    const request = new Request(`${SITE}/webdavish`, { method: 'GET' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const response = await onRequest(ctx, async () => new Response('not found', { status: 404 })) as Response;
    expect(response.status).toBe(404);
  });
});
