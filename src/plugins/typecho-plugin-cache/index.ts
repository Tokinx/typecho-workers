import { env } from 'cloudflare:workers';
import { addCspSource } from '@/lib/security-headers';
import { loadPluginConfig, parsePluginOption } from '@/lib/plugin';
import { notifyEarlyRequestInvalidation } from '@/lib/early-request';
import type { PluginInitContext } from 'typecho/plugin-sdk';
import type { PublicCacheDomain, PublicCacheInvalidation, SharedCacheDomain } from '@/lib/cache';
import { cacheAdminPageHtml } from './admin';
import {
  ADMIN_DATA_CACHE_DOMAINS,
  CACHE_CONTROL_KEY,
  CACHE_PLUGIN_ID,
  buildControlDocument,
  compactD1Cache,
  earlyRequestProvider,
  FRONTEND_DATA_CACHE_DOMAINS,
  getCacheRuntimeConfig,
  invalidateDomains,
  LAST_REFRESH_KEY,
  normalizeCacheConfig,
  rewriteResourceUrl,
  setCacheRuntimeConfig,
} from './cache';

export { earlyRequestProvider };
export * from './cache';

function kvBinding(): KVNamespace | null {
  const candidate = env.TYPECHO_CACHE as KVNamespace | undefined;
  return candidate && typeof candidate.get === 'function' && typeof candidate.put === 'function' ? candidate : null;
}

const HTML_DOMAIN_ALLOWED = new Set<string>(['home', 'post', 'page', 'note', 'archive', 'other', 'all']);
const DATA_GROUP_ALLOWED = new Set<string>(['frontend', 'admin', 'all']);
const DATA_GROUP_DOMAINS: Record<'frontend' | 'admin', SharedCacheDomain[]> = {
  frontend: [...FRONTEND_DATA_CACHE_DOMAINS],
  admin: [...ADMIN_DATA_CACHE_DOMAINS],
};

