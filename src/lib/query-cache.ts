import type { RequestContext } from '@/lib/context';
import type { SharedCacheDomain } from '@/lib/cache';
import { loadEarlyRequestSharedData, notifyEarlyRequestInvalidation } from '@/lib/early-request';

export type QueryCacheDomain = Extract<SharedCacheDomain,
  | 'archive'
  | 'content'
  | 'notes'
  | 'admin-dashboard'
  | 'admin-content'
  | 'admin-comments'
  | 'admin-metas'
  | 'admin-media'
  | 'admin-users'
  | 'admin-options'>;

export interface QueryCacheOptions {
  domain: QueryCacheDomain;
  /** A stable, non-secret representation of the query inputs. */
  key: unknown;
  /** User-scoped entries are derived from an already validated RequestContext. */
  scope?: 'public' | 'viewer';
}

function stableSerialize(value: unknown, stack = new Set<object>()): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Query cache keys require finite numbers');
      return String(value);
    case 'string': return JSON.stringify(value);
    case 'undefined': return 'undefined';
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item, stack)).join(',')}]`;
      if (stack.has(value)) throw new TypeError('Query cache keys cannot be circular');
      stack.add(value);
      const record = value as Record<string, unknown>;
      const serialized = `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key], stack)}`).join(',')}}`;
      stack.delete(value);
      return serialized;
    }
    default:
      throw new TypeError('Query cache keys must be JSON-like values');
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function viewerScope(ctx: RequestContext): Promise<string> {
  const user = ctx.user;
  if (!ctx.isLoggedIn || !user?.authCode) {
    throw new Error('Viewer-scoped query caching requires a validated user');
  }
  return sha256(`typecho:query-cache:v1:viewer\0${user.uid}\0${user.group || 'visitor'}\0${user.authCode}`);
}

/**
 * Cache a read-model result through L0 -> configured provider -> loader.
 * Remote keys are hashes only, so neither request parameters nor credentials
 * become visible in KV or D1 cache keys.
 */
export async function loadQueryCache<T>(
  ctx: RequestContext,
  options: QueryCacheOptions,
  loader: () => Promise<T>,
): Promise<T> {
  const scope = options.scope || 'public';
  const input = stableSerialize(options.key);
  if (input.length > 512) return loader();
  const viewer = scope === 'viewer' ? await viewerScope(ctx) : 'public';
  const key = await sha256(`typecho:query-cache:v1\0${options.domain}\0${viewer}\0${input}`);
  return loadEarlyRequestSharedData(options.domain, `query:${scope}:${key}`, async () => loader(), ctx.db as object);
}

/** Invalidate cached read models without also purging rendered page HTML. */
export async function invalidateQueryCache(
  domains: QueryCacheDomain[] | ['all'],
  reason = 'query-cache',
): Promise<void> {
  await notifyEarlyRequestInvalidation({ reason, domains: [], sharedDomains: domains });
}
