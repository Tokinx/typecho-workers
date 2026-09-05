import type {
  EarlyRequestContext,
  EarlyRequestLifecycleEvent,
  EarlyRequestNext,
  EarlyRequestProvider,
  EarlyRequestSyncContext,
  SharedDataRead,
} from '@/lib/early-request';
import type { PublicCacheDomain, PublicCacheInvalidation, SharedCacheDomain } from '@/lib/cache';
import { CACHE_WARMUP_HEADER, PUBLIC_HTML_HEADER } from '@/lib/cache';
import { env } from 'cloudflare:workers';
import { compilePermalinkPattern, type PermalinkPatternKind } from '@/lib/permalink-pattern';
import { parsePluginOption } from '@/lib/plugin';

export { PUBLIC_HTML_HEADER } from '@/lib/cache';

export const CACHE_PLUGIN_ID = 'typecho-plugin-cache';
export const CACHE_CONTROL_KEY = 'typecho:edge-cache:v1:control';
/** KV key recording the last manual refresh performed from the cache admin page. */
export const LAST_REFRESH_KEY = 'typecho:edge-cache:v1:meta:last-refresh';
const GENERATION_PREFIX = 'typecho:edge-cache:v1:g:';
const PAGE_PREFIX = 'typecho:edge-cache:v1:p:';
const SHARED_GENERATION_PREFIX = 'typecho:edge-cache:v1:sg:';
const SHARED_DATA_PREFIX = 'typecho:edge-cache:v1:s:';
const D1_DATA_GENERATION_PREFIX = 'typecho:edge-cache:v2:dg:';
const D1_DATA_PREFIX = 'typecho:edge-cache:v2:d:';
const L1_ORIGIN = 'https://typecho-cache.internal';
const CONTROL_MEMO_TTL_MS = 5_000;
const GENERATION_MEMO_TTL_MS = 5_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const D1_GENERATION_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
const D1_CLEANUP_INTERVAL_MS = 5 * 60_000;
const VIEWER_QUERY_PREFIX = 'query:viewer:';
const DATA_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SHARED_DATA_TTL_SECONDS: Record<SharedCacheDomain, number> = {
  options: DATA_CACHE_TTL_SECONDS,
  navigation: DATA_CACHE_TTL_SECONDS,
  sidebar: DATA_CACHE_TTL_SECONDS,
  metas: DATA_CACHE_TTL_SECONDS,
  comments: DATA_CACHE_TTL_SECONDS,
  notes: DATA_CACHE_TTL_SECONDS,
  archive: DATA_CACHE_TTL_SECONDS,
  content: DATA_CACHE_TTL_SECONDS,
  'admin-dashboard': DATA_CACHE_TTL_SECONDS,
  'admin-content': DATA_CACHE_TTL_SECONDS,
  'admin-comments': DATA_CACHE_TTL_SECONDS,
  'admin-metas': DATA_CACHE_TTL_SECONDS,
  'admin-media': DATA_CACHE_TTL_SECONDS,
  'admin-users': DATA_CACHE_TTL_SECONDS,
  'admin-options': DATA_CACHE_TTL_SECONDS,
};
const ALL_DOMAINS: PublicCacheDomain[] = ['home', 'post', 'page', 'note', 'archive', 'other'];
const DETAIL_DOMAINS = new Set<PublicCacheDomain>(['post', 'page', 'note']);
export const DATA_CACHE_DOMAINS: SharedCacheDomain[] = [
  'options', 'navigation', 'sidebar', 'metas', 'comments', 'notes', 'archive', 'content',
  'admin-dashboard', 'admin-content', 'admin-comments', 'admin-metas', 'admin-media',
  'admin-users', 'admin-options',
];
export const FRONTEND_DATA_CACHE_DOMAINS = new Set<SharedCacheDomain>([
  'options', 'navigation', 'sidebar', 'metas', 'comments', 'notes', 'archive', 'content',
]);
export const ADMIN_DATA_CACHE_DOMAINS = new Set<SharedCacheDomain>([
  'admin-dashboard', 'admin-content', 'admin-comments', 'admin-metas', 'admin-media',
  'admin-users', 'admin-options',
]);
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid',
  'ref', 'source', 'from',
  'mc_cid', 'mc_eid',
]);
const NO_CACHE_CONTROL = 'no-store, no-cache, must-revalidate';
// Platform layer (Workers Caching) headers. @astrojs/cloudflare appends
// `Cloudflare-CDN-Cache-Control: no-store` to responses that lack this header,
// so only pages that explicitly set it are absorbed by the platform cache.
const PLATFORM_CACHE_HEADER = 'Cloudflare-CDN-Cache-Control';
const CACHE_TAG_HEADER = 'Cache-Tag';
const PLATFORM_TAG_PREFIX = 'tc:';
/** Set alongside `X-Typecho-Cache: BYPASS` so curl / logs can classify avoidable bypasses. */
export const CACHE_BYPASS_REASON_HEADER = 'X-Typecho-Cache-Bypass';

export type BypassReason =
  | 'authorization'
  | 'cache-control'
  | 'unsafe-query'
  | 'domain-disabled'
  | 'ttl-zero'
  | 'unapproved-comment'
  | 'uncacheable'
  | 'kv-missing'
  | 'control-missing'
  | 'lookup-failed';
const L1_TTL_OPTIONS = [0, 3_600, 43_200, 86_400, 259_200, 604_800, 2_592_000];
const L2_TTL_OPTIONS = [0, 86_400, 259_200, 604_800];
const L3_TTL_OPTIONS = [0, 300, 3_600, 21_600, 43_200, 86_400];

export interface CachePluginConfig {
  cacheScopes: PublicCacheDomain[];
  l1Ttl: number;
  l2Ttl: number;
  l3Ttl: number;
  frontendDataCacheBackend: DataCacheBackend;
  adminDataCacheBackend: DataCacheBackend;
  /** Preserves the retired per-domain configuration until it is saved again. */
  legacyDataCacheBackends?: DataCacheBackendSetting[];
  staticCdnUrl: string;
  staticExtensions: string[];
  avatarCdnUrl: string;
}

export type DataCacheBackend = 'kv' | 'd1' | 'none';
export interface DataCacheBackendSetting {
  domain: SharedCacheDomain;
  backend: DataCacheBackend;
}

export interface CacheControlDocument {
  active: true;
  config: CachePluginConfig;
  options: {
    siteUrl: string;
    permalinkPattern: string;
    pagePattern: string;
    categoryPattern: string;
  };
}

