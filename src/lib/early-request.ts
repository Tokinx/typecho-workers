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
  readSharedData?<T>(domain: SharedCacheDomain, key: string): Promise<T | null>;
  writeSharedData?<T>(domain: SharedCacheDomain, key: string, value: T): Promise<boolean>;
}

export type EarlyRequestProviderLoader = () => Promise<EarlyRequestProvider | null | undefined>;

const providerLoaders = new Map<string, EarlyRequestProviderLoader>();
const pendingProviders = new Map<string, Promise<EarlyRequestProvider | null>>();
const SHARED_SNAPSHOT_TTL_MS = 60_000;
type SharedSnapshot = { value: unknown; expiresAt: number };
const sharedSnapshots = new Map<string, SharedSnapshot>();
let sharedScopeIds = new WeakMap<object, number>();
let nextSharedScopeId = 1;

function sharedSnapshotKey(domain: SharedCacheDomain, key: string, scope?: object): string {
  let scopeId = 0;
  if (scope) {
    scopeId = sharedScopeIds.get(scope) || nextSharedScopeId++;
    sharedScopeIds.set(scope, scopeId);
  }
  return `${domain}\0${scopeId}\0${key}`;
}

function cloneSharedValue<T>(value: T): T {
  return structuredClone(value);
}

function invalidateSharedSnapshots(domains?: SharedCacheDomain[] | ['all']): void {
  if (!domains?.length) return;
  if (domains[0] === 'all') {
    sharedSnapshots.clear();
    return;
  }
  const prefixes = new Set(domains.map(domain => `${domain}\0`));
  for (const key of sharedSnapshots.keys()) {
    if ([...prefixes].some(prefix => key.startsWith(prefix))) sharedSnapshots.delete(key);
  }
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

function isEligibleEarlyRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;
  const path = new URL(request.url).pathname;
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
  if (!isEligibleEarlyRequest(context.request) || providerLoaders.size === 0) return next();

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
  invalidateSharedSnapshots(event.sharedDomains);
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

/** Load a JSON-serializable shared dataset through L0 -> provider -> D1. */
export async function loadEarlyRequestSharedData<T>(
  domain: SharedCacheDomain,
  key: string,
  fallback: () => Promise<T>,
  scope?: object,
): Promise<T> {
  const snapshotKey = sharedSnapshotKey(domain, key, scope);
  const snapshot = sharedSnapshots.get(snapshotKey);
  if (snapshot && snapshot.expiresAt > Date.now()) return cloneSharedValue(snapshot.value as T);

  const providers = await loadProviders();
  for (const [pluginId, provider] of providers) {
    if (!provider.readSharedData) continue;
    try {
      const value = await provider.readSharedData<T>(domain, key);
      if (value !== null) {
        sharedSnapshots.set(snapshotKey, { value: cloneSharedValue(value), expiresAt: Date.now() + SHARED_SNAPSHOT_TTL_MS });
        return cloneSharedValue(value);
      }
    } catch (error) {
      console.error(`[early-request] Shared cache read failed for ${pluginId}:`, error);
    }
  }

  const value = await fallback();
  sharedSnapshots.set(snapshotKey, { value: cloneSharedValue(value), expiresAt: Date.now() + SHARED_SNAPSHOT_TTL_MS });
  for (const [pluginId, provider] of providers) {
    if (!provider.writeSharedData) continue;
    try {
      if (await provider.writeSharedData(domain, key, value)) break;
    } catch (error) {
      console.error(`[early-request] Shared cache write failed for ${pluginId}:`, error);
    }
  }
  return cloneSharedValue(value);
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
  sharedSnapshots.clear();
  sharedScopeIds = new WeakMap<object, number>();
  nextSharedScopeId = 1;
}
