/**
 * Edge cache utilities using Cloudflare Workers Cache API (caches.default).
 *
 * - No extra bindings or dependencies needed.
 * - Per-PoP cache: cache.delete() only clears the current edge node.
 * - Logged-in users bypass cache entirely (ensured in middleware).
 *
 * Cross-PoP consistency for the options cache: the cache key embeds a
 * version stamp read from D1. bumpCacheVersion() advances the stamp so
 * every PoP naturally misses on its next read, no purge required.
 */

import { eq, and, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { OPTIONS_CACHE_TTL_SECONDS } from '@/lib/constants';
import { advanceOptionsSnapshotGeneration } from '@/lib/options-snapshot-generation';
import { notifyEarlyRequestInvalidation } from '@/lib/early-request';

export type PublicCacheDomain = 'home' | 'post' | 'page' | 'note' | 'archive' | 'other';
export type SharedCacheDomain = 'options' | 'navigation' | 'sidebar' | 'metas';

export interface PublicCacheInvalidation {
  reason: string;
  domains: PublicCacheDomain[] | ['all'];
  /** Stable server-side datasets cached independently from rendered HTML. */
  sharedDomains?: SharedCacheDomain[] | ['all'];
  /** Option values that an early provider may need before the next D1 bootstrap. */
  options?: Record<string, unknown>;
}

/** Internal namespace used for Cache API keys that are not real URLs */
const INTERNAL_ORIGIN = 'https://typecho-cf-internal';

function optionsCacheKey(version: string | number): Request {
  return new Request(`${INTERNAL_ORIGIN}/__options?v=${encodeURIComponent(String(version))}`);
}

// In-memory cache-version memo (per isolate). Cross-PoP invalidation of
// the options blob is bounded by CACHE_VERSION_MEMO_TTL_MS: a bump made
// on PoP-A takes at most this long to be seen on PoP-B. In exchange we
// avoid a D1 read on every loadOptions() call — worth the small
// staleness for read-heavy endpoints.
const CACHE_VERSION_MEMO_TTL_MS = 60_000;
let cachedVersion: string | null = null;
let cachedVersionAt = 0;

async function readCacheVersion(db: Database, now = Date.now()): Promise<string> {
  if (cachedVersion !== null && now - cachedVersionAt < CACHE_VERSION_MEMO_TTL_MS) {
    return cachedVersion;
  }
  const row = await db.query.options.findFirst({
    where: and(eq(schema.options.name, 'cacheVersion'), eq(schema.options.user, 0)),
  });
  cachedVersion = row?.value ?? '0';
  cachedVersionAt = now;
  return cachedVersion;
}

/** Test-only: reset the in-memory version memo so unit tests start fresh. */
export function resetCacheVersionMemo(): void {
  cachedVersion = null;
  cachedVersionAt = 0;
}

/**
 * Purge a list of public URLs from the edge cache.
 * Safe to call with empty array — returns immediately.
 * Relative URLs are skipped gracefully (no-op).
 */
export async function purgeCache(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const cache = caches.default;
  await Promise.all(urls.map(async (url) => {
    try {
      // Only try to purge absolute URLs (skip relative paths)
      if (url.startsWith('http://') || url.startsWith('https://')) {
        await cache.delete(new Request(url));
      }
    } catch {
      // Silently ignore errors (e.g., invalid URLs)
    }
  }));
}

/**
 * Purge the cached site options. Kept for legacy call sites; the version-
 * stamped cache key makes explicit purge redundant, but purging the
 * current-PoP entry costs nothing extra.
 */
export async function purgeOptionsCache(): Promise<void> {
  // No longer strictly necessary — the version stamp on the cache key
  // means bumpCacheVersion() makes every PoP miss on the next read. Kept
  // as a defensive no-op so old call sites still compile.
}

async function writeCacheVersion(db: Database): Promise<void> {
  const [updated] = await db.insert(schema.options)
    .values({ name: 'cacheVersion', user: 0, value: '1' })
    .onConflictDoUpdate({
      target: [schema.options.name, schema.options.user],
      set: {
        value: sql`cast(coalesce(${schema.options.value}, '0') as integer) + 1`,
      },
    })
    .returning({ value: schema.options.value });
  const stamp = updated?.value ?? '1';
  // Best-effort local memo update so the writer sees its own bump on
  // subsequent reads within the same isolate (other PoPs will refresh
  // after their memo expires — see CACHE_VERSION_MEMO_TTL_MS).
  cachedVersion = stamp;
  cachedVersionAt = Date.now();
  advanceOptionsSnapshotGeneration(db);
}

export async function bumpCacheVersion(
  db: Database,
  event: PublicCacheInvalidation = { reason: 'options', domains: ['all'], sharedDomains: ['all'] },
): Promise<void> {
  await writeCacheVersion(db);
  await notifyEarlyRequestInvalidation(event);
}

/**
 * Invalidate public HTML through the activated page-cache provider. With no
 * provider, there is no page cache to invalidate and no D1 write is needed.
 */
export async function invalidatePublicCache(
  _db: Database,
  event: PublicCacheInvalidation,
): Promise<'early' | 'none'> {
  if (await notifyEarlyRequestInvalidation(event)) return 'early';
  return 'none';
}

/**
 * Try to read cached options JSON, keyed by the current cacheVersion.
 * The version is memoized in-isolate for a short TTL so we don't hit D1
 * on every loadOptions() call. Cross-PoP writes become visible within
 * CACHE_VERSION_MEMO_TTL_MS.
 */
export async function getCachedOptions(db: Database): Promise<Record<string, unknown> | null> {
  const version = await readCacheVersion(db);
  const cache = caches.default;
  const res = await cache.match(optionsCacheKey(version));
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Write options JSON to cache under the current version stamp.
 * Callers must pass the version they read so a subsequent bump in
 * another PoP doesn't leave a stale entry under a fresh key.
 */
export async function setCachedOptions(data: Record<string, unknown>, version: string | number): Promise<void> {
  const cache = caches.default;
  const res = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${OPTIONS_CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(optionsCacheKey(version), res);
}

/**
 * Build a list of URLs that should be purged after a content write operation.
 * Covers index, feed, and the specific post page.
 */
export interface ContentPurgeUrlsOptions {
  contentUrl?: string | null;
  categoryUrls?: Array<string | null | undefined>;
  tagUrls?: Array<string | null | undefined>;
  authorUrl?: string | null;
}

export function buildContentPurgeUrls(
  siteUrl: string,
  cid?: number,
  related: ContentPurgeUrlsOptions = {},
): string[] {
  const base = siteUrl.replace(/\/$/, '');
  
  // Skip if siteUrl is empty or not an absolute URL (test environment)
  if (!base || !base.startsWith('http')) {
    return [];
  }
  
  const urls = [
    base + '/',
    base + '/feed',
    base + '/feed/atom',
    base + '/feed/rss',
    base + '/feed/comments',
    base + '/feed/rss/comments',
    base + '/feed/atom/comments',
  ];
  if (cid) {
    urls.push(base + `/archives/${cid}/`);
  }
  if (related.contentUrl) urls.push(related.contentUrl);
  if (related.authorUrl) urls.push(related.authorUrl);
  for (const url of related.categoryUrls || []) {
    if (url) urls.push(url);
  }
  for (const url of related.tagUrls || []) {
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

/**
 * Purge content-related cache entries (index + feeds + specific post).
 * Does NOT purge the options cache — use purgeSiteCache for settings changes.
 */
export async function purgeContentCache(
  _siteUrl: string,
  _cid?: number,
  _related: ContentPurgeUrlsOptions = {},
): Promise<void> {
  // Public page keys include cacheVersion. Every caller bumps that version
  // before reaching this compatibility function, so deleting raw URLs cannot
  // hit the stored keys and only adds Cache API work to the write path.
}

/**
 * Purge site-wide cache: index + all feeds + options.
 * Used when site settings, theme, or plugin change.
 */
export async function purgeSiteCache(_siteUrl: string): Promise<void> {
  // Kept for plugin/source compatibility. The preceding cacheVersion bump
  // invalidates page and options keys across every PoP.
}
