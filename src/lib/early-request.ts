import type { PublicCacheInvalidation } from '@/lib/cache';

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

export interface EarlyRequestProvider {
  handle(context: EarlyRequestContext, next: EarlyRequestNext): Promise<Response>;
  invalidate?(event: PublicCacheInvalidation): Promise<boolean>;
  lifecycle?(event: EarlyRequestLifecycleEvent): Promise<void>;
}

export type EarlyRequestProviderLoader = () => Promise<EarlyRequestProvider | null | undefined>;

const providerLoaders = new Map<string, EarlyRequestProviderLoader>();
const pendingProviders = new Map<string, Promise<EarlyRequestProvider | null>>();

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
}