interface StoredResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

type Memo<T> = { value: T; expiresAt: number };
let controlMemo: Memo<CacheControlDocument | null> | null = null;
const generationMemo = new Map<string, Memo<string>>();
const inFlight = new Map<string, Promise<Response>>();
let runtimeConfig: CachePluginConfig | null = null;
let requestRuntime = new WeakMap<Request, CacheControlDocument | null>();
let lastD1CleanupAt = 0;

function asKv(value: unknown): KVNamespace | null {
  const candidate = value as Partial<KVNamespace> | null | undefined;
  return candidate && typeof candidate.get === 'function' && typeof candidate.put === 'function'
    ? candidate as KVNamespace
    : null;
}

function runtimeKv(): KVNamespace | null {
  return asKv(env.TYPECHO_CACHE);
}

function asD1(value: unknown): D1Database | null {
  const candidate = value as Partial<D1Database> | null | undefined;
  return candidate && typeof candidate.prepare === 'function' ? candidate as D1Database : null;
}

function runtimeD1(): D1Database | null {
  return asD1(env.DB);
}

function d1Binding(context: EarlyRequestContext): D1Database | null {
  return asD1(context.env.DB);
}

function normalizeUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CDN URL 必须是无凭据、查询串和片段的 HTTP(S) URL');
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeExtensions(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,.\s]+/);
  return [...new Set(values
    .map(item => String(item).trim().replace(/^\./, '').toLowerCase())
    .filter(item => /^[a-z0-9][a-z0-9_-]{0,15}$/.test(item)))];
}

function normalizeDataCacheBackend(value: unknown, label: string): DataCacheBackend {
  if (value === undefined || value === null || value === '') return 'kv';
  if (value === 'kv' || value === 'd1' || value === 'none') return value;
  throw new Error(`${label}无效`);
}

function normalizeLegacyDataCacheBackends(value: unknown): DataCacheBackendSetting[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Array.isArray(value)) throw new Error('数据缓存后端配置无效');

  const seen = new Set<SharedCacheDomain>();
  const settings: DataCacheBackendSetting[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('数据缓存后端配置无效');
    const domain = String((raw as Record<string, unknown>).domain || '') as SharedCacheDomain;
    const backend = String((raw as Record<string, unknown>).backend || '') as DataCacheBackend;
    if (!DATA_CACHE_DOMAINS.includes(domain)) throw new Error('数据缓存域无效');
    if (backend !== 'kv' && backend !== 'd1' && backend !== 'none') throw new Error('数据缓存后端无效');
    if (seen.has(domain)) throw new Error('数据缓存域不能重复');
    seen.add(domain);
    settings.push({ domain, backend });
  }
  return settings;
}

function ttl(value: unknown, allowed: number[], fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return allowed.includes(parsed) ? parsed : fallback;
}

export function normalizeCacheConfig(settings: Record<string, unknown> | CachePluginConfig): CachePluginConfig {
  const requestedScopes = Array.isArray(settings.cacheScopes) ? settings.cacheScopes : ALL_DOMAINS;
  const cacheScopes = ALL_DOMAINS.filter(domain => requestedScopes.includes(domain));
  const legacyDataCacheBackends = normalizeLegacyDataCacheBackends(
    settings.legacyDataCacheBackends ?? (settings as Record<string, unknown>).dataCacheBackends,
  );
  return {
    cacheScopes,
    l1Ttl: ttl(settings.l1Ttl, L1_TTL_OPTIONS, 604_800),
    l2Ttl: ttl(settings.l2Ttl, L2_TTL_OPTIONS, 259_200),
    l3Ttl: ttl(settings.l3Ttl, L3_TTL_OPTIONS, 21_600),
    frontendDataCacheBackend: normalizeDataCacheBackend(settings.frontendDataCacheBackend, '前台数据缓存后端'),
    adminDataCacheBackend: normalizeDataCacheBackend(settings.adminDataCacheBackend, '后台数据缓存后端'),
    ...(legacyDataCacheBackends?.length ? { legacyDataCacheBackends } : {}),
    staticCdnUrl: normalizeUrl(settings.staticCdnUrl),
    staticExtensions: normalizeExtensions(settings.staticExtensions),
    avatarCdnUrl: normalizeUrl(settings.avatarCdnUrl),
  };
}

function dataCacheBackend(config: CachePluginConfig, domain: SharedCacheDomain): DataCacheBackend {
  const legacyBackend = config.legacyDataCacheBackends?.find(item => item.domain === domain)?.backend;
  if (legacyBackend) return legacyBackend;
  if (FRONTEND_DATA_CACHE_DOMAINS.has(domain)) return config.frontendDataCacheBackend;
  if (ADMIN_DATA_CACHE_DOMAINS.has(domain)) return config.adminDataCacheBackend;
  return 'kv';
}

function dataCacheTtl(domain: SharedCacheDomain, key: string): number {
  return key.startsWith(VIEWER_QUERY_PREFIX)
    ? DATA_CACHE_TTL_SECONDS
    : SHARED_DATA_TTL_SECONDS[domain];
}

export function setCacheRuntimeConfig(settings: Record<string, unknown> | CachePluginConfig): CachePluginConfig {
  runtimeConfig = normalizeCacheConfig(settings);
  return runtimeConfig;
}

export function getCacheRuntimeConfig(): CachePluginConfig {
  return runtimeConfig || normalizeCacheConfig({});
}

function optionsForControl(options: Record<string, unknown> = {}): CacheControlDocument['options'] {
  return {
    siteUrl: String(options.siteUrl || ''),
    permalinkPattern: String(options.permalinkPattern || '/archives/{cid}/'),
    pagePattern: String(options.pagePattern || '/{slug}.html'),
    categoryPattern: String(options.categoryPattern || '/category/{slug}/'),
  };
}

export function buildControlDocument(
  settings: Record<string, unknown>,
  options: Record<string, unknown> = {},
): CacheControlDocument {
  return { active: true, config: normalizeCacheConfig(settings), options: optionsForControl(options) };
}

async function loadControl(kv: KVNamespace): Promise<CacheControlDocument | null> {
  const now = Date.now();
  if (controlMemo && controlMemo.expiresAt > now) return controlMemo.value;
  const value = await kv.get<CacheControlDocument>(CACHE_CONTROL_KEY, { type: 'json', cacheTtl: 60 });
  let control: CacheControlDocument | null = null;
  if (value?.active === true && value.config && value.options) {
    try {
      control = {
        active: true,
        config: normalizeCacheConfig(value.config),
        options: optionsForControl(value.options),
      };
      runtimeConfig = control.config;
    } catch {
      control = null;
    }
  }
  controlMemo = { value: control, expiresAt: now + CONTROL_MEMO_TTL_MS };
  return control;
}

