import type {
  EarlyRequestContext,
  EarlyRequestLifecycleEvent,
  EarlyRequestNext,
  EarlyRequestProvider,
  EarlyRequestSyncContext,
  SharedDataRead,
} from '@/lib/early-request';
import type { PublicCacheDomain, PublicCacheInvalidation, SharedCacheDomain } from '@/lib/cache';
import { env } from 'cloudflare:workers';
import { compilePermalinkPattern, type PermalinkPatternKind } from '@/lib/permalink-pattern';
import { loadPluginConfig } from '@/lib/plugin';

export const CACHE_PLUGIN_ID = 'typecho-plugin-cache';
export const CACHE_CONTROL_KEY = 'typecho:edge-cache:v1:control';
const GENERATION_PREFIX = 'typecho:edge-cache:v1:g:';
const PAGE_PREFIX = 'typecho:edge-cache:v1:p:';
const SHARED_GENERATION_PREFIX = 'typecho:edge-cache:v1:sg:';
const SHARED_DATA_PREFIX = 'typecho:edge-cache:v1:s:';
const L1_ORIGIN = 'https://typecho-cache.internal';
const CONTROL_MEMO_TTL_MS = 5_000;
const GENERATION_MEMO_TTL_MS = 5_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const SHARED_DATA_TTL_SECONDS: Record<SharedCacheDomain, number> = {
  options: 604_800,
  navigation: 604_800,
  sidebar: 604_800,
  metas: 604_800,
  comments: 60,
  notes: 604_800,
};
const ALL_DOMAINS: PublicCacheDomain[] = ['home', 'post', 'page', 'note', 'archive', 'other'];
const DETAIL_DOMAINS = new Set<PublicCacheDomain>(['post', 'page', 'note']);
const ALL_SHARED_DOMAINS: SharedCacheDomain[] = ['options', 'navigation', 'sidebar', 'metas', 'comments', 'notes'];
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid']);
const NO_CACHE_CONTROL = 'no-store, no-cache, must-revalidate';
const L1_TTL_OPTIONS = [0, 3_600, 43_200, 86_400, 259_200, 604_800, 2_592_000];
const L2_TTL_OPTIONS = [0, 86_400, 259_200, 604_800];
const L3_TTL_OPTIONS = [0, 300, 3_600, 21_600, 43_200, 86_400];

export interface CachePluginConfig {
  cacheScopes: PublicCacheDomain[];
  l1Ttl: number;
  l2Ttl: number;
  l3Ttl: number;
  bypassCookieNames: string[];
  staticCdnUrl: string;
  staticExtensions: string[];
  avatarCdnUrl: string;
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

function asKv(value: unknown): KVNamespace | null {
  const candidate = value as Partial<KVNamespace> | null | undefined;
  return candidate && typeof candidate.get === 'function' && typeof candidate.put === 'function'
    ? candidate as KVNamespace
    : null;
}

function runtimeKv(): KVNamespace | null {
  return asKv(env.TYPECHO_CACHE);
}

function d1Binding(context: EarlyRequestContext): D1Database | null {
  const candidate = context.env.DB as Partial<D1Database> | undefined;
  return candidate && typeof candidate.prepare === 'function' ? candidate as D1Database : null;
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

function normalizeCookieNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,\r\n]+/);
  return [...new Set(values
    .map(item => String(item).trim())
    .filter(item => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(item)))];
}

function ttl(value: unknown, allowed: number[], fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return allowed.includes(parsed) ? parsed : fallback;
}

