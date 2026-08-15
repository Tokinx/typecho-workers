/**
 * Integration tests for scanner-path protection in the middleware.
 *
 * Sends real GET/POST requests through onRequest with a mocked render
 * (`next`) to verify that unknown scanner paths fail fast with a minimal
 * 404 (no render pipeline) and that 404 responses carry short CDN cache
 * headers, while legitimate routes, plugin routes, and custom permalinks
 * are untouched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { resetIsolateBoot } from '@/lib/isolate-boot';
import { resetSlidingWindow } from '@/lib/login-rate-limit';

let testDb: TestDatabase;

function createD1Stub(db: TestDatabase) {
  return {
    prepare: vi.fn((sql: string) => ({
      first: () => Promise.resolve(
        sql.includes('runtimeSchemaVersion')
          ? { runtimeSchemaVersion: '20260806' }
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
      bind: (): any => ({
        first: () => Promise.resolve(null),
        run: () => Promise.resolve({}),
      }),
    })),
    batch: vi.fn((_stmts: any[]) => Promise.resolve([])),
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
import { eq } from 'drizzle-orm';
import { advanceOptionsSnapshotGeneration } from '@/lib/options-snapshot-generation';
import { onRequest } from '@/middleware';
import { SCANNER_404_RATE_LIMIT } from '@/lib/constants';

const SITE = 'http://localhost:4321';

function makeCtx(path: string, method = 'GET', ip = '203.0.113.10') {
  const request = new Request(`${SITE}${path}`, {
    method,
    headers: { 'cf-connecting-ip': ip },
  });
  return {
    request,
    url: new URL(request.url),
    locals: {},
    redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
  } as any;
}

describe('scanner fast-fail 404', () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    d1Stub = createD1Stub(testDb);
    await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE });
    await testDb.insert(schema.options).values({ name: 'installed', user: 0, value: '1' });
    await testDb.insert(schema.options).values({ name: 'secret', user: 0, value: 'test-secret-32-chars-long!!!!!' });
    await testDb.insert(schema.options).values({ name: 'title', user: 0, value: 'Test Blog' });
    await testDb.insert(schema.options).values({ name: 'theme', user: 0, value: 'typecho-theme-warm' });
  });

  afterAll(async () => {
    resetIsolateBoot();
  });

  beforeEach(() => {
    resetSlidingWindow();
  });

  it.each([
    '/.git/config',
    '/.env',
    '/wp-login.php',
    '/wp-content/plugins/x.php',
    '/index.php',
    '/backup.zip',
    '/config.yml',
    '/Shell.PHP',
    '/a/b/c/',
  ])('GET %s → minimal 404 without invoking the render pipeline', async (path) => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const response = await onRequest(makeCtx(path), next) as Response;

    expect(response.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // Fast 404s are absorbed at the CDN edge so repeated hits skip the Worker.
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=60');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('POST to an unknown scanner path also fails fast', async () => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const response = await onRequest(makeCtx('/wp-login.php', 'POST'), next) as Response;

    expect(response.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves ordinary single-segment slugs (potential pages) untouched', async () => {
    const next = vi.fn(async () => new Response('page', { status: 200 }));
    const response = await onRequest(makeCtx('/about'), next) as Response;

    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
  });

  it('leaves the notes plugin public route untouched', async () => {
    const next = vi.fn(async () => new Response('note', { status: 200 }));
    const response = await onRequest(makeCtx('/note/123'), next) as Response;

    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves the built-in category feed route untouched', async () => {
    const next = vi.fn(async () => new Response('feed', { status: 200 }));
    const response = await onRequest(makeCtx('/category/test/feed.xml'), next) as Response;

    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves /.well-known (ACME challenges) untouched', async () => {
    const next = vi.fn(async () => new Response('challenge', { status: 200 }));
    const response = await onRequest(makeCtx('/.well-known/acme-challenge/abc'), next) as Response;

    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lets custom permalink rewriting take precedence over the fast-fail', async () => {
    await testDb.insert(schema.options).values({ name: 'categoryPattern', user: 0, value: '/topics/{slug}/' });
    await testDb.insert(schema.metas).values({ mid: 9001, name: 'Guides', slug: 'guides', type: 'category' });
    advanceOptionsSnapshotGeneration(testDb as any);

    try {
      // Existing category under the custom pattern → rewritten, not 404.
      const next = vi.fn(async () => new Response('category page', { status: 200 }));
      const response = await onRequest(makeCtx('/topics/guides/'), next) as Response;
      expect(response.status).toBe(302); // ctx.rewrite mock
      expect(next).not.toHaveBeenCalled();

      // Any slug under the custom pattern rewrites (existence is resolved
      // by the category route) — the fast-fail must not intercept it.
      const next2 = vi.fn(async () => new Response('category page', { status: 200 }));
      const response2 = await onRequest(makeCtx('/topics/does-not-exist/'), next2) as Response;
      expect(response2.status).toBe(302);
      expect(next2).not.toHaveBeenCalled();

      // A multi-segment path matching no pattern at all → fast 404.
      const next3 = vi.fn(async () => new Response('rendered', { status: 200 }));
      const response3 = await onRequest(makeCtx('/unrelated/thing/'), next3) as Response;
      expect(response3.status).toBe(404);
      expect(next3).not.toHaveBeenCalled();
    } finally {
      await testDb.delete(schema.options).where(eq(schema.options.name, 'categoryPattern'));
      await testDb.delete(schema.metas).where(eq(schema.metas.mid, 9001));
      advanceOptionsSnapshotGeneration(testDb as any);
    }
  });

  it('adds CDN cache headers to rendered 404 responses too', async () => {
    const next = vi.fn(async () => new Response('not found', {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));
    const response = await onRequest(makeCtx('/definitely-missing-page'), next) as Response;

    expect(response.status).toBe(404);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=60');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(response.headers.has('X-Typecho-Public-HTML')).toBe(false);
  });

  it('does not add 404 CDN cache headers to admin/api responses', async () => {
    const next = vi.fn(async () => new Response('nope', {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }));
    const response = await onRequest(makeCtx('/api/admin/nope'), next) as Response;

    expect(response.status).toBe(404);
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
  });

  it('rate-limits a single IP hammering scanner paths', async () => {
    let response: Response;
    let next = vi.fn(async () => new Response('rendered', { status: 200 }));

    // Fill the window: maxRequests allowed, then the next is rejected.
    for (let i = 0; i < SCANNER_404_RATE_LIMIT.maxRequests; i += 1) {
      response = await onRequest(makeCtx(`/scan/${i}/x.php`), next) as Response;
      expect(response.status).toBe(404);
    }
    next = vi.fn(async () => new Response('rendered', { status: 200 }));
    response = await onRequest(makeCtx('/scan/overflow.php'), next) as Response;

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe(String(SCANNER_404_RATE_LIMIT.windowSeconds));
    expect(next).not.toHaveBeenCalled();
  });
});