async function writeControl(kv: KVNamespace, control: CacheControlDocument): Promise<void> {
  await kv.put(CACHE_CONTROL_KEY, JSON.stringify(control));
  controlMemo = { value: control, expiresAt: Date.now() + CONTROL_MEMO_TTL_MS };
  runtimeConfig = control.config;
}

async function generation(kv: KVNamespace, domain: PublicCacheDomain | 'all'): Promise<string> {
  const key = `${GENERATION_PREFIX}${domain}`;
  const now = Date.now();
  const memo = generationMemo.get(key);
  if (memo && memo.expiresAt > now) return memo.value;
  // Same write-often rationale as sharedGeneration: the location-level read
  // cache must stay at the 30s platform minimum so content updates become
  // visible across PoPs within ~30s instead of 60s.
  const value = await kv.get(key, { type: 'text', cacheTtl: 30 }) || '0';
  generationMemo.set(key, { value, expiresAt: now + GENERATION_MEMO_TTL_MS });
  return value;
}

async function sharedGeneration(kv: KVNamespace, domain: SharedCacheDomain): Promise<string> {
  const key = `${SHARED_GENERATION_PREFIX}${domain}`;
  const now = Date.now();
  const memo = generationMemo.get(key);
  if (memo && memo.expiresAt > now) return memo.value;
  // Generation keys change on every invalidation. cacheTtl caches the read
  // at the accessed location, so a bump made elsewhere would stay invisible
  // until the cached read expires — keep it at the platform minimum (30s)
  // to bound that window; the per-isolate memo already limits read rate.
  const value = await kv.get(key, { type: 'text', cacheTtl: 30 }) || '0';
  generationMemo.set(key, { value, expiresAt: now + GENERATION_MEMO_TTL_MS });
  return value;
}

async function sharedGenerationD1(d1: D1Database, domain: SharedCacheDomain): Promise<string> {
  const key = `d1:${domain}`;
  const now = Date.now();
  const memo = generationMemo.get(key);
  if (memo && memo.expiresAt > now) return memo.value;
  const value = await readD1Value(d1, `${D1_DATA_GENERATION_PREFIX}${domain}`) || '0';
  generationMemo.set(key, { value, expiresAt: now + GENERATION_MEMO_TTL_MS });
  return value;
}

