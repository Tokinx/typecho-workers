import { defineMiddleware } from 'astro:middleware';
import { getDb } from '@/db';
import { schema } from '@/db';
import { loadOptions, ensureSecret } from '@/lib/options';
import { applyFilterSafely, isPluginAdminPath, parseActivatedPlugins, setActivatedPlugins, type HookContext } from '@/lib/plugin';
import { applySecurityHeaders } from '@/lib/security-headers';
import { setRequestCoreContext, getClientIp } from '@/lib/context';
import { compilePermalinkPattern } from '@/lib/permalink-pattern';
import { isScannerPath, FAST_404_HTML, shouldRateLimitScanner } from '@/lib/scanner-protection';
import { SCANNER_404_RATE_LIMIT } from '@/lib/constants';
import {
  ensureDatabaseReady,
  TablesMissingError,
} from '@/lib/isolate-boot';
import { eq, and } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { publishedPostCondition } from '@/lib/content-visibility';
import { runEarlyRequestProviders, syncEarlyRequestProviders } from '@/lib/early-request';
import { PUBLIC_HTML_HEADER } from '@/lib/cache';

// Plugin loader registration (generated at build time by plugin-loader.ts).
// Statically imported so the lazy plugin loader table exists before the first
// request of a cold isolate runs setActivatedPlugins. Page-ssr scripts only
// execute after a page chunk loads, which may never happen before a plugin
// route like /api/admin/notes is requested. Vitest resolves this to a stub that
// mirrors the generated registry.
import 'virtual:typecho-plugin-registry';

const redirectToInstall = (request: Request) =>
  applySecurityHeaders(new Response(null, { status: 302, headers: { Location: '/install' } }), { request });

const BUILT_IN_ROUTES = [
  /^\/archives\/\d+\/?$/,       // post: /archives/{cid}/
  /^\/[^/]+\.html$/,            // page: /{slug}.html
  /^\/category\/[^/]+\/?$/,     // category: /category/{slug}/
  /^\/category\/[^/]+\/feed\.xml$/, // category feed
  /^\/tag\//,
  /^\/author\//,
  /^\/search\//,
  /^\/$/,
  /^\/sitemap\.xml$/,           // SEO
  /^\/robots\.txt$/,            // SEO
  /^\/feed\/?$/,                // main feed
  /^\/feed\//,                  // sub feeds (atom, rss, comments)
];

/**
 * Turn a Typecho `/page/N/` suffix into an Astro route. Category permalinks
 * may be custom, so stripping the suffix alone is not enough to reach the
 * built-in `/category/[slug]` route.
 */
async function resolvePaginatedPath(
  path: string,
  search: string,
  db: ReturnType<typeof getDb>,
  categoryPattern?: string,
): Promise<{ page: number; target: string } | null> {
  const match = path.match(/^(.*)\/page\/(\d+)\/?$/);
  if (!match) return null;

  const basePath = match[1] || '';
  const page = parseInt(match[2], 10);
  let targetPath = basePath === '' ? '/' : `${basePath}/`;

  if (categoryPattern && categoryPattern !== '/category/{slug}/') {
    const categoryRegex = compilePermalinkPattern(categoryPattern, 'category');
    const categoryMatch = categoryRegex ? targetPath.match(categoryRegex) : null;
    if (categoryMatch?.groups) {
      let slug = categoryMatch.groups.slug || null;
      if (!slug && categoryMatch.groups.mid) {
        const category = await db.query.metas.findFirst({
          columns: { slug: true },
          where: and(
            eq(schema.metas.mid, parseInt(categoryMatch.groups.mid, 10)),
            eq(schema.metas.type, 'category'),
          ),
        });
        slug = category?.slug || null;
      }
      if (slug) targetPath = `/category/${slug}/`;
    }
  }

  return { page, target: `${targetPath}${search}` };
}

