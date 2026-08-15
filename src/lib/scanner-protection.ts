/**
 * Scanner-path protection: cheap fail-fast 404s for unknown paths that have
 * no legitimate route (multi-segment paths, dangerous extensions, dotfiles),
 * so scanner traffic never reaches the render pipeline or D1.
 *
 * The middleware calls isScannerPath() only after built-in routes, plugin
 * routes, and custom permalink patterns have all been tried, so a `true`
 * here means the path is definitively unknown.
 */

import { trackSlidingWindow } from '@/lib/login-rate-limit';
import { SCANNER_404_RATE_LIMIT } from '@/lib/constants';

/** File extensions that are never valid page slugs and are classic scanner targets. */
const DANGEROUS_EXTENSIONS = new Set([
  '.php', '.asp', '.aspx', '.jsp', '.jspx', '.cgi', '.pl', '.sh', '.bat', '.cmd',
  '.env', '.git', '.svn', '.hg', '.bak', '.old', '.tmp', '.swp',
  '.sql', '.dump', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.log', '.ini', '.conf', '.yml', '.yaml', '.pem', '.key', '.cer', '.crt', '.pfx',
  '.htaccess', '.htpasswd', '.ds_store',
]);

/**
 * True when the path cannot be a legitimate route in this system:
 * - multi-segment paths (no built-in route has more than one segment under
 *   default permalinks; custom permalink patterns are matched before this
 *   check runs in the middleware),
 * - single-segment paths ending in a dangerous extension (.php, .env, …),
 * - single-segment dotfiles (/.git, /.env, …).
 */
export function isScannerPath(path: string): boolean {
  const rest = path.slice(1); // strip leading '/'
  if (!rest) return false;
  if (rest.includes('/')) return true; // multi-segment
  const lower = rest.toLowerCase();
  if (lower.startsWith('.')) return true; // dotfile (/.env, /.git, …)
  const dot = lower.lastIndexOf('.');
  if (dot > 0 && DANGEROUS_EXTENSIONS.has(lower.slice(dot))) return true;
  return false;
}

/** Minimal 404 body served for scanner paths — no theme render, no DB. */
export const FAST_404_HTML = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
  '<meta name="robots" content="noindex"><title>404 Not Found</title></head>',
  '<body><h1>404</h1><p>页面不存在</p></body></html>',
].join('');

/**
 * True when the client has exceeded the scanner 404 rate limit and should
 * be rejected. In-isolate sliding window (same mechanism as upload and
 * forgot-password rate limits); a distributed scan across PoPs needs a
 * platform-level rule.
 */
export function shouldRateLimitScanner(ip: string, now = Date.now()): boolean {
  return !trackSlidingWindow(ip || 'unknown', SCANNER_404_RATE_LIMIT, now);
}

/** Negative-cache TTL for page slugs that don't exist (ms). */
const NEGATIVE_SLUG_TTL_MS = 30_000;
const NEGATIVE_SLUG_MAX_ENTRIES = 10_000;

const missingSlugs = new Map<string, number>(); // slug -> expiresAt

/**
 * True when this slug was recently resolved to "no page exists" — the
 * [slug].astro route can skip the typecho_contents lookup entirely.
 */
export function isKnownMissingSlug(slug: string, now = Date.now()): boolean {
  const expiresAt = missingSlugs.get(slug);
  if (expiresAt === undefined) return false;
  if (now > expiresAt) {
    missingSlugs.delete(slug);
    return false;
  }
  return true;
}

/** Record that a page slug does not exist. Bounded, short-lived, in-isolate. */
export function markSlugMissing(slug: string, now = Date.now()): void {
  if (missingSlugs.has(slug)) return;
  if (missingSlugs.size >= NEGATIVE_SLUG_MAX_ENTRIES) {
    // Evict expired entries first; if still full, drop the oldest.
    for (const [key, expiresAt] of missingSlugs) {
      if (now > expiresAt) missingSlugs.delete(key);
    }
    if (missingSlugs.size >= NEGATIVE_SLUG_MAX_ENTRIES) {
      const oldest = missingSlugs.keys().next().value;
      if (oldest !== undefined) missingSlugs.delete(oldest);
    }
  }
  missingSlugs.set(slug, now + NEGATIVE_SLUG_TTL_MS);
}

/** Test-only: clear in-isolate state. */
export function resetScannerProtectionForTests(): void {
  missingSlugs.clear();
}