function nextGeneration(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

export async function invalidateDomains(
  kv: KVNamespace,
  domains: PublicCacheDomain[] | ['all'],
): Promise<void> {
  const targets: Array<PublicCacheDomain | 'all'> = domains[0] === 'all' ? ['all'] : [...new Set(domains)];
  await Promise.all(targets.map(async domain => {
    const key = `${GENERATION_PREFIX}${domain}`;
    const value = nextGeneration();
    await kv.put(key, value);
    generationMemo.set(key, { value, expiresAt: Date.now() + GENERATION_MEMO_TTL_MS });
  }));
}

export async function invalidateSharedDomains(
  kv: KVNamespace,
  domains: SharedCacheDomain[] | ['all'],
): Promise<void> {
  const targets = domains[0] === 'all' ? DATA_CACHE_DOMAINS : [...new Set(domains)];
  await Promise.all(targets.map(async domain => {
    const key = `${SHARED_GENERATION_PREFIX}${domain}`;
    const value = nextGeneration();
    await kv.put(key, value);
    generationMemo.set(key, { value, expiresAt: Date.now() + GENERATION_MEMO_TTL_MS });
  }));
}

/**
 * Purge the platform layer (Workers Caching) by tag. Tags are attached to
 * cacheable page responses via Cache-Tag in withCacheHeader. The purge is
 * global and immediate; KV/D1 generations are advanced separately by the
 * callers, so a failure here only delays (never corrupts) invalidation.
 */
async function purgePlatformCache(tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  try {
    const { cache } = await import('cloudflare:workers');
    await cache.purge({ tags });
  } catch (error) {
    console.error('[edge-cache] Platform cache purge failed:', error);
  }
}

function platformTagsForDomains(domains: PublicCacheDomain[] | ['all']): string[] {
  return domains[0] === 'all'
    ? [`${PLATFORM_TAG_PREFIX}all`]
    : [...new Set(domains)].map(domain => `${PLATFORM_TAG_PREFIX}${domain}`);
}

async function invalidateSharedDomainsD1(
  d1: D1Database,
  domains: SharedCacheDomain[] | ['all'],
): Promise<void> {
  const targets = domains[0] === 'all' ? DATA_CACHE_DOMAINS : [...new Set(domains)];
  await Promise.all(targets.map(async domain => {
    const value = nextGeneration();
    await writeD1Value(d1, `${D1_DATA_GENERATION_PREFIX}${domain}`, value, D1_GENERATION_TTL_SECONDS);
    generationMemo.set(`d1:${domain}`, { value, expiresAt: Date.now() + GENERATION_MEMO_TTL_MS });
  }));
}

async function dataCacheConfig(): Promise<CachePluginConfig | null> {
  if (runtimeConfig) return runtimeConfig;
  const kv = runtimeKv();
  if (kv) {
    const control = await loadControl(kv);
    if (control) return control.config;
  }
  // Query-cache callers are reached only after the plugin's active runtime
  // sync in normal requests. This fallback keeps explicit invalidation safe
  // during first-isolate setup and treats omitted backend entries as KV.
  return normalizeCacheConfig({});
}

async function invalidateConfiguredDataDomains(
  domains: SharedCacheDomain[] | ['all'],
  config?: CachePluginConfig | null,
): Promise<boolean> {
  const resolvedConfig = config === undefined ? await dataCacheConfig() : config;
  if (!resolvedConfig) return false;
  const targets: SharedCacheDomain[] = domains[0] === 'all'
    ? DATA_CACHE_DOMAINS
    : [...new Set(domains as SharedCacheDomain[])];
  const kvTargets = targets.filter(domain => dataCacheBackend(resolvedConfig, domain) === 'kv');
  const d1Targets = targets.filter(domain => dataCacheBackend(resolvedConfig, domain) === 'd1');
  const kv = runtimeKv();
  const d1 = runtimeD1();
  await Promise.all([
    kv && kvTargets.length ? invalidateSharedDomains(kv, kvTargets) : Promise.resolve(),
    d1 && d1Targets.length ? invalidateSharedDomainsD1(d1, d1Targets) : Promise.resolve(),
  ]);
  return Boolean((kv && kvTargets.length) || (d1 && d1Targets.length));
}

async function invalidateAllDataStores(): Promise<void> {
  const kv = runtimeKv();
  const d1 = runtimeD1();
  const writes = [
    kv ? invalidateSharedDomains(kv, ['all']) : null,
    d1 ? invalidateSharedDomainsD1(d1, ['all']) : null,
  ].filter((write): write is Promise<void> => write !== null);
  const results = await Promise.allSettled(writes);
  for (const result of results) {
    if (result.status === 'rejected') {
      // A cache backend is an optimization. Lifecycle/config changes remain
      // usable while an optional KV/D1 store is temporarily unavailable.
      console.error('[edge-cache] Data cache invalidation failed:', result.reason);
    }
  }
}

async function readSharedData<T>(domain: SharedCacheDomain, key: string): Promise<SharedDataRead<T>> {
  const config = await dataCacheConfig();
  if (!config) return { handled: false, value: null };
  const backend = dataCacheBackend(config, domain);
  if (backend === 'none') return { handled: true, value: null, source: 'BYPASS' };
  const keyHash = await sha256(key);
  if (backend === 'd1') {
    const d1 = runtimeD1();
    if (!d1) return { handled: false, value: null };
    const generationValue = await sharedGenerationD1(d1, domain);
    const raw = await readD1Value(d1, `${D1_DATA_PREFIX}${domain}:${generationValue}:${keyHash}`);
    if (!raw) return { handled: true, value: null };
    try {
      return { handled: true, value: JSON.parse(raw) as T, source: 'D1' };
    } catch {
      return { handled: true, value: null };
    }
  }

  const kv = runtimeKv();
  if (!kv) return { handled: false, value: null };
  const generationValue = await sharedGeneration(kv, domain);
  const value = await kv.get<T>(`${SHARED_DATA_PREFIX}${domain}:${generationValue}:${keyHash}`, {
      type: 'json',
      cacheTtl: 60,
    });
  return { handled: true, value, source: value === null ? undefined : 'KV' };
}

async function writeSharedData<T>(domain: SharedCacheDomain, key: string, value: T): Promise<boolean> {
  const config = await dataCacheConfig();
  if (!config) return false;
  const backend = dataCacheBackend(config, domain);
  if (backend === 'none') return false;
  const keyHash = await sha256(key);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  if (serialized === undefined) return false;
  const ttlSeconds = dataCacheTtl(domain, key);
  if (backend === 'd1') {
    const d1 = runtimeD1();
    if (!d1) return false;
    const generationValue = await sharedGenerationD1(d1, domain);
    await writeD1Value(d1, `${D1_DATA_PREFIX}${domain}:${generationValue}:${keyHash}`, serialized, ttlSeconds);
    return true;
  }

  const kv = runtimeKv();
  if (!kv) return false;
  const generationValue = await sharedGeneration(kv, domain);
  await kv.put(
    `${SHARED_DATA_PREFIX}${domain}:${generationValue}:${keyHash}`,
    serialized,
    { expirationTtl: ttlSeconds },
  );
  return true;
}

function pathMatchesPattern(path: string, pattern: string, kind: PermalinkPatternKind): boolean {
  return compilePermalinkPattern(pattern, kind)?.test(path) ?? false;
}

export function classifyCacheDomain(path: string, control: CacheControlDocument): PublicCacheDomain {
  if (path === '/' || /^\/page\/\d+\/?$/.test(path)) return 'home';
  if (/^\/note\/\d+\/?$/.test(path)) return 'note';
  if (/^\/(category|tag|author|search)(\/|$)/.test(path)) return 'archive';
  const archivePath = path.replace(/\/page\/\d+\/?$/, '/');
  if (pathMatchesPattern(archivePath, control.options.categoryPattern, 'category')) return 'archive';
  if (/^\/archives\/\d+\/?$/.test(path) || pathMatchesPattern(path, control.options.permalinkPattern, 'post')) return 'post';
  if (pathMatchesPattern(path, control.options.pagePattern, 'page')) return 'page';
  return 'other';
}

function isTrackingParam(name: string): boolean {
  return name.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(name.toLowerCase());
}

export function normalizeCacheUrl(url: URL, domain: PublicCacheDomain): string | null {
  // Queryless URLs — the overwhelming majority of cache hits — skip the
  // defensive clone: nothing below mutates the URL when there is no query
  // to filter, and requests never carry a fragment.
  const normalized = url.search || url.hash ? new URL(url.toString()) : url;
  normalized.hash = '';
  const allowed = new Set<string>();
  if (domain === 'home') {
    allowed.add('stream');
    allowed.add('topic');
  }
  if (DETAIL_DOMAINS.has(domain)) allowed.add('commentPage');

  const kept: Array<[string, string]> = [];
  for (const [name, value] of normalized.searchParams) {
    if (name === '__typecho_cache' || isTrackingParam(name)) continue;
    if (name === 'password' || name === 'preview' || name === '_') return null;
    if (!allowed.has(name)) return null;
    if (name === 'commentPage' && !/^\d{1,6}$/.test(value)) return null;
    if (name === 'stream' && !['posts', 'notes', 'mixed'].includes(value)) return null;
    if (name === 'topic' && (!value || value.length > 100)) return null;
    kept.push([name, value]);
  }
  normalized.search = '';
  kept.sort(([aName, aValue], [bName, bValue]) => aName.localeCompare(bName) || aValue.localeCompare(bValue));
  for (const [name, value] of kept) normalized.searchParams.append(name, value);
  return normalized.toString();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const URL_HASH_MEMO_ENTRIES = 256;
const urlHashMemo = new Map<string, string>();

/**
 * SHA-256 of the normalized URL is half of every cache id, so hot pages
 * re-hash the same string on every hit. A small LRU keyed by the URL string
 * turns repeat visits into pure Map lookups.
 */
async function sha256WithMemo(value: string): Promise<string> {
  const cached = urlHashMemo.get(value);
  if (cached !== undefined) {
    // Refresh insertion order for LRU eviction.
    urlHashMemo.delete(value);
    urlHashMemo.set(value, cached);
    return cached;
  }
  const digest = await sha256(value);
  urlHashMemo.set(value, digest);
  if (urlHashMemo.size > URL_HASH_MEMO_ENTRIES) {
    const oldest = urlHashMemo.keys().next().value;
    if (oldest !== undefined) urlHashMemo.delete(oldest);
  }
  return digest;
}

function l1Request(key: string): Request {
  return new Request(`${L1_ORIGIN}/${key}`, { method: 'GET' });
}

function withCacheHeader(
  response: Response,
  value: 'L1' | 'L2' | 'L3' | 'MISS' | 'BYPASS',
  l1Ttl?: number,
  domain?: PublicCacheDomain,
  bypassReason?: BypassReason,
): Response {
  const headers = new Headers(response.headers);
  headers.delete(PUBLIC_HTML_HEADER);
  headers.set('X-Typecho-Cache', value);
  if (value === 'BYPASS' && bypassReason) {
    headers.set(CACHE_BYPASS_REASON_HEADER, bypassReason);
  } else {
    headers.delete(CACHE_BYPASS_REASON_HEADER);
  }
  if (value !== 'BYPASS' && l1Ttl && l1Ttl > 0 && domain) {
    // Platform layer (Workers Caching) absorbs this response at the edge with
    // the plugin's L1 TTL and tags it for bulk purge. Browsers still
    // revalidate on every visit so recent comments stay visible.
    headers.set('Cache-Control', 'public, max-age=0');
    headers.set(PLATFORM_CACHE_HEADER, `public, max-age=${l1Ttl}`);
    headers.set(CACHE_TAG_HEADER, `${PLATFORM_TAG_PREFIX}all, ${PLATFORM_TAG_PREFIX}${domain}`);
  } else {
    // The plugin does not cache this response, but the page's own cache
    // declarations are preserved (feed/sitemap/robots carry s-maxage and a
    // platform header). Only responses without any cache declaration get a
    // no-store fallback so bypassed pages (preview / password / pending
    // comment render) are never cached by any shared layer.
    const existingControl = headers.get('Cache-Control')?.toLowerCase() || '';
    const hasPlatformHeader = headers.has(PLATFORM_CACHE_HEADER);
    if (!hasPlatformHeader && (!existingControl || existingControl.includes('no-store'))) {
      headers.set('Cache-Control', NO_CACHE_CONTROL);
    }
    headers.delete(CACHE_TAG_HEADER);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function canCacheResponse(response: Response, requirePublicHtml = false): boolean {
  if (response.status !== 200) return false;
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) return false;
  if (requirePublicHtml && response.headers.get(PUBLIC_HTML_HEADER) !== '1') return false;
  if (response.headers.has('Set-Cookie') || response.headers.has('Content-Encoding')) return false;
  const cacheControl = response.headers.get('Cache-Control')?.toLowerCase() || '';
  if (cacheControl.includes('private') || cacheControl.includes('no-store')) return false;
  const vary = (response.headers.get('Vary') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return vary.every(value => value === 'cookie' || value === 'accept-encoding');
}

function responseHeadersForStorage(headers: Headers): Array<[string, string]> {
  const skipped = new Set([
    'set-cookie', 'content-length', 'content-encoding', 'transfer-encoding', 'connection',
    'x-typecho-cache', CACHE_BYPASS_REASON_HEADER.toLowerCase(), PUBLIC_HTML_HEADER.toLowerCase(),
  ]);
  return [...headers.entries()].filter(([name]) => !skipped.has(name.toLowerCase()));
}

function responseFromStoredForL1(stored: StoredResponse, l1Ttl: number): Response {
  const headers = new Headers(stored.headers);
  headers.set('Cache-Control', `public, max-age=0, s-maxage=${l1Ttl}`);
  headers.delete('X-Typecho-Cache');
  return new Response(stored.body, {
    status: stored.status,
    statusText: stored.statusText,
    headers,
  });
}

async function promoteStoredResponse(
  context: EarlyRequestContext,
  kv: KVNamespace,
  l1Key: Request,
  l2Key: string,
  stored: StoredResponse,
  l1Ttl: number,
  l2Ttl: number,
): Promise<void> {
  const writes: Promise<unknown>[] = [];
  if (l1Ttl > 0) writes.push(caches.default.put(l1Key, responseFromStoredForL1(stored, l1Ttl)));
  if (l2Ttl > 0) writes.push(kv.put(l2Key, JSON.stringify(stored), { expirationTtl: l2Ttl }));
  if (writes.length === 0) return;
  const pending = Promise.all(writes).catch(error => {
    console.error('[edge-cache] Cache promotion failed:', error);
  });
  if (context.waitUntil) context.waitUntil(pending);
  else await pending;
}

async function storeResponse(
  d1: D1Database | null,
  kv: KVNamespace,
  l1Key: Request,
  l2Key: string,
  response: Response,
  l1Ttl: number,
  l2Ttl: number,
  l3Ttl: number,
): Promise<void> {
  const writes: Promise<unknown>[] = [];
  let stored: StoredResponse | null = null;
  if (l2Ttl > 0 || (d1 && l3Ttl > 0)) {
    const body = await response.clone().text();
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    if (bodyBytes <= MAX_HTML_BYTES) {
      stored = {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeadersForStorage(response.headers),
        body,
      };
    }
  }
  if (l1Ttl > 0) {
    const l1Headers = new Headers(response.headers);
    l1Headers.delete('Set-Cookie');
    l1Headers.delete(PUBLIC_HTML_HEADER);
    l1Headers.set('Cache-Control', `public, max-age=0, s-maxage=${l1Ttl}`);
    l1Headers.delete('X-Typecho-Cache');
    const l1Response = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers: l1Headers,
    });
    writes.push(caches.default.put(l1Key, l1Response));
  }
  if (stored && l2Ttl > 0) {
    writes.push(kv.put(l2Key, JSON.stringify(stored), { expirationTtl: l2Ttl }));
  }
  if (stored && d1 && l3Ttl > 0) {
    writes.push(writeL3(d1, l2Key, stored, l3Ttl));
  }
  await Promise.all(writes);
}

function responseFromStored(stored: StoredResponse): Response | null {
  if (!stored || stored.status !== 200 || typeof stored.body !== 'string' || !Array.isArray(stored.headers)) return null;
  try {
    return new Response(stored.body, {
      status: stored.status,
      statusText: stored.statusText,
      headers: new Headers(stored.headers),
    });
  } catch {
    return null;
  }
}

interface D1CacheRow {
  value: string;
  expiresAt: number;
}

async function readD1Value(d1: D1Database, cacheKey: string): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await d1.prepare(
    'SELECT value, expiresAt FROM typecho_db_cache WHERE cacheKey = ? AND expiresAt > ? LIMIT 1',
  ).bind(cacheKey, now).first<D1CacheRow>();
  return row?.value || null;
}

async function writeD1Value(
  d1: D1Database,
  cacheKey: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const statements = [] as D1PreparedStatement[];
  if (Date.now() - lastD1CleanupAt >= D1_CLEANUP_INTERVAL_MS) {
    statements.push(d1.prepare('DELETE FROM typecho_db_cache WHERE expiresAt <= ?').bind(now));
    lastD1CleanupAt = Date.now();
  }
  statements.push(
    d1.prepare(
      'INSERT INTO typecho_db_cache (cacheKey, value, expiresAt) VALUES (?, ?, ?) ' +
      'ON CONFLICT(cacheKey) DO UPDATE SET value=excluded.value, expiresAt=excluded.expiresAt',
    ).bind(cacheKey, value, now + ttlSeconds),
  );
  await d1.batch(statements);
}

async function readL3(d1: D1Database, cacheKey: string): Promise<StoredResponse | null> {
  const value = await readD1Value(d1, cacheKey);
  if (!value) return null;
  try {
    return JSON.parse(value) as StoredResponse;
  } catch {
    return null;
  }
}

async function writeL3(
  d1: D1Database,
  cacheKey: string,
  stored: StoredResponse,
  ttlSeconds: number,
): Promise<void> {
  await writeD1Value(d1, cacheKey, JSON.stringify(stored), ttlSeconds);
}

/**
 * Physically delete expired rows from the D1 cache table. Normal writes only
 * sweep opportunistically (D1_CLEANUP_INTERVAL_MS), so this gives admins an
 * on-demand maintenance action. Returns the number of deleted rows.
 */
export async function compactD1Cache(d1: D1Database, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const result = await d1.prepare('DELETE FROM typecho_db_cache WHERE expiresAt <= ?').bind(now).run();
  return (result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0;
}

function joinCdnPath(base: URL, source: URL): string {
  const prefix = base.pathname.replace(/\/$/, '');
  base.pathname = `${prefix}${source.pathname.startsWith('/') ? source.pathname : `/${source.pathname}`}` || '/';
  base.search = source.search;
  base.hash = source.hash;
  return base.toString();
}

function joinAvatarCdnPath(base: URL, source: URL): string {
  const prefix = base.pathname.replace(/\/$/, '');
  const avatarPrefix = prefix.toLowerCase().endsWith('/avatar') ? '' : '/avatar';
  base.pathname = `${prefix}${avatarPrefix}${source.pathname.slice('/avatar'.length)}`;
  base.search = source.search;
  base.hash = source.hash;
  return base.toString();
}

function isGravatarHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'gravatar.com' || host.endsWith('.gravatar.com');
}

function isFrameworkInternalPath(pathname: string): boolean {
  return pathname.startsWith('/@')
    || pathname.startsWith('/__')
    || pathname.startsWith('/node_modules/');
}

export function rewriteResourceUrl(
  raw: string,
  config: CachePluginConfig,
  requestOrigin: string,
  siteUrl: string,
): string {
  const trimmed = raw.trim();
  if (!trimmed || /^(data:|blob:|mailto:|tel:|javascript:|#)/i.test(trimmed)) return raw;
  let source: URL;
  try {
    source = new URL(trimmed, requestOrigin);
  } catch {
    return raw;
  }

  if (config.avatarCdnUrl && isGravatarHost(source.hostname) && source.pathname.startsWith('/avatar/')) {
    return joinAvatarCdnPath(new URL(config.avatarCdnUrl), source);
  }

  if (!config.staticCdnUrl) return raw;
  if (isFrameworkInternalPath(source.pathname)) return raw;
  const siteOrigin = (() => {
    try { return new URL(siteUrl || requestOrigin).origin; } catch { return requestOrigin; }
  })();
  if (source.origin !== requestOrigin && source.origin !== siteOrigin) return raw;
  const extension = source.pathname.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase();
  if (!extension || !config.staticExtensions.includes(extension)) return raw;
  return joinCdnPath(new URL(config.staticCdnUrl), source);
}

function rewriteSrcset(value: string, rewrite: (url: string) => string): string {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const prefixStart = cursor;
    while (cursor < value.length && (value[cursor] === ',' || /\s/.test(value[cursor]))) cursor += 1;
    output += value.slice(prefixStart, cursor);
    if (cursor >= value.length) break;

    const urlStart = cursor;
    const isDataUrl = value.slice(cursor, cursor + 5).toLowerCase() === 'data:';
    while (
      cursor < value.length
      && !/\s/.test(value[cursor])
      && (isDataUrl || value[cursor] !== ',')
    ) cursor += 1;
    output += rewrite(value.slice(urlStart, cursor));

    const descriptorStart = cursor;
    while (cursor < value.length && value[cursor] !== ',') cursor += 1;
    output += value.slice(descriptorStart, cursor);
  }
  return output;
}

export function rewriteHtmlString(
  html: string,
  config: CachePluginConfig,
  requestOrigin: string,
  siteUrl: string,
): string {
  const rewrite = (value: string) => rewriteResourceUrl(value, config, requestOrigin, siteUrl);
  return html.replace(/\b(srcset|src|href|poster|data)\s*=\s*(["'])(.*?)\2/gi, (full, name, quote, value) => {
    const rewritten = String(name).toLowerCase() === 'srcset' ? rewriteSrcset(value, rewrite) : rewrite(value);
    return `${name}=${quote}${rewritten}${quote}`;
  });
}

async function rewriteHtmlResponse(
  response: Response,
  config: CachePluginConfig,
  requestOrigin: string,
  siteUrl: string,
): Promise<Response> {
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) return response;
  if (!config.staticCdnUrl && !config.avatarCdnUrl) return response;

  const rewrite = (value: string) => rewriteResourceUrl(value, config, requestOrigin, siteUrl);
  if (typeof HTMLRewriter !== 'undefined') {
    return new HTMLRewriter().on('*', {
      element(element) {
        for (const name of ['src', 'href', 'poster', 'data']) {
          const value = element.getAttribute(name);
          if (value !== null) element.setAttribute(name, rewrite(value));
        }
        const srcset = element.getAttribute('srcset');
        if (srcset !== null) element.setAttribute('srcset', rewriteSrcset(srcset, rewrite));
      },
    }).transform(response);
  }

  const body = rewriteHtmlString(await response.text(), config, requestOrigin, siteUrl);
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

type RequestCachePolicy = 'read-write' | 'read-only' | 'bypass';

interface RequestCacheDecision {
  policy: RequestCachePolicy;
  /** Present when policy is bypass, or when a read-only cold miss should report BYPASS. */
  reason?: BypassReason;
}

export function parseCookieNames(cookieHeader: string | null): Set<string> {
  const names = new Set<string>();
  for (const part of (cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    const name = (separator >= 0 ? part.slice(0, separator) : part).trim();
    if (name) names.add(name);
  }
  return names;
}

function requestCachePolicy(request: Request): RequestCacheDecision {
  // Publish-time warm-up self-requests send Cache-Control: no-cache to defeat
  // stale platform-cache entries, yet must render into the shared cache
  // layers. Forging the marker only warms public pages, so it is safe to
  // honor from any client.
  if (request.headers.get(CACHE_WARMUP_HEADER) === '1') return { policy: 'read-write' };
  if (request.headers.has('Authorization')) {
    return { policy: 'bypass', reason: 'authorization' };
  }
  const cacheControl = request.headers.get('Cache-Control')?.toLowerCase() || '';
  // no-store: client forbids shared reuse — full bypass.
  if (cacheControl.includes('no-store')) {
    return { policy: 'bypass', reason: 'cache-control' };
  }
  // no-cache (browser hard-refresh): read warm L1/L2/L3 entries but never write
  // a new variant. Cold miss still SSRs and returns BYPASS.
  if (cacheControl.includes('no-cache')) {
    return { policy: 'read-only', reason: 'cache-control' };
  }

  const cookieNames = parseCookieNames(request.headers.get('Cookie'));
  // Frontend HTML is deliberately decoupled from the authenticated viewer.
  // Authentication cookies may therefore share the public page cache. An
  // unapproved-comment cookie remains read-only because it can reveal a
  // submitter's pending comment on an otherwise public page.
  if (cookieNames.has('__typecho_unapproved_comment')) {
    return { policy: 'read-only', reason: 'unapproved-comment' };
  }
  return { policy: 'read-write' };
}

async function renderWithRuntimeRewrite(
  context: EarlyRequestContext,
  next: EarlyRequestNext,
  bypassReason: BypassReason = 'kv-missing',
): Promise<Response> {
  const response = await next();
  const control = requestRuntime.get(context.request);
  if (!control) return response;
  try {
    return withCacheHeader(
      await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl),
      'BYPASS',
      control.config.l1Ttl,
      undefined,
      bypassReason,
    );
  } catch (error) {
    console.error('[edge-cache] HTML rewrite failed:', error);
    return withCacheHeader(response, 'BYPASS', control.config.l1Ttl, undefined, bypassReason);
  }
}

async function renderAndCache(
  context: EarlyRequestContext,
  next: EarlyRequestNext,
  control: CacheControlDocument,
  d1: D1Database | null,
  kv: KVNamespace,
  l1Key: Request,
  l2Key: string,
  l2Ttl: number,
  l3Ttl: number,
  domain: PublicCacheDomain,
): Promise<Response> {
  let response = await next();
  try {
    response = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl);
  } catch (error) {
    console.error('[edge-cache] HTML rewrite failed:', error);
  }
  if (!canCacheResponse(response, true)) {
    // Nested render: a permalink rewrite re-ran the middleware chain, so this
    // response was already handled by an inner early-request pass and carries
    // its cache headers (X-Typecho-Cache + platform header + Cache-Tag). Pass
    // it through instead of overriding with a BYPASS that would drop the tags.
    if (response.headers.has('X-Typecho-Cache')) return response;
    return withCacheHeader(response, 'BYPASS', control.config.l1Ttl, undefined, 'uncacheable');
  }

  const cacheable = response.clone();
  const write = storeResponse(d1, kv, l1Key, l2Key, cacheable, control.config.l1Ttl, l2Ttl, l3Ttl)
    .catch(error => console.error('[edge-cache] Cache persistence failed:', error));
  if (context.waitUntil) context.waitUntil(write);
  else await write;
  return withCacheHeader(response, 'MISS', control.config.l1Ttl, domain);
}

async function handleRequest(context: EarlyRequestContext, next: EarlyRequestNext): Promise<Response> {
  const kv = asKv(context.env.TYPECHO_CACHE);
  if (!kv) return renderWithRuntimeRewrite(context, next, 'kv-missing');
  const d1 = d1Binding(context);

  let control: CacheControlDocument | null;
  try {
    control = await loadControl(kv);
  } catch (error) {
    console.error('[edge-cache] Control read failed:', error);
    return renderWithRuntimeRewrite(context, next, 'control-missing');
  }
  if (!control) {
    // Control document missing (e.g. the KV namespace was swapped or the doc
    // was deleted). Rebuild it from the runtime config synced from DB options
    // so the cache recovers without a manual re-enable. Plugins that are not
    // activated never reach this branch (sync sets requestRuntime to null).
    const runtime = requestRuntime.get(context.request);
    if (runtime) {
      control = runtime;
      await writeControl(kv, runtime).catch(error => {
        console.error('[edge-cache] Control rebuild failed:', error);
      });
    } else {
      return renderWithRuntimeRewrite(context, next, 'control-missing');
    }
  }

  const domain = classifyCacheDomain(context.url.pathname, control);
  const normalizedUrl = normalizeCacheUrl(context.url, domain);
  const domainEnabled = control.config.cacheScopes.includes(domain);
  const decision = requestCachePolicy(context.request);
  const policy = decision.policy;
  const l2Ttl = control.config.l2Ttl;
  const l3Ttl = control.config.l3Ttl;

  if (!domainEnabled) {
    const response = await next();
    const rewritten = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl)
      .catch(() => response);
    return withCacheHeader(rewritten, 'BYPASS', control.config.l1Ttl, undefined, 'domain-disabled');
  }
  if (policy === 'bypass') {
    const response = await next();
    const rewritten = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl)
      .catch(() => response);
    return withCacheHeader(rewritten, 'BYPASS', control.config.l1Ttl, undefined, decision.reason ?? 'cache-control');
  }
  if (!normalizedUrl) {
    const response = await next();
    const rewritten = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl)
      .catch(() => response);
    return withCacheHeader(rewritten, 'BYPASS', control.config.l1Ttl, undefined, 'unsafe-query');
  }

  if (control.config.l1Ttl === 0 && l2Ttl === 0 && l3Ttl === 0) {
    const response = await next();
    const rewritten = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl)
      .catch(() => response);
    return withCacheHeader(rewritten, 'BYPASS', 0, undefined, 'ttl-zero');
  }

  let cacheId: string;
  let l1Key: Request;
  let l2Key: string;
  try {
    const [globalGeneration, domainGeneration, urlHash] = await Promise.all([
      generation(kv, 'all'),
      generation(kv, domain),
      sha256WithMemo(normalizedUrl),
    ]);
    cacheId = `${domain}:${globalGeneration}:${domainGeneration}:${urlHash}`;
    l1Key = l1Request(cacheId);
    l2Key = `${PAGE_PREFIX}${cacheId}`;
    if (control.config.l1Ttl > 0) {
      const l1 = await caches.default.match(l1Key);
      if (l1) return withCacheHeader(l1, 'L1', control.config.l1Ttl, domain);
    }

    if (l2Ttl > 0) {
      const l2 = await kv.get<StoredResponse>(l2Key, { type: 'json', cacheTtl: 60 });
      const l2Response = l2 ? responseFromStored(l2) : null;
      if (l2Response) {
        if (control.config.l1Ttl > 0) {
          const refill = withCacheHeader(l2Response.clone(), 'L2', control.config.l1Ttl, domain);
          refill.headers.delete('X-Typecho-Cache');
          const write = caches.default.put(l1Key, refill).catch(error => {
            console.error('[edge-cache] L1 refill failed:', error);
          });
          if (context.waitUntil) context.waitUntil(write);
          else await write;
        }
        return withCacheHeader(l2Response, 'L2', control.config.l1Ttl, domain);
      }
    }
  } catch (error) {
    console.error('[edge-cache] Cache lookup failed; falling back to D1:', error);
    return renderWithRuntimeRewrite(context, next, 'lookup-failed');
  }

  if (d1 && l3Ttl > 0) {
    try {
      const l3 = await readL3(d1, l2Key);
      if (l3) {
        const l3Response = responseFromStored(l3);
        if (l3Response) {
          await promoteStoredResponse(context, kv, l1Key, l2Key, l3, control.config.l1Ttl, l2Ttl);
          return withCacheHeader(l3Response, 'L3', control.config.l1Ttl, domain);
        }
      }
    } catch (error) {
      console.error('[edge-cache] L3 lookup failed; falling back to D1:', error);
    }
  }

  if (policy === 'read-only') {
    // Read-only cold miss: render fresh but never store. Used for unapproved-
    // comment cookies (must not leak pending comments) and browser no-cache
    // hard-refresh (may read warm layers above, but must not write).
    const response = await next();
    const rewritten = await rewriteHtmlResponse(
      response,
      control.config,
      context.url.origin,
      control.options.siteUrl,
    ).catch(() => response);
    return withCacheHeader(
      rewritten,
      'BYPASS',
      control.config.l1Ttl,
      undefined,
      decision.reason ?? 'unapproved-comment',
    );
  }

  const inFlightKey = cacheId;
  const existing = inFlight.get(inFlightKey);
  if (existing) return (await existing).clone();
  const pending = renderAndCache(
    context,
    next,
    control,
    d1,
    kv,
    l1Key,
    l2Key,
    l2Ttl,
    l3Ttl,
    domain,
  );
  inFlight.set(inFlightKey, pending);
  try {
    return (await pending).clone();
  } finally {
    if (inFlight.get(inFlightKey) === pending) inFlight.delete(inFlightKey);
  }
}