const coreMiddleware = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // Skip middleware for static assets, install page, and install API
  if (
    path.startsWith('/css/') ||
    path.startsWith('/js/') ||
    path.startsWith('/img/') ||
    path.startsWith('/themes/') ||
    path.startsWith('/vendor/') ||
    path.startsWith('/plugin-assets/') ||
    path.startsWith('/usr/uploads/') ||
    path === '/install' ||
    path === '/api/install'
  ) {
    return await applySecurityHeaders(await next(), { request: context.request });
  }

  const d1 = env.DB;

  try {
    await ensureDatabaseReady(d1);
  } catch (err) {
    if (err instanceof TablesMissingError) {
      return redirectToInstall(context.request);
    }
    // D1 unreachable or other unexpected error — fail open with 500
    // rather than redirecting to /install (which would try D1 again).
    console.error('[middleware] ensureTablesReady failed:', err);
    return applySecurityHeaders(new Response('Service unavailable', { status: 500 }), { request: context.request });
  }

  const db = getDb(d1);

  let options;
  try {
    options = await loadOptions(db);
    if (!options.installed) {
      return redirectToInstall(context.request);
    }
    // PHP-Typecho migrations import the options table without carrying the
    // `secret` value (it used to live in config.inc.php). Bootstrap one
    // synchronously the first time we see it missing, then reload options
    // so the current request has the freshly-generated value.
    if (!options.secret) {
      await ensureSecret(db);
      options = await loadOptions(db);
    }
  } catch (err) {
    console.error('[middleware] loadOptions failed:', err);
    return applySecurityHeaders(new Response('Service unavailable', { status: 500 }), { request: context.request });
  }

  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  const pluginCtx: HookContext = { activatedPlugins: new Set<string>() };
  await setActivatedPlugins(pluginCtx, activatedIds);
  await syncEarlyRequestProviders(context.request, activatedIds, options);
  setRequestCoreContext(context.locals, { db, options, pluginCtx }, context.request);

  // Resolve custom category patterns only after options and plugin runtime
  // state are available so paginated HTML gets the same CDN and CSP handling.
  const paginated = await resolvePaginatedPath(
    path,
    url.search,
    db,
    options.categoryPattern as string | undefined,
  );
  if (paginated) {
    context.locals._page = paginated.page;
    return applySecurityHeaders(
      await next(paginated.target),
      { request: context.request },
      pluginCtx,
    );
  }

  // G: route:request is isolated per plugin — a single plugin bug (e.g. a
  // timed-out outbound call in one handler) must not take the whole site
  // down, since plugins are statically bundled and cannot be hot-unloaded.
  // applyFilterSafely swallows each handler's exception and continues the
  // chain; only a plugin that returns handled=true with a Response takes
  // effect. The reserved-core-path hard block below still applies.
  const pluginRoute = await applyFilterSafely(pluginCtx, 'route:request', { handled: false }, {
    request: context.request,
    url,
    path,
    db,
    options,
    env,
  });
  if (pluginRoute?.handled && pluginRoute.response instanceof Response) {
    // G6-4: hard-block plugins from claiming reserved core paths.
    // Even a buggy/malicious plugin that returns handled=true on /admin
    // must not be able to intercept admin auth, install, or core API.
    if (isReservedCorePath(path)) {
      console.warn(`[middleware] plugin tried to claim reserved path ${path}; ignoring`);
    } else {
      return await applySecurityHeaders(pluginRoute.response, { request: context.request }, pluginCtx);
    }
  }

  // ── Permalink URL Rewriting ────────────────────────────────────────────────
  // After a rewrite the middleware runs again on the NEW path.
  // To avoid infinite loops, skip rewriting for paths that already
  // match an Astro built-in route (the rewrite targets).
  const postPattern = options.permalinkPattern as string | undefined;
  const pagePattern = options.pagePattern as string | undefined;
  const categoryPattern = options.categoryPattern as string | undefined;

  const isBuiltInRoute = BUILT_IN_ROUTES.some((re) => re.test(path));

  if (
    !isBuiltInRoute &&
    !path.startsWith('/admin') &&
    !path.startsWith('/api/') &&
    !path.startsWith('/feed') &&
    !path.startsWith('/usr/')
  ) {
    // ── Post permalink rewriting ──
    if (
      postPattern &&
      postPattern !== '/archives/{cid}/'
    ) {
      const regex = compilePermalinkPattern(postPattern, 'post');
      if (regex) {
        const match = path.match(regex);
        if (match?.groups) {
          let cid: number | null = null;

          if (match.groups.cid) {
            cid = parseInt(match.groups.cid, 10);
          } else if (match.groups.slug) {
            const row = await db.query.contents.findFirst({
              columns: { cid: true },
              where: and(eq(schema.contents.slug, match.groups.slug), publishedPostCondition()),
            });
            if (row) {
              cid = row.cid;
            }
          }

          if (cid) {
            return context.rewrite(`/archives/${cid}/`);
          }
        }
      }
    }

    // ── Page permalink rewriting ──
    if (
      pagePattern &&
      pagePattern !== '/{slug}.html'
    ) {
      const regex = compilePermalinkPattern(pagePattern, 'page');
      if (regex) {
        const match = path.match(regex);
        if (match?.groups) {
          let slug: string | null = null;

          if (match.groups.slug) {
            slug = match.groups.slug;
          } else if (match.groups.cid) {
            const row = await db.query.contents.findFirst({
              columns: { slug: true },
              where: and(
                eq(schema.contents.cid, parseInt(match.groups.cid, 10)),
                eq(schema.contents.type, 'page'),
              ),
            });
            if (row?.slug) {
              slug = row.slug;
            }
          }

          if (slug) {
            return context.rewrite(`/${slug}.html`);
          }
        }
      }
    }

    // ── Category permalink rewriting ──
    if (
      categoryPattern &&
      categoryPattern !== '/category/{slug}/'
    ) {
      const regex = compilePermalinkPattern(categoryPattern, 'category');
      if (regex) {
        const match = path.match(regex);
        if (match?.groups) {
          let slug: string | null = null;

          if (match.groups.slug) {
            slug = match.groups.slug;
          } else if (match.groups.mid) {
            const row = await db.query.metas.findFirst({
              columns: { slug: true },
              where: and(
                eq(schema.metas.mid, parseInt(match.groups.mid, 10)),
                eq(schema.metas.type, 'category'),
              ),
            });
            if (row?.slug) {
              slug = row.slug;
            }
          }

          if (slug) {
            return context.rewrite(`/category/${slug}/`);
          }
        }
      }
    }

    // ── Scanner fast-fail ────────────────────────────────────────────────
    // Reaching here means no built-in route, no plugin route, and no
    // permalink pattern matched this path. Multi-segment paths have no
    // legitimate route under this system, and single-segment scanner
    // targets (.php, .env, dotfiles) are never valid page slugs. Fail fast
    // with a minimal 404 — no D1 reads, no theme render — and rate-limit
    // the offender. /note/ is the notes plugin's public route and
    // /.well-known/ hosts ACME challenges, so both are exempt.
    if (
      !path.startsWith('/note/') &&
      !path.startsWith('/.well-known') &&
      isScannerPath(path)
    ) {
      if (shouldRateLimitScanner(getClientIp(context.request))) {
        return applySecurityHeaders(
          new Response('Too Many Requests', {
            status: 429,
            headers: { 'Retry-After': String(SCANNER_404_RATE_LIMIT.windowSeconds) },
          }),
          { request: context.request },
          pluginCtx,
        );
      }
      return applySecurityHeaders(
        new Response(FAST_404_HTML, {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
        { request: context.request },
        pluginCtx,
      );
    }
  }

  // Execute the route handler
  let response: Response;
  try {
    response = await next();
  } catch (err) {
    console.error('[middleware] next() threw:', path, err);
    return applySecurityHeaders(new Response('Server error', { status: 500 }), { request: context.request }, pluginCtx);
  }
  if (response.status === 404) {
    // Only warn for admin paths (should never 404); info for everything else
    // (bots hitting non-existent routes is normal traffic noise).
    if (path.startsWith('/admin')) {
      console.warn('[middleware] admin route 404:', { path, method: context.request.method });
    }
  }

  response = await applySecurityHeaders(response, {
    request: context.request,
    // The editor's same-origin, sandboxed iframe is the sole exception to
    // the default anti-framing policy.
    allowSameOriginFrame: path === '/admin/preview',
  }, pluginCtx);

  return response;
});

