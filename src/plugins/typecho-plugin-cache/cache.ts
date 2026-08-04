import type {
  EarlyRequestContext,
  EarlyRequestLifecycleEvent,
  EarlyRequestNext,
  EarlyRequestProvider,
} from '@/lib/early-request';
import type { PublicCacheDomain, PublicCacheInvalidation } from '@/lib/cache';
import { env } from 'cloudflare:workers';
import { compilePermalinkPattern, type PermalinkPatternKind } from '@/lib/permalink-pattern';

export const CACHE_PLUGIN_ID = 'typecho-plugin-cache';
export const CACHE_CONTROL_KEY = 'typecho:edge-cache:v1:control';
const GENERATION_PREFIX = 'typecho:edge-cache:v1:g:';
const PAGE_PREFIX = 'typecho:edge-cache:v1:p:';
const L1_ORIGIN = 'https://typecho-cache.internal';
const CONTROL_MEMO_TTL_MS = 5_000;
const GENERATION_MEMO_TTL_MS = 5_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const ALL_DOMAINS: PublicCacheDomain[] = ['home', 'post', 'page', 'note', 'archive', 'other'];
const DETAIL_DOMAINS = new Set<PublicCacheDomain>(['post', 'page', 'note']);
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid']);

export interface CachePluginConfig {
  cacheScopes: PublicCacheDomain[];
  l1Ttl: number;
  listTtl: number;
  detailTtl: number;
  staticCdnUrl: string;
  staticExtensions: string[];
  avatarCdnUrl: string;
}