function syncRuntime(context: EarlyRequestSyncContext): void {
  if (!context.active) {
    requestRuntime.set(context.request, null);
    runtimeConfig = null;
    return;
  }
  const control = buildControlDocument(
    parsePluginOption(context.options[`plugin:${CACHE_PLUGIN_ID}`]),
    context.options,
  );
  requestRuntime.set(context.request, control);
  runtimeConfig = control.config;
}

async function lifecycle(event: EarlyRequestLifecycleEvent): Promise<void> {
  const kv = runtimeKv();
  if (event.type === 'deactivate') {
    if (kv) await kv.delete(CACHE_CONTROL_KEY);
    controlMemo = { value: null, expiresAt: Date.now() + CONTROL_MEMO_TTL_MS };
    generationMemo.clear();
    runtimeConfig = null;
    lastD1CleanupAt = 0;
    // Stale platform entries would otherwise keep serving old pages until
    // their TTL expires — the control doc no longer guards them.
    await purgePlatformCache([`${PLATFORM_TAG_PREFIX}all`]);
    return;
  }
  if (!event.settings) return;
  const control = buildControlDocument(event.settings, event.options);
  runtimeConfig = control.config;
  if (kv) {
    await writeControl(kv, control);
    await invalidateDomains(kv, ['all']);
  }
  await invalidateAllDataStores();
  await purgePlatformCache([`${PLATFORM_TAG_PREFIX}all`]);
}