export const onRequest = defineMiddleware(async (context, next) => {
  // Streaming SSR makes `Astro.response.headers.set()` inside theme components
  // unreliable (WarmShell's marker was silently dropped), so the cache
  // plugin's public-HTML marker may be missing from rendered pages. Backfill
  // it inside the render chain — before the early-request provider inspects
  // the response — so the plugin can cache public pages again.
  const renderNext = async (): Promise<Response> => {
    const rendered = await coreMiddleware(context, next) as Response;
    if (!rendered.headers.has('X-Typecho-Cache') && isPublicHtmlCandidate(context.request, rendered)) {
      const headers = new Headers(rendered.headers);
      headers.set(PUBLIC_HTML_HEADER, '1');
      return new Response(rendered.body, {
        status: rendered.status,
        statusText: rendered.statusText,
        headers,
      });
    }
    return rendered;
  };
  const response = await runEarlyRequestProviders({
    request: context.request,
    url: context.url,
    env: env as unknown as Record<string, unknown>,
    waitUntil: context.locals.cfContext
      ? promise => context.locals.cfContext!.waitUntil(promise)
      : undefined,
  }, renderNext);
  if (!response.headers.has(PUBLIC_HTML_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.delete(PUBLIC_HTML_HEADER);
  if (response.status === 404) {
    // Absorb repeated 404s (scanner noise) at the CDN edge instead of
    // re-running the Worker. The short TTL keeps stale-404 risk negligible.
    headers.set('Cache-Control', 'public, max-age=60');
    headers.set('Cloudflare-CDN-Cache-Control', 'public, max-age=60');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});

/**
 * True when a rendered response is a cacheable public page: GET, text/html,
 * not a reserved path, and not already handled by the early-request cache
 * plugin (which manages its own marker and cache headers).
 */
export function isPublicHtmlCandidate(request: Request, response: Response): boolean {
  if (request.method !== 'GET') return false;
  if (response.headers.has(PUBLIC_HTML_HEADER) || response.headers.has('X-Typecho-Cache')) return false;
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) return false;
  const path = new URL(request.url).pathname;
  if (
    path === '/install' ||
    path === '/admin' || path.startsWith('/admin/') ||
    path === '/api' || path.startsWith('/api/') ||
    path === '/usr' || path.startsWith('/usr/')
  ) {
    return false;
  }
  return true;
}

/**
 * Paths that plugins MUST NOT be able to claim via route:request.
 * Hard-coded so a misbehaving plugin can never shadow the install
 * flow, login, or admin endpoints.
 */
function isReservedCorePath(path: string): boolean {
  // Allow plugins to claim specific admin paths (registered via registerPluginAdminPath)
  if (isPluginAdminPath(path)) return false;
  if (path === '/install' || path === '/api/install') return true;
  if (path === '/admin' || path.startsWith('/admin/')) return true;
  if (path === '/api/admin' || path.startsWith('/api/admin/')) return true;
  if (path === '/api/users/login' || path === '/api/users/logout' || path === '/api/users/register') return true;
  return false;
}
