/**
 * Fixed-permalink routing regressions (middleware BUILT_IN_ROUTES vs custom
 * post / page / category patterns).
 *
 * Bug: the root-level `*.html` built-in route short-circuited custom permalink
 * matching, so `/{cid}.html` and `/{slug}.html` post permalinks never reached
 * a route (404). Fix contract covered here:
 *   1. root `.html` may enter custom permalink matching (other built-in and
 *      reserved paths keep their priority);
 *   2. the post `{cid}` branch only claims a real `type = 'post'` row so a page
 *      id / numeric page slug is not swallowed;
 *   3. every permalink rewrite renders through `next(target + 原查询串)`
 *      (single render, no `context.rewrite` restart, explicit security
 *      headers) and an unmatched root `.html` falls back to a plain `next()`.
 *
 * Scope: middleware routing decisions only. `next` is stubbed, so a 200 here is
 * NOT an end-to-end render assertion — only the missing-id case runs the real
 * `preparePageData` loader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { resetIsolateBoot } from '@/lib/isolate-boot';

const SITE = 'http://localhost:4321';
const ROUTE_BODY = 'route-rendered';
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8' };

let testDb: TestDatabase;

// Real-enough D1 stub: the middleware only needs it for the table-existence
// bootstrap check; all content/options reads go through the mocked getDb().
function createD1Stub() {
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
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
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
import { preparePageData } from '@/lib/page-data';
import { addHook, HookPoints, registerPluginLoaders } from '@/lib/plugin';
import { onRequest } from '@/middleware';

// ─── seeding helpers ────────────────────────────────────────────────────────

async function setPatterns(patterns: {
  permalinkPattern?: string;
  pagePattern?: string;
  categoryPattern?: string;
}) {
  const rows = Object.entries(patterns).map(([name, value]) => ({
    name,
    user: 0,
    value: value as string,
  }));
  if (rows.length) await testDb.insert(schema.options).values(rows);
  advanceOptionsSnapshotGeneration(testDb as any);
}

async function seedPost(slug: string) {
  const created = Math.floor(Date.now() / 1000) - 60;
  const [row] = await testDb.insert(schema.contents).values({
    title: `Post ${slug}`,
    slug,
    type: 'post',
    status: 'publish',
    created,
    modified: created,
    text: 'body',
  }).returning();
  return row;
}

async function seedPage(slug: string) {
  const created = Math.floor(Date.now() / 1000) - 60;
  const [row] = await testDb.insert(schema.contents).values({
    title: `Page ${slug}`,
    slug,
    type: 'page',
    status: 'publish',
    created,
    modified: created,
    text: 'body',
  }).returning();
  return row;
}

async function seedCategory(slug: string) {
  const [row] = await testDb.insert(schema.metas).values({
    name: `Category ${slug}`,
    slug,
    type: 'category',
    count: 0,
    order: 1,
  }).returning();
  return row;
}

// ─── dispatch helper ────────────────────────────────────────────────────────

// Astro's MiddlewareNext accepts `string | URL | Request`; permalink rewrites
// only ever pass a string target, which the assertions below pin down.
type NextTarget = string | URL | Request;
type NextImpl = (target?: NextTarget) => Response | Promise<Response>;

interface DispatchOptions {
  nextImpl?: NextImpl;
}

async function dispatch(pathWithQuery: string, options: DispatchOptions = {}) {
  const request = new Request(`${SITE}${pathWithQuery}`, { method: 'GET' });
  const rewrite = vi.fn((target: string) => new Response(`rewritten:${target}`, {
    status: 200,
    headers: HTML_HEADERS,
  }));
  const ctx = {
    request,
    url: new URL(request.url),
    locals: {},
    redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    rewrite,
  } as any;
  const impl: NextImpl = options.nextImpl
    ?? (() => new Response(ROUTE_BODY, { status: 200, headers: HTML_HEADERS }));
  const next = vi.fn(async (target?: NextTarget) => impl(target));

  const response = await onRequest(ctx, next) as Response;
  return { response, next, rewrite, locals: ctx.locals as Record<string, unknown> };
}

/** Argument list of the (single) `next(...)` call. */
function nextArgs(next: ReturnType<typeof vi.fn>): unknown[] {
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0];
}

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('Middleware: fixed-permalink routing', () => {
  beforeEach(async () => {
    resetIsolateBoot();
    testDb = await createTestDb();
    d1Stub = createD1Stub();
    await testDb.insert(schema.options).values([
      { name: 'siteUrl', user: 0, value: SITE },
      { name: 'installed', user: 0, value: '1' },
      { name: 'secret', user: 0, value: 'permalink-routing-secret' },
      { name: 'title', user: 0, value: 'Permalink Routing Test' },
      { name: 'theme', user: 0, value: 'typecho-theme-warm' },
    ]);
    advanceOptionsSnapshotGeneration(testDb as any);
  });

  afterEach(async () => {
    await disposeTestDb(testDb);
  });

  it('1. root /{cid}.html with a published post rewrites to next("/archives/{cid}/")', async () => {
    await setPatterns({ permalinkPattern: '/{cid}.html' });
    const post = await seedPost('cid-post');

    const result = await dispatch(`/${post.cid}.html`);

    expect(result.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(result.next)).toEqual([`/archives/${post.cid}/`]);
    expect(await result.response.clone().text()).toBe(ROUTE_BODY);
    expectSecurityHeaders(result.response);
  });

  it('2. root /{slug}.html post permalink rewrites to next("/archives/{cid}/")', async () => {
    await setPatterns({ permalinkPattern: '/{slug}.html' });
    const post = await seedPost('root-slug-post');

    const result = await dispatch('/root-slug-post.html');

    expect(result.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(result.next)).toEqual([`/archives/${post.cid}/`]);
    expectSecurityHeaders(result.response);
  });

  it('3. default /{slug}.html page route is preserved (plain next() fallback)', async () => {
    // No custom patterns: /{slug}.html is the built-in page route.
    await seedPage('about');

    const result = await dispatch('/about.html');

    expect(result.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(result.next)).toEqual([]);
    expect(await result.response.clone().text()).toBe(ROUTE_BODY);
    expectSecurityHeaders(result.response);
  });

  it('4. page id is not mistaken for a post id when both patterns use /{cid}.html', async () => {
    await setPatterns({ permalinkPattern: '/{cid}.html', pagePattern: '/{cid}.html' });
    const page = await seedPage('about-page');
    const post = await seedPost('archives-post');

    const pageResult = await dispatch(`/${page.cid}.html`);
    expect(pageResult.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(pageResult.next)).toEqual(['/about-page.html']);
    expectSecurityHeaders(pageResult.response);

    const postResult = await dispatch(`/${post.cid}.html`);
    expect(postResult.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(postResult.next)).toEqual([`/archives/${post.cid}/`]);
  });

  it('5. numeric page slug without a matching post id is not captured by the post {cid} pattern', async () => {
    await setPatterns({ permalinkPattern: '/{cid}.html' });
    const page = await seedPage('42');

    // /42.html has no post with cid 42: it stays the built-in page route.
    const bySlug = await dispatch('/42.html');
    expect(bySlug.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(bySlug.next)).toEqual([]);
    expect(bySlug.next).not.toHaveBeenCalledWith('/archives/42/');

    // The page's own cid must not be rewritten as a post either.
    const byCid = await dispatch(`/${page.cid}.html`);
    expect(byCid.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(byCid.next)).toEqual([]);
    expect(byCid.next).not.toHaveBeenCalledWith(`/archives/${page.cid}/`);
  });

  it('6. custom /docs/{cid}/ page resolves a numeric slug via next(), never context.rewrite', async () => {
    await setPatterns({ pagePattern: '/docs/{cid}/' });
    const page = await seedPage('123');

    const result = await dispatch(`/docs/${page.cid}/`);

    expect(result.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(result.next)).toEqual(['/123.html']);
    expectSecurityHeaders(result.response);
  });

  it('7. query string (password / commentPage) is preserved on post and page rewrites', async () => {
    await setPatterns({ permalinkPattern: '/{cid}.html', pagePattern: '/docs/{cid}/' });
    const post = await seedPost('query-post');
    const page = await seedPage('456');

    const postResult = await dispatch(`/${post.cid}.html?password=secret&commentPage=2`);
    expect(postResult.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(postResult.next)).toEqual([`/archives/${post.cid}/?password=secret&commentPage=2`]);
    expectSecurityHeaders(postResult.response);

    const pageResult = await dispatch(`/docs/${page.cid}/?password=secret&commentPage=3`);
    expect(pageResult.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(pageResult.next)).toEqual(['/456.html?password=secret&commentPage=3']);
    expectSecurityHeaders(pageResult.response);
  });

  it('8. default /archives/{cid}/ and nested custom post paths still route correctly', async () => {
    await setPatterns({ permalinkPattern: '/posts/{slug}/' });
    const post = await seedPost('nested-post');

    // Built-in archives route: untouched, plain next() fallback.
    const builtIn = await dispatch(`/archives/${post.cid}/`);
    expect(builtIn.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(builtIn.next)).toEqual([]);

    // Nested custom permalink still rewrites to the archives route.
    const nested = await dispatch('/posts/nested-post/');
    expect(nested.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(nested.next)).toEqual([`/archives/${post.cid}/`]);
    expectSecurityHeaders(nested.response);
  });

  it.each(['/admin/', '/api/', '/feed/', '/usr/'])(
    '9. reserved path %s is not captured by a broad /{slug}/ pattern',
    async (path) => {
      await setPatterns({ permalinkPattern: '/{slug}/' });
      // Posts that would match the pattern if the reserved-path guard were gone.
      await seedPost('admin');
      await seedPost('api');
      await seedPost('feed');
      await seedPost('usr');

      const result = await dispatch(path);

      expect(result.rewrite).not.toHaveBeenCalled();
      expect(nextArgs(result.next)).toEqual([]);
    },
  );

  it('10. missing root /{cid}.html falls through to the real page loader and 404s', async () => {
    await setPatterns({ permalinkPattern: '/{cid}.html' });
    const loaderCtx = {
      db: testDb,
      options: {
        siteUrl: SITE,
        permalinkPattern: '/{cid}.html',
        pagePattern: '/{slug}.html',
        categoryPattern: '/category/{slug}/',
        secret: 'permalink-routing-secret',
      },
      urls: { siteUrl: SITE },
      user: null,
      isLoggedIn: false,
      csrfToken: null,
    } as any;

    const result = await dispatch('/999999.html', {
      // Run the real loader (not a fake 404): the fallback target must be a
      // valid page route, and the loader must report the missing page.
      nextImpl: async () => {
        const loaded = await preparePageData(loaderCtx, '999999', `${SITE}/999999.html`, null, null, null);
        if (loaded instanceof Response) {
          return new Response(await loaded.text(), { status: loaded.status, headers: HTML_HEADERS });
        }
        return new Response(ROUTE_BODY, { status: 200, headers: HTML_HEADERS });
      },
    });

    expect(result.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(result.next)).toEqual([]);
    expect(result.response.status).toBe(404);
    expect(await result.response.clone().text()).toBe('Not Found');
    expectSecurityHeaders(result.response);
  });

  it('extra: root .html category pattern still rewrites to the built-in category route', async () => {
    await setPatterns({ categoryPattern: '/cat-{slug}.html' });
    await seedCategory('tech');

    const result = await dispatch('/cat-tech.html');

    expect(result.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(result.next)).toEqual(['/category/tech/']);
    expectSecurityHeaders(result.response);
  });

  it('preserves a default page when a root .html category pattern only matches its shape', async () => {
    await setPatterns({ categoryPattern: '/{slug}.html' });
    await seedPage('about');
    // A same-slug tag is not a category and must not claim this route either.
    await testDb.insert(schema.metas).values({ name: 'About', slug: 'about', type: 'tag' });

    const result = await dispatch('/about.html');

    expect(result.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(result.next)).toEqual([]);
    expectSecurityHeaders(result.response);
  });

  it('preserves a default page when a custom root .html page pattern has no matching page', async () => {
    await setPatterns({ pagePattern: '/page-{slug}.html' });
    await seedPage('page-about');
    // A post called "about" is not the page required by this custom pattern.
    await seedPost('about');

    const result = await dispatch('/page-about.html');

    expect(result.rewrite).not.toHaveBeenCalled();
    expect(nextArgs(result.next)).toEqual([]);
    expectSecurityHeaders(result.response);
  });

  it('extra: an activated plugin route:request still wins over root .html permalink matching', async () => {
    registerPluginLoaders({
      'test-permalink-route': () => async () => {
        addHook('route:request', 'test-permalink-route', async (
          value: { handled?: boolean },
          extra: { path: string },
        ) => {
          if (extra.path === '/claim-me.html') {
            return { handled: true, response: new Response('claimed by plugin', { status: 200, headers: HTML_HEADERS }) };
          }
          return value;
        });
      },
    }, { addHook, HookPoints });

    await testDb.insert(schema.options).values({
      name: 'activatedPlugins',
      user: 0,
      value: JSON.stringify(['test-permalink-route']),
    });
    await setPatterns({ permalinkPattern: '/{slug}.html' });
    await seedPost('claim-me');

    const result = await dispatch('/claim-me.html');

    expect(await result.response.clone().text()).toBe('claimed by plugin');
    expect(result.next).not.toHaveBeenCalled();
    expect(result.rewrite).not.toHaveBeenCalled();
  });
});