export interface CacheControlDocument {
  active: true;
  config: CachePluginConfig;
  options: {
    cacheEnabled: number;
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

function asKv(value: unknown): KVNamespace | null {
  const candidate = value as Partial<KVNamespace> | null | undefined;
  return candidate && typeof candidate.get === 'function' && typeof candidate.put === 'function'
    ? candidate as KVNamespace
    : null;
}

function runtimeKv(): KVNamespace | null {
  return asKv(env.TYPECHO_CACHE);
}

export function setCacheRuntimeEnvForTests(workerEnv?: CloudflareEnv): void {
  if (workerEnv) Object.assign(env, workerEnv);
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

function ttl(value: unknown, allowed: number[], fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return allowed.includes(parsed) ? parsed : fallback;
}

export function normalizeCacheConfig(settings: Record<string, unknown> | CachePluginConfig): CachePluginConfig {
  const requestedScopes = Array.isArray(settings.cacheScopes) ? settings.cacheScopes : ALL_DOMAINS;
  const cacheScopes = ALL_DOMAINS.filter(domain => requestedScopes.includes(domain));
  return {
    cacheScopes,
    l1Ttl: ttl(settings.l1Ttl, [60, 300, 600], 300),
    listTtl: ttl(settings.listTtl, [60, 300, 600], 300),
    detailTtl: ttl(settings.detailTtl, [900, 1800, 3600], 3600),
    staticCdnUrl: normalizeUrl(settings.staticCdnUrl),
    staticExtensions: normalizeExtensions(settings.staticExtensions),
    avatarCdnUrl: normalizeUrl(settings.avatarCdnUrl),
  };
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
    cacheEnabled: Number(options.cacheEnabled ?? 1) === 0 ? 0 : 1,
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
  const value = await kv.get(key, { type: 'text', cacheTtl: 60 }) || '0';
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
  const normalized = new URL(url.toString());
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

function l1Request(key: string): Request {
  return new Request(`${L1_ORIGIN}/${key}`, { method: 'GET' });
}

function withCacheHeader(
  response: Response,
  value: 'L1' | 'L2' | 'MISS' | 'BYPASS',
  l1Ttl?: number,
): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Typecho-Cache', value);
  if (l1Ttl) headers.set('Cache-Control', `public, max-age=0, s-maxage=${l1Ttl}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function canCacheResponse(response: Response): boolean {
  if (response.status !== 200) return false;
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) return false;
  if (response.headers.has('Set-Cookie') || response.headers.has('Content-Encoding')) return false;
  const cacheControl = response.headers.get('Cache-Control')?.toLowerCase() || '';
  if (cacheControl.includes('private') || cacheControl.includes('no-store')) return false;
  const vary = (response.headers.get('Vary') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return vary.every(value => value === 'cookie' || value === 'accept-encoding');
}

function responseHeadersForStorage(headers: Headers): Array<[string, string]> {
  const skipped = new Set(['set-cookie', 'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'x-typecho-cache']);
  return [...headers.entries()].filter(([name]) => !skipped.has(name.toLowerCase()));
}

async function storeResponse(
  kv: KVNamespace,
  l1Key: Request,
  l2Key: string,
  response: Response,
  l1Ttl: number,
  l2Ttl: number,
): Promise<void> {
  const l1Headers = new Headers(response.headers);
  l1Headers.delete('Set-Cookie');
  l1Headers.set('Cache-Control', `public, max-age=0, s-maxage=${l1Ttl}`);
  l1Headers.delete('X-Typecho-Cache');
  const l1Response = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers: l1Headers,
  });

  const body = await response.clone().text();
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  const writes: Promise<unknown>[] = [caches.default.put(l1Key, l1Response)];
  if (bodyBytes <= MAX_HTML_BYTES) {
    const stored: StoredResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeadersForStorage(response.headers),
      body,
    };
    writes.push(kv.put(l2Key, JSON.stringify(stored), { expirationTtl: l2Ttl }));
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

function joinCdnPath(base: URL, source: URL): string {
  const prefix = base.pathname.replace(/\/$/, '');
  base.pathname = `${prefix}${source.pathname.startsWith('/') ? source.pathname : `/${source.pathname}`}` || '/';
  base.search = source.search;
  base.hash = source.hash;
  return base.toString();
}

function isGravatarHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'gravatar.com' || host.endsWith('.gravatar.com');
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
    return joinCdnPath(new URL(config.avatarCdnUrl), source);
  }

  if (!config.staticCdnUrl) return raw;
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

function shouldBypassRequest(request: Request): boolean {
  if (request.headers.has('Cookie') || request.headers.has('Authorization')) return true;
  const cacheControl = request.headers.get('Cache-Control')?.toLowerCase() || '';
  return cacheControl.includes('no-cache') || cacheControl.includes('no-store');
}

async function renderAndCache(
  context: EarlyRequestContext,
  next: EarlyRequestNext,
  control: CacheControlDocument,
  kv: KVNamespace,
  l1Key: Request,
  l2Key: string,
  l2Ttl: number,
): Promise<Response> {
  let response = await next();
  try {
    response = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl);
  } catch (error) {
    console.error('[edge-cache] HTML rewrite failed:', error);
  }
  if (!canCacheResponse(response)) return withCacheHeader(response, 'BYPASS');

  const cacheable = response.clone();
  const write = storeResponse(kv, l1Key, l2Key, cacheable, control.config.l1Ttl, l2Ttl)
    .catch(error => console.error('[edge-cache] Cache persistence failed:', error));
  if (context.waitUntil) context.waitUntil(write);
  else await write;
  return withCacheHeader(response, 'MISS', control.config.l1Ttl);
}

async function handleRequest(context: EarlyRequestContext, next: EarlyRequestNext): Promise<Response> {
  const kv = asKv(context.env.TYPECHO_CACHE);
  if (!kv) return next();

  let control: CacheControlDocument | null;
  try {
    control = await loadControl(kv);
  } catch (error) {
    console.error('[edge-cache] Control read failed:', error);
    return next();
  }
  if (!control) return next();

  const domain = classifyCacheDomain(context.url.pathname, control);
  const normalizedUrl = normalizeCacheUrl(context.url, domain);
  const cacheEnabled = control.options.cacheEnabled !== 0 && control.config.cacheScopes.includes(domain);
  const bypass = shouldBypassRequest(context.request) || !normalizedUrl;
  if (!cacheEnabled || bypass) {
    context.markPageCacheManaged();
    const response = await next();
    const rewritten = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl)
      .catch(() => response);
    return withCacheHeader(rewritten, 'BYPASS');
  }

  let cacheId: string;
  let l1Key: Request;
  let l2Key: string;
  try {
    const [globalGeneration, domainGeneration, urlHash] = await Promise.all([
      generation(kv, 'all'),
      generation(kv, domain),
      sha256(normalizedUrl),
    ]);
    cacheId = `${domain}:${globalGeneration}:${domainGeneration}:${urlHash}`;
    l1Key = l1Request(cacheId);
    l2Key = `${PAGE_PREFIX}${cacheId}`;
    const l1 = await caches.default.match(l1Key);
    if (l1) return withCacheHeader(l1, 'L1', control.config.l1Ttl);

    const l2 = await kv.get<StoredResponse>(l2Key, { type: 'json', cacheTtl: 60 });
    const l2Response = l2 ? responseFromStored(l2) : null;
    if (l2Response) {
      const refill = withCacheHeader(l2Response.clone(), 'L2', control.config.l1Ttl);
      refill.headers.delete('X-Typecho-Cache');
      const write = caches.default.put(l1Key, refill).catch(error => {
        console.error('[edge-cache] L1 refill failed:', error);
      });
      if (context.waitUntil) context.waitUntil(write);
      else await write;
      return withCacheHeader(l2Response, 'L2', control.config.l1Ttl);
    }
  } catch (error) {
    console.error('[edge-cache] Cache lookup failed; falling back to D1:', error);
    return next();
  }

  const existing = inFlight.get(cacheId);
  if (existing) return (await existing).clone();
  context.markPageCacheManaged();
  const l2Ttl = DETAIL_DOMAINS.has(domain) ? control.config.detailTtl : control.config.listTtl;
  const pending = renderAndCache(context, next, control, kv, l1Key, l2Key, l2Ttl);
  inFlight.set(cacheId, pending);
  try {
    return (await pending).clone();
  } finally {
    if (inFlight.get(cacheId) === pending) inFlight.delete(cacheId);
  }
}

async function lifecycle(event: EarlyRequestLifecycleEvent): Promise<void> {
  const kv = runtimeKv();
  if (!kv) return;
  if (event.type === 'deactivate') {
    await kv.delete(CACHE_CONTROL_KEY);
    controlMemo = { value: null, expiresAt: Date.now() + CONTROL_MEMO_TTL_MS };
    generationMemo.clear();
    runtimeConfig = null;
    return;
  }
  if (!event.settings) return;
  await writeControl(kv, buildControlDocument(event.settings, event.options));
  await invalidateDomains(kv, ['all']);
}

async function invalidate(event: PublicCacheInvalidation): Promise<boolean> {
  const kv = runtimeKv();
  if (!kv) return false;
  const control = await loadControl(kv);
  if (!control) return false;
  if (event.options) {
    const nextControl: CacheControlDocument = {
      ...control,
      options: { ...control.options, ...optionsForControl({ ...control.options, ...event.options }) },
    };
    await writeControl(kv, nextControl);
  }
  await invalidateDomains(kv, event.domains);
  return true;
}

export const earlyRequestProvider: EarlyRequestProvider = { handle: handleRequest, lifecycle, invalidate };

export function resetCacheProviderForTests(): void {
  controlMemo = null;
  generationMemo.clear();
  inFlight.clear();
  runtimeConfig = null;
}