export function normalizeCacheConfig(settings: Record<string, unknown> | CachePluginConfig): CachePluginConfig {
  const requestedScopes = Array.isArray(settings.cacheScopes) ? settings.cacheScopes : ALL_DOMAINS;
  const cacheScopes = ALL_DOMAINS.filter(domain => requestedScopes.includes(domain));
  return {
    cacheScopes,
    l1Ttl: ttl(settings.l1Ttl, L1_TTL_OPTIONS, 604_800),
    l2Ttl: ttl(settings.l2Ttl, L2_TTL_OPTIONS, 259_200),
    l3Ttl: ttl(settings.l3Ttl, L3_TTL_OPTIONS, 21_600),
    bypassCookieNames: normalizeCookieNames(settings.bypassCookieNames),
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

async function sharedGeneration(kv: KVNamespace, domain: SharedCacheDomain): Promise<string> {
  const key = `${SHARED_GENERATION_PREFIX}${domain}`;
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

export async function invalidateSharedDomains(
  kv: KVNamespace,
  domains: SharedCacheDomain[] | ['all'],
): Promise<void> {
  const targets = domains[0] === 'all' ? ALL_SHARED_DOMAINS : [...new Set(domains)];
  await Promise.all(targets.map(async domain => {
    const key = `${SHARED_GENERATION_PREFIX}${domain}`;
    const value = nextGeneration();
    await kv.put(key, value);
    generationMemo.set(key, { value, expiresAt: Date.now() + GENERATION_MEMO_TTL_MS });
  }));
}

async function readSharedData<T>(domain: SharedCacheDomain, key: string): Promise<SharedDataRead<T>> {
  const kv = runtimeKv();
  if (!kv || !await loadControl(kv)) return { handled: false, value: null };
  const [generationValue, keyHash] = await Promise.all([sharedGeneration(kv, domain), sha256(key)]);
  const value = await kv.get<T>(`${SHARED_DATA_PREFIX}${domain}:${generationValue}:${keyHash}`, {
      type: 'json',
      cacheTtl: 60,
    });
  return { handled: true, value };
}

async function writeSharedData<T>(domain: SharedCacheDomain, key: string, value: T): Promise<boolean> {
  const kv = runtimeKv();
  if (!kv || !await loadControl(kv)) return false;
  const [generationValue, keyHash] = await Promise.all([sharedGeneration(kv, domain), sha256(key)]);
  await kv.put(
    `${SHARED_DATA_PREFIX}${domain}:${generationValue}:${keyHash}`,
    JSON.stringify(value),
    { expirationTtl: SHARED_DATA_TTL_SECONDS[domain] },
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
  value: 'L1' | 'L2' | 'L3' | 'MISS' | 'BYPASS',
  l1Ttl?: number,
): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Typecho-Cache', value);
  if (l1Ttl === 0) headers.set('Cache-Control', NO_CACHE_CONTROL);
  else if (l1Ttl) headers.set('Cache-Control', `public, max-age=0, s-maxage=${l1Ttl}`);
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

interface L3CacheRow {
  value: string;
  expiresAt: number;
}

async function readL3(d1: D1Database, cacheKey: string): Promise<StoredResponse | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await d1.prepare(
    'SELECT value, expiresAt FROM typecho_db_cache WHERE cacheKey = ? AND expiresAt > ? LIMIT 1',
  ).bind(cacheKey, now).first<L3CacheRow>();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as StoredResponse;
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
  const now = Math.floor(Date.now() / 1000);
  await d1.batch([
    d1.prepare('DELETE FROM typecho_db_cache WHERE expiresAt <= ?').bind(now),
    d1.prepare(
      'INSERT INTO typecho_db_cache (cacheKey, value, expiresAt) VALUES (?, ?, ?) ' +
      'ON CONFLICT(cacheKey) DO UPDATE SET value=excluded.value, expiresAt=excluded.expiresAt',
    ).bind(cacheKey, JSON.stringify(stored), now + ttlSeconds),
  ]);
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

export function parseCookieNames(cookieHeader: string | null): Set<string> {
  const names = new Set<string>();
  for (const part of (cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    const name = (separator >= 0 ? part.slice(0, separator) : part).trim();
    if (name) names.add(name);
  }
  return names;
}

function requestCachePolicy(request: Request, config: CachePluginConfig): RequestCachePolicy {
  if (request.headers.has('Authorization')) return 'bypass';
  const cacheControl = request.headers.get('Cache-Control')?.toLowerCase() || '';
  if (cacheControl.includes('no-cache') || cacheControl.includes('no-store')) return 'bypass';

  const cookieNames = parseCookieNames(request.headers.get('Cookie'));
  if (config.bypassCookieNames.some(name => cookieNames.has(name))) return 'bypass';
  if (
    cookieNames.has('__typecho_uid') ||
    cookieNames.has('__typecho_authCode') ||
    cookieNames.has('__typecho_unapproved_comment')
  ) {
    return 'read-only';
  }
  return 'read-write';
}

async function renderWithRuntimeRewrite(
  context: EarlyRequestContext,
  next: EarlyRequestNext,
): Promise<Response> {
  const response = await next();
  const control = requestRuntime.get(context.request);
  if (!control) return response;
  try {
    return withCacheHeader(
      await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl),
      'BYPASS',
      control.config.l1Ttl,
    );
  } catch (error) {
    console.error('[edge-cache] HTML rewrite failed:', error);
    return withCacheHeader(response, 'BYPASS', control.config.l1Ttl);
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
): Promise<Response> {
  let response = await next();
  try {
    response = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl);
  } catch (error) {
    console.error('[edge-cache] HTML rewrite failed:', error);
  }
  if (!canCacheResponse(response)) return withCacheHeader(response, 'BYPASS', control.config.l1Ttl);

  const cacheable = response.clone();
  const write = storeResponse(d1, kv, l1Key, l2Key, cacheable, control.config.l1Ttl, l2Ttl, l3Ttl)
    .catch(error => console.error('[edge-cache] Cache persistence failed:', error));
  if (context.waitUntil) context.waitUntil(write);
  else await write;
  return withCacheHeader(response, 'MISS', control.config.l1Ttl);
}

async function handleRequest(context: EarlyRequestContext, next: EarlyRequestNext): Promise<Response> {
  const kv = asKv(context.env.TYPECHO_CACHE);
  if (!kv) return renderWithRuntimeRewrite(context, next);
  const d1 = d1Binding(context);

  let control: CacheControlDocument | null;
  try {
    control = await loadControl(kv);
  } catch (error) {
    console.error('[edge-cache] Control read failed:', error);
    return renderWithRuntimeRewrite(context, next);
  }
  if (!control) return renderWithRuntimeRewrite(context, next);

  const domain = classifyCacheDomain(context.url.pathname, control);
  const normalizedUrl = normalizeCacheUrl(context.url, domain);
  const domainEnabled = control.config.cacheScopes.includes(domain);
  const policy = requestCachePolicy(context.request, control.config);
  const bypass = policy === 'bypass' || !normalizedUrl;
  const l2Ttl = control.config.l2Ttl;
  const l3Ttl = control.config.l3Ttl;
  if (!domainEnabled || bypass) {
    const response = await next();
    const rewritten = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl)
      .catch(() => response);
    return withCacheHeader(rewritten, 'BYPASS', control.config.l1Ttl);
  }

  if (control.config.l1Ttl === 0 && l2Ttl === 0 && l3Ttl === 0) {
    const response = await next();
    const rewritten = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl)
      .catch(() => response);
    return withCacheHeader(rewritten, 'BYPASS', 0);
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
    if (control.config.l1Ttl > 0) {
      const l1 = await caches.default.match(l1Key);
      if (l1) return withCacheHeader(l1, 'L1', control.config.l1Ttl);
    }

    if (l2Ttl > 0) {
      const l2 = await kv.get<StoredResponse>(l2Key, { type: 'json', cacheTtl: 60 });
      const l2Response = l2 ? responseFromStored(l2) : null;
      if (l2Response) {
        if (control.config.l1Ttl > 0) {
          const refill = withCacheHeader(l2Response.clone(), 'L2', control.config.l1Ttl);
          refill.headers.delete('X-Typecho-Cache');
          const write = caches.default.put(l1Key, refill).catch(error => {
            console.error('[edge-cache] L1 refill failed:', error);
          });
          if (context.waitUntil) context.waitUntil(write);
          else await write;
        }
        return withCacheHeader(l2Response, 'L2', control.config.l1Ttl);
      }
    }
  } catch (error) {
    console.error('[edge-cache] Cache lookup failed; falling back to D1:', error);
    return renderWithRuntimeRewrite(context, next);
  }

  if (d1 && l3Ttl > 0) {
    try {
      const l3 = await readL3(d1, l2Key);
      if (l3) {
        const l3Response = responseFromStored(l3);
        if (l3Response) {
          await promoteStoredResponse(context, kv, l1Key, l2Key, l3, control.config.l1Ttl, l2Ttl);
          return withCacheHeader(l3Response, 'L3', control.config.l1Ttl);
        }
      }
    } catch (error) {
      console.error('[edge-cache] L3 lookup failed; falling back to D1:', error);
    }
  }

  if (policy === 'read-only') {
    const response = await next();
    const rewritten = await rewriteHtmlResponse(response, control.config, context.url.origin, control.options.siteUrl)
      .catch(() => response);
    return withCacheHeader(rewritten, 'BYPASS', control.config.l1Ttl);
  }

  const existing = inFlight.get(cacheId);
  if (existing) return (await existing).clone();
  const pending = renderAndCache(context, next, control, d1, kv, l1Key, l2Key, l2Ttl, l3Ttl);
  inFlight.set(cacheId, pending);
  try {
    return (await pending).clone();
  } finally {
    if (inFlight.get(cacheId) === pending) inFlight.delete(cacheId);
  }
}

function syncRuntime(context: EarlyRequestSyncContext): void {
  if (!context.active) {
    requestRuntime.set(context.request, null);
    return;
  }
  const control = buildControlDocument(
    loadPluginConfig(context.options, CACHE_PLUGIN_ID),
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
    return;
  }
  if (!event.settings) return;
  const control = buildControlDocument(event.settings, event.options);
  runtimeConfig = control.config;
  if (!kv) return;
  await writeControl(kv, control);
  await Promise.all([
    invalidateDomains(kv, ['all']),
    invalidateSharedDomains(kv, ['all']),
  ]);
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
  await Promise.all([
    event.domains.length ? invalidateDomains(kv, event.domains) : Promise.resolve(),
    event.sharedDomains?.length ? invalidateSharedDomains(kv, event.sharedDomains) : Promise.resolve(),
  ]);
  return true;
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
  inFlight.clear();
  runtimeConfig = null;
  requestRuntime = new WeakMap<Request, CacheControlDocument | null>();
}