async function invalidate(event: PublicCacheInvalidation): Promise<boolean> {
  const kv = runtimeKv();
  let pageHandled = false;
  let control = kv ? await loadControl(kv) : null;
  if (event.options && kv && control) {
    const nextControl: CacheControlDocument = {
      ...control,
      options: { ...control.options, ...optionsForControl({ ...control.options, ...event.options }) },
    };
    await writeControl(kv, nextControl);
    control = nextControl;
  }
  if (kv && event.domains.length) {
    await invalidateDomains(kv, event.domains);
    pageHandled = true;
  }
  // Platform layer purge runs even without a KV binding: cacheable pages are
  // tagged on the response itself, so stale entries exist independently of KV.
  if (event.domains.length) {
    await purgePlatformCache(platformTagsForDomains(event.domains));
  }
  const dataHandled = event.sharedDomains?.length
    ? await invalidateConfiguredDataDomains(event.sharedDomains)
    : false;
  return pageHandled || dataHandled;
}

export const earlyRequestProvider: EarlyRequestProvider = {
  handle: handleRequest,
  sync: syncRuntime,
  lifecycle,
  invalidate,
  readSharedData,
  writeSharedData,
};

export function resetCacheProviderForTests(): void {
  controlMemo = null;
  generationMemo.clear();
  urlHashMemo.clear();
  inFlight.clear();
  runtimeConfig = null;
  lastD1CleanupAt = 0;
  requestRuntime = new WeakMap<Request, CacheControlDocument | null>();
}
