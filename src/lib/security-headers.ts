/**
 * Centralised security response-header construction.
 *
 * Splitting this out of middleware.ts lets the same builder serve both
 * normal HTML routes (full CSP) and worker-managed early responses
 * (install redirect, asset proxy) without each call site reinventing
 * directives.
 */
import { applyFilterSafely, type HookContext } from '@/lib/plugin';

/**
 * The default Content-Security-Policy. Tuned for the bundled Warm
 * theme + common embedded content (the markdown sanitizer permits embedded
 * youtube/bilibili/vimeo iframes, and gravatar URLs are images).
 *
 * Plugins that need extra origins can extend the directives via the
 * `csp:directives` filter hook instead of editing this map.
 */
export type CspDirectives = Record<string, string[]>;

export function defaultCspDirectives(): CspDirectives {
  return {
    'default-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'https://www.gravatar.com', 'https:'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'script-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'frame-src': [
      "'self'",
      'https://www.youtube.com',
      'https://player.bilibili.com',
      'https://player.vimeo.com',
    ],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
}

/**
 * Mutate a directive map: add new sources to a key, deduping. Used by
 * plugin authors via the csp:directives filter hook.
 */
export function addCspSource(directives: CspDirectives, key: string, sources: string[]): void {
  const existing = new Set(directives[key] || []);
  for (const src of sources) existing.add(src);
  directives[key] = Array.from(existing);
}

/**
 * Fetch directives a whitelisted domain is added to. Administrators can
 * list external domains (one per line) in the basic-settings page; each
 * entry becomes an additional allowed source for these directives —
 * incrementally, on top of the defaults and plugin contributions.
 */
export const CSP_WHITELIST_DIRECTIVES = [
  'script-src',
  'style-src',
  'img-src',
  'connect-src',
  'font-src',
  'media-src',
  'frame-src',
];

const CSP_HOST_PATTERN =
  /^(https?:\/\/)?(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i;

/**
 * Parse the admin-configured CSP whitelist (one external domain per line)
 * into normalized CSP sources. Bare hosts get `https://` prefixed; lines
 * that aren't plain hosts (paths, scheme-less tokens like `data:`, or
 * anything with whitespace/quotes/semicolons) are dropped so a typo can't
 * break the serialized policy.
 */
export function parseCspWhitelist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!CSP_HOST_PATTERN.test(trimmed)) continue;
    const source = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    if (seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }
  return sources;
}

export function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .filter(([, srcs]) => srcs && srcs.length > 0)
    .map(([key, srcs]) => `${key} ${srcs.join(' ')}`)
    .join('; ');
}

export interface SecurityHeaderContext {
  request?: Request;
  /**
   * Set when the response is for an upload-served file. We tighten the
   * policy considerably because user-uploaded assets shouldn't be able
   * to source code from anywhere — including the site itself.
   */
  upload?: boolean;
  /** Allow the authenticated /admin/preview response to be framed by its editor. */
  allowSameOriginFrame?: boolean;
  /**
   * Raw multi-line whitelist from the basic-settings page (one external
   * domain per line). Parsed and merged into `CSP_WHITELIST_DIRECTIVES`
   * on top of the defaults — never replacing them.
   */
  cspWhitelist?: string;
}

/**
 * Apply the project's standard security headers to a Response. Existing
 * headers are preserved (the route handler had a chance to override
 * before us). HSTS only fires for https requests so dev http on
 * localhost still works (G8-6 / G1-8 alignment).
 */
export async function applySecurityHeaders(
  response: Response,
  secCtx: SecurityHeaderContext = {},
  pluginCtx?: HookContext,
): Promise<Response> {
  const proto = secCtx.request ? safeProtocol(secCtx.request.url) : 'https:';
  const isHttps = proto === 'https:';

  // Build CSP — for upload responses use a locked-down policy; otherwise
  // start from defaults and let plugins extend via filter hook.
  let cspString: string;
  if (secCtx.upload) {
    cspString = "default-src 'none'; sandbox; style-src 'unsafe-inline'";
  } else if (pluginCtx) {
    let directives = defaultCspDirectives();
    try {
      const filtered = await applyFilterSafely(pluginCtx, 'csp:directives', directives, { request: secCtx.request });
      if (filtered && typeof filtered === 'object') {
        directives = filtered as CspDirectives;
      }
    } catch {
      // Plugin failures already logged by applyFilterSafely.
    }
    // The admin whitelist is applied after plugin contributions so user
    // configuration is always present, no matter what a plugin did.
    if (secCtx.cspWhitelist) {
      const sources = parseCspWhitelist(secCtx.cspWhitelist);
      for (const src of sources) {
        for (const key of CSP_WHITELIST_DIRECTIVES) {
          addCspSource(directives, key, [src]);
        }
      }
    }
    if (secCtx.allowSameOriginFrame) {
      directives['frame-ancestors'] = ["'self'"];
    }
    cspString = serializeCsp(directives);
  } else {
    const directives = defaultCspDirectives();
    if (secCtx.allowSameOriginFrame) {
      directives['frame-ancestors'] = ["'self'"];
    }
    cspString = serializeCsp(directives);
  }

  const additions: Array<[string, string]> = [
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', secCtx.allowSameOriginFrame ? 'SAMEORIGIN' : 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
    ['Content-Security-Policy', cspString],
  ];
  if (isHttps) additions.push(['Strict-Transport-Security', 'max-age=31536000; includeSubDomains']);

  // Skip if all are already present — avoids cloning the response when
  // a previous middleware has already done the work.
  const have = (key: string) => response.headers.has(key);
  if (additions.every(([key]) => have(key))) return response;

  const headers = new Headers(response.headers);
  for (const [key, value] of additions) {
    if (!headers.has(key)) headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function safeProtocol(url: string): string {
  try { return new URL(url).protocol; } catch { return 'https:'; }
}