async function syncControl(options: Record<string, unknown>): Promise<void> {
  const settings = parsePluginOption(options[`plugin:${CACHE_PLUGIN_ID}`]);
  setCacheRuntimeConfig(settings);
  const kv = kvBinding();
  if (!kv) return;
  const next = buildControlDocument(settings, options);
  const current = await kv.get(CACHE_CONTROL_KEY, { type: 'text', cacheTtl: 60 });
  if (!current) {
    await kv.put(CACHE_CONTROL_KEY, JSON.stringify(next));
    return;
  }
  try {
    const parsed = JSON.parse(current) as { active?: boolean; config?: Record<string, unknown> };
    if (parsed.active === true && parsed.config) {
      setCacheRuntimeConfig(parsed.config);
      return;
    }
  } catch {
    // Replace malformed control state from the authoritative activated config.
  }
  await kv.put(CACHE_CONTROL_KEY, JSON.stringify(next));
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  addHook('system:begin', pluginId, async (context?: { options?: Record<string, unknown> }) => {
    if (context?.options) await syncControl(context.options);
  });

  addHook('plugin:config:beforeSave', pluginId, (result: any, extra?: any) => {
    if (extra?.pluginId !== pluginId) return result;
    try {
      const normalized = normalizeCacheConfig(extra.settings || {});
      const {
        dataCacheBackends: _legacyDataCacheBackends,
        legacyDataCacheBackends: _normalizedLegacyDataCacheBackends,
        bypassCookieNames: _legacyBypassCookieNames,
        ...savedSettings
      } = extra.settings || {};
      return {
        success: true,
        settings: {
          ...savedSettings,
          cacheScopes: normalized.cacheScopes,
          frontendDataCacheBackend: normalized.frontendDataCacheBackend,
          adminDataCacheBackend: normalized.adminDataCacheBackend,
          staticExtensions: normalized.staticExtensions.join(','),
          l1Ttl: String(normalized.l1Ttl),
          l2Ttl: String(normalized.l2Ttl),
          l3Ttl: String(normalized.l3Ttl),
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '缓存配置无效' };
    }
  });

  addHook('csp:directives', pluginId, (directives: Record<string, string[]>, extra?: { options?: Record<string, unknown> }) => {
    const config = extra?.options
      ? normalizeCacheConfig(loadPluginConfig(extra.options, pluginId))
      : getCacheRuntimeConfig();
    if (config.staticCdnUrl) {
      const source = new URL(config.staticCdnUrl).origin;
      for (const directive of ['img-src', 'style-src', 'script-src', 'font-src', 'media-src']) {
        addCspSource(directives, directive, [source]);
      }
    }
    if (config.avatarCdnUrl) addCspSource(directives, 'img-src', [new URL(config.avatarCdnUrl).origin]);
    return directives;
  });

  addHook('comment:avatarMap', pluginId, (
    avatars: Record<string, string>,
    extra?: { request?: Request; options?: Record<string, unknown> },
  ) => {
    if (!extra?.options) return avatars;
    const config = normalizeCacheConfig(loadPluginConfig(extra.options, pluginId));
    if (!config.avatarCdnUrl) return avatars;
    const siteUrl = String(extra.options.siteUrl || extra.request?.url || '');
    let requestOrigin = siteUrl;
    try {
      requestOrigin = new URL(extra.request?.url || siteUrl).origin;
    } catch {
      return avatars;
    }
    return Object.fromEntries(Object.entries(avatars).map(([coid, avatarUrl]) => [
      coid,
      rewriteResourceUrl(avatarUrl, config, requestOrigin, siteUrl),
    ]));
  });

  addHook('admin:page', pluginId, async (html: string, extra?: {
    slug?: string;
    csrfToken?: string;
    options?: Record<string, unknown>;
  }) => {
    if (extra?.slug !== 'cache') return html;
    const config = extra?.options
      ? normalizeCacheConfig(loadPluginConfig(extra.options, pluginId))
      : getCacheRuntimeConfig();
    const kv = kvBinding();
    let lastRefresh: string | null = null;
    if (kv) {
      try {
        lastRefresh = (await kv.get(LAST_REFRESH_KEY, { type: 'text' })) as string | null;
      } catch {
        lastRefresh = null;
      }
    }
    return cacheAdminPageHtml({
        csrfToken: extra.csrfToken || '',
        bindingAvailable: !!kv,
        config,
        lastRefresh,
      })
      + `<script>(function(){var title=document.querySelector('.typecho-page-title');if(!title||title.querySelector('a[href="/admin/plugin-config?id=${CACHE_PLUGIN_ID}"]'))return;var link=document.createElement('a');link.href='/admin/plugin-config?id=${CACHE_PLUGIN_ID}';link.textContent='设置';title.appendChild(link)})();</script>`;
  });

  addHook('admin:footer', pluginId, (html: string, extra?: { user?: { group?: string }; activeMenu?: string }) => {
    if (extra?.user?.group !== 'administrator') return html;
    const active = extra.activeMenu === 'cache';
    return html + `<script>(function(){var menu=document.querySelector('.typecho-head-nav nav > menu > li:nth-child(4) > menu');if(!menu||menu.querySelector('a[href="/admin/plugin/cache"]'))return;var item=document.createElement('li');item.className=${active ? JSON.stringify('focus') : JSON.stringify('')};item.innerHTML='<a href="/admin/plugin/cache">缓存管理</a>';menu.appendChild(item)})();</script>`;
  });

  addHook(`plugin:${pluginId}:action:auth`, pluginId, () => 'administrator');
  addHook(`plugin:${pluginId}:action`, pluginId, async (result: any, extra?: { action?: string; payload?: any }) => {
    if (extra?.action === 'compact') {
      const d1 = env.DB as D1Database | undefined;
      if (!d1 || typeof d1.prepare !== 'function') {
        return { handled: true, success: false, error: 'DB 不可用' };
      }
      try {
        const deleted = await compactD1Cache(d1);
        return {
          handled: true,
          success: true,
          message: deleted > 0 ? `已清理 ${deleted} 行过期缓存` : '没有过期缓存行',
          compacted: deleted,
        };
      } catch (error) {
        return { handled: true, success: false, error: error instanceof Error ? error.message : '清理失败' };
      }
    }
    if (extra?.action !== 'invalidate') return result;

    const payload = extra.payload || {};
    // payload.domains 支持批量刷新（新前端）；兼容旧的单 domain 字段。
    let rawDomains: string[];
    if (Array.isArray(payload.domains)) {
      rawDomains = payload.domains.map(String);
    } else if (payload.domain !== undefined && payload.domain !== null) {
      rawDomains = [String(payload.domain)];
    } else if (Array.isArray(payload.data) && payload.data.length > 0) {
      rawDomains = [];
    } else {
      rawDomains = ['all'];
    }
    // Legacy clients without the data field keep their historical semantics:
    // an absent domain list used to mean a full refresh.
    const dataSpecified = Array.isArray(payload.data) ? payload.data.map(String) : undefined;
    if (!dataSpecified && rawDomains.length === 0) rawDomains = ['all'];
    const requestedDataGroups: string[] = dataSpecified ?? (rawDomains.includes('all') ? ['all'] : []);

    if (rawDomains.includes('all')) {
      rawDomains = ['all'];
    } else {
      rawDomains = [...new Set(rawDomains)];
      if (rawDomains.some(domain => !HTML_DOMAIN_ALLOWED.has(domain))) {
        return { handled: true, success: false, error: '缓存域无效' };
      }
    }
    const dataGroups: string[] = requestedDataGroups.includes('all')
      ? ['all']
      : [...new Set(requestedDataGroups)];
    if (dataGroups.some(group => !DATA_GROUP_ALLOWED.has(group))) {
      return { handled: true, success: false, error: '数据缓存组无效' };
    }

    const sharedDomains: SharedCacheDomain[] | ['all'] = dataGroups[0] === 'all'
      ? ['all']
      : dataGroups.flatMap(group => DATA_GROUP_DOMAINS[group as 'frontend' | 'admin'] ?? []);
    const event: PublicCacheInvalidation = {
      reason: 'manual',
      domains: rawDomains as PublicCacheDomain[] | ['all'],
      ...(sharedDomains.length ? { sharedDomains } : {}),
    };
    // Production reaches the registered early provider, which also clears local
    // in-flight shared loads. The direct fallback keeps plugin actions usable
    // in an already initialized isolate before the generated loader registry
    // has been imported.
    const handled = await notifyEarlyRequestInvalidation(event)
      || await earlyRequestProvider.invalidate!(event);
    if (!handled) {
      return { handled: true, success: false, error: '缓存后端不可用或所选缓存组未启用' };
    }
    const kv = kvBinding();
    if (kv) await kv.put(LAST_REFRESH_KEY, new Date().toISOString()).catch(() => {});
    return { handled: true, success: true, message: '刷新完成', groups: { html: rawDomains, data: dataGroups } };
  });
}

void earlyRequestProvider;
