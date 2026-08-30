/**
 * Early-request provider registry and shared-data loading.
 *
 * Shared datasets (options, sidebar, metas, comment projections, admin
 * lists, …) are loaded through the activated early-request providers (the
 * cache plugin's KV/D1 data cache) with a D1 fallback. There is no
 * per-isolate snapshot layer: in-memory L0 snapshots could not be
 * invalidated across isolates, so writes became visible only after the
 * snapshot TTL expired. Every read goes to the provider, whose
 * generation-stamped keys provide cross-isolate invalidation; only
 * in-flight deduplication and a stale-write generation guard remain local.
 */

import type { PublicCacheInvalidation, SharedCacheDomain } from '@/lib/cache';

export interface EarlyRequestContext {
  request: Request;
  url: URL;
  env: Record<string, unknown>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type EarlyRequestNext = () => Promise<Response>;

export interface EarlyRequestLifecycleEvent {
  type: 'activate' | 'deactivate' | 'config';
  settings?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface EarlyRequestSyncContext {
  request: Request;
  active: boolean;
  options: Record<string, unknown>;
}

export interface EarlyRequestProvider {
  handle(context: EarlyRequestContext, next: EarlyRequestNext): Promise<Response>;
  sync?(context: EarlyRequestSyncContext): Promise<void> | void;
  invalidate?(event: PublicCacheInvalidation): Promise<boolean>;
  lifecycle?(event: EarlyRequestLifecycleEvent): Promise<void>;
  readSharedData?<T>(domain: SharedCacheDomain, key: string): Promise<SharedDataRead<T>>;
  writeSharedData?<T>(domain: SharedCacheDomain, key: string, value: T): Promise<boolean>;
}

export type SharedCacheSource = 'KV' | 'D1' | 'MISS' | 'BYPASS';

/** Request-local diagnostics for explicitly enabled query-cache debugging. */
export interface SharedCacheTrace {
  sources: Map<SharedCacheDomain, SharedCacheSource>;
}

export function createSharedCacheTrace(): SharedCacheTrace {
  return { sources: new Map() };
}

export function recordSharedCacheTrace(
  trace: SharedCacheTrace | undefined,
  domain: SharedCacheDomain,
  source: SharedCacheSource,
): void {
  trace?.sources.set(domain, source);
}

export function formatSharedCacheTrace(trace: SharedCacheTrace | undefined): string {
  if (!trace || trace.sources.size === 0) return '';
  return [...trace.sources.entries()]
    .map(([domain, source]) => `${domain}=${source}`)
    .join(';');
}

export interface SharedDataRead<T> {
  handled: boolean;
  value: T | null;
  /** Set only when the provider returned a value or explicitly bypassed it. */
  source?: Exclude<SharedCacheSource, 'MISS'>;
}

export interface SharedDataFallbackContext {
  /** True when an active provider missed, so legacy caches may contain stale data. */
  providerHandled: boolean;
}

export type EarlyRequestProviderLoader = () => Promise<EarlyRequestProvider | null | undefined>;

const providerLoaders = new Map<string, EarlyRequestProviderLoader>();
const pendingProviders = new Map<string, Promise<EarlyRequestProvider | null>>();
const ALL_SHARED_DOMAINS: SharedCacheDomain[] = [
  'options', 'navigation', 'sidebar', 'metas', 'comments', 'notes', 'archive', 'content',
  'admin-dashboard', 'admin-content', 'admin-comments', 'admin-metas', 'admin-media',
  'admin-users', 'admin-options',
];
const pendingSharedLoads = new Map<string, Promise<unknown>>();
const sharedDataGenerations = new Map<SharedCacheDomain, number>();

function sharedDataGeneration(domain: SharedCacheDomain): number {
  return sharedDataGenerations.get(domain) || 0;
}

function advanceSharedDataGeneration(domain: SharedCacheDomain): void {
  sharedDataGenerations.set(domain, sharedDataGeneration(domain) + 1);
}

/**
 * Local invalidation bookkeeping: drop in-flight dedup entries for the
 * affected domains and advance their generation so a load that started
 * before the invalidation cannot repopulate the provider cache with a
 * stale fallback result. Cross-isolate invalidation is the providers' job
 * (generation-stamped KV/D1 keys).
 */
function invalidateSharedDataGenerations(domains?: SharedCacheDomain[] | ['all']): void {
  if (!domains?.length) return;
  const targetDomains = domains[0] === 'all' ? ALL_SHARED_DOMAINS : (domains as SharedCacheDomain[]);
  const prefixes = new Set(targetDomains.map(domain => `${domain}\0`));
  for (const key of pendingSharedLoads.keys()) {
    if ([...prefixes].some(prefix => key.startsWith(prefix))) pendingSharedLoads.delete(key);
  }
  for (const domain of targetDomains) advanceSharedDataGeneration(domain);
}

function cloneSharedValue<T>(value: T): T {
  return structuredClone(value);
}

export function registerEarlyRequestLoaders(loaders: Record<string, EarlyRequestProviderLoader>): void {
  for (const [pluginId, loader] of Object.entries(loaders)) {
    if (!providerLoaders.has(pluginId)) providerLoaders.set(pluginId, loader);
  }
}

async function loadProvider(pluginId: string): Promise<EarlyRequestProvider | null> {
  const existing = pendingProviders.get(pluginId);
  if (existing) return existing;

  const loader = providerLoaders.get(pluginId);
  if (!loader) return null;
  const pending = loader()
    .then(provider => provider || null)
    .catch(error => {
      pendingProviders.delete(pluginId);
      console.error(`[early-request] Failed to load provider ${pluginId}:`, error);
      return null;
    });
  pendingProviders.set(pluginId, pending);
  return pending;
}

async function loadProviders(): Promise<Array<[string, EarlyRequestProvider]>> {
  const loaded = await Promise.all(
    [...providerLoaders.keys()].map(async pluginId => [pluginId, await loadProvider(pluginId)] as const),
  );
  return loaded.filter((entry): entry is [string, EarlyRequestProvider] => entry[1] !== null);
}

function isEligibleEarlyRequest(request: Request, url: URL): boolean {
  if (request.method !== 'GET') return false;
  const path = url.pathname;
  if (
    path === '/install' ||
    path === '/api/install' ||
    path === '/admin' ||
    path.startsWith('/admin/') ||
    path === '/api' ||
    path.startsWith('/api/') ||
    path.startsWith('/usr/') ||
    path.startsWith('/css/') ||
    path.startsWith('/js/') ||
    path.startsWith('/img/') ||
    path.startsWith('/themes/') ||
    path.startsWith('/vendor/') ||
    path.startsWith('/plugin-assets/')
  ) {
    return false;
  }
  return true;
}

export async function runEarlyRequestProviders(
  context: EarlyRequestContext,
  next: EarlyRequestNext,
): Promise<Response> {
  if (!isEligibleEarlyRequest(context.request, context.url) || providerLoaders.size === 0) return next();

  const providers = await loadProviders();
  if (providers.length === 0) return next();

  let index = -1;
  const dispatch = async (position: number): Promise<Response> => {
    if (position <= index) throw new Error('Early request next() called more than once');
    index = position;
    const provider = providers[position]?.[1];
    if (!provider) return next();
    return provider.handle({
      request: context.request,
      url: context.url,
      env: context.env,
      waitUntil: context.waitUntil,
    }, () => dispatch(position + 1));
  };

  return dispatch(0);
}

export async function notifyEarlyRequestInvalidation(event: PublicCacheInvalidation): Promise<boolean> {
  invalidateSharedDataGenerations(event.sharedDomains);
  // Memoized full-content markdown renders key on source text + plugin set.
  // Option / plugin-configuration changes can alter filter output without
  // touching the text, so drop the memo on broad invalidations. The markdown
  // module (marked + sanitize-html) is deliberately loaded here via dynamic
  // import: this funnel never runs on a cache hit, and a static import would
  // anchor the 460KB markdown chunk into the first-request module graph.
  const sharedDomains = event.sharedDomains as readonly string[] | undefined;
  if (sharedDomains?.includes('all') || sharedDomains?.includes('content')) {
    const { resetMarkdownRenderCache } = await import('@/lib/markdown');
    resetMarkdownRenderCache();
  }
  const providers = await loadProviders();
  let handled = false;
  for (const [pluginId, provider] of providers) {
    if (!provider.invalidate) continue;
    try {
      handled = await provider.invalidate(event) || handled;
    } catch (error) {
      console.error(`[early-request] Invalidation failed for ${pluginId}:`, error);
    }
  }
  return handled;
}

/** Load a JSON-serializable shared dataset through provider -> D1 fallback. */
export async function loadEarlyRequestSharedData<T>(
  domain: SharedCacheDomain,
  key: string,
  fallback: (context: SharedDataFallbackContext) => Promise<T>,
  trace?: SharedCacheTrace,
): Promise<T> {
  const pendingKey = `${domain}\0${key}`;
  const localGeneration = sharedDataGeneration(domain);
  const existing = pendingSharedLoads.get(pendingKey);
  if (existing) {
    recordSharedCacheTrace(trace, domain, 'MISS');
    return cloneSharedValue(await existing as T);
  }

  const pending = (async (): Promise<T> => {
    const providers = await loadProviders();
    let providerHandled = false;
    for (const [pluginId, provider] of providers) {
      if (!provider.readSharedData) continue;
      try {
        const result = await provider.readSharedData<T>(domain, key);
        providerHandled = providerHandled || result.handled;
        if (result.source) recordSharedCacheTrace(trace, domain, result.source);
        if (result.value !== null) {
          return result.value;
        }
      } catch (error) {
        console.error(`[early-request] Shared cache read failed for ${pluginId}:`, error);
      }
    }

    if (trace?.sources.get(domain) !== 'BYPASS') {
      recordSharedCacheTrace(trace, domain, 'MISS');
    }
    const value = await fallback({ providerHandled });
    if (sharedDataGeneration(domain) !== localGeneration) return value;
    for (const [pluginId, provider] of providers) {
      if (!provider.writeSharedData) continue;
      try {
        if (await provider.writeSharedData(domain, key, value)) break;
      } catch (error) {
        console.error(`[early-request] Shared cache write failed for ${pluginId}:`, error);
      }
    }
    return value;
  })();
  pendingSharedLoads.set(pendingKey, pending);
  try {
    return cloneSharedValue(await pending);
  } finally {
    if (pendingSharedLoads.get(pendingKey) === pending) pendingSharedLoads.delete(pendingKey);
  }
}

export async function syncEarlyRequestProviders(
  request: Request,
  activatedPluginIds: Iterable<string>,
  options: Record<string, unknown>,
): Promise<void> {
  const activated = new Set(activatedPluginIds);
  const providers = await loadProviders();
  await Promise.all(providers.map(async ([pluginId, provider]) => {
    if (!provider.sync) return;
    try {
      await provider.sync({ request, active: activated.has(pluginId), options });
    } catch (error) {
      console.error(`[early-request] Runtime sync failed for ${pluginId}:`, error);
    }
  }));
}

export async function notifyEarlyRequestLifecycle(
  pluginId: string,
  event: EarlyRequestLifecycleEvent,
): Promise<boolean> {
  const provider = await loadProvider(pluginId);
  if (!provider?.lifecycle) return false;
  await provider.lifecycle(event);
  return true;
}

export function resetEarlyRequestProvidersForTests(): void {
  providerLoaders.clear();
  pendingProviders.clear();
  pendingSharedLoads.clear();
  sharedDataGenerations.clear();
}
