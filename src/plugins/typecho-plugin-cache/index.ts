import { env } from 'cloudflare:workers';
import { addCspSource } from '@/lib/security-headers';
import { loadPluginConfig } from '@/lib/plugin';
import type { PluginInitContext } from 'typecho/plugin-sdk';
import type { PublicCacheDomain } from '@/lib/cache';
import { cacheAdminPageHtml } from './admin';
import {
  CACHE_CONTROL_KEY,
  CACHE_PLUGIN_ID,
  buildControlDocument,
  earlyRequestProvider,
  getCacheRuntimeConfig,
  invalidateDomains,
  invalidateSharedDomains,
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

async function syncControl(options: Record<string, unknown>): Promise<void> {
  const settings = loadPluginConfig(options, CACHE_PLUGIN_ID);
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
      return {
        success: true,
        settings: {
          ...(extra.settings || {}),
          ...normalized,
          staticExtensions: normalized.staticExtensions.join(','),
          bypassCookieNames: normalized.bypassCookieNames.join(','),
          l1Ttl: String(normalized.l1Ttl),
          l2Ttl: String(normalized.l2Ttl),
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

  addHook('admin:page', pluginId, (html: string, extra?: { slug?: string; csrfToken?: string }) => {
    if (extra?.slug !== 'cache') return html;
    return cacheAdminPageHtml(extra.csrfToken || '', !!kvBinding());
  });

  addHook('admin:footer', pluginId, (html: string, extra?: { user?: { group?: string }; activeMenu?: string }) => {
    if (extra?.user?.group !== 'administrator') return html;
    const active = extra.activeMenu === 'cache';
    return html + `<script>(function(){var menu=document.querySelector('.typecho-head-nav nav > menu > li:nth-child(3) > menu');if(!menu||menu.querySelector('a[href="/admin/plugin/cache"]'))return;var item=document.createElement('li');item.className=${active ? JSON.stringify('focus') : JSON.stringify('')};item.innerHTML='<a href="/admin/plugin/cache">缓存</a>';menu.appendChild(item)})();</script>`;
  });

  addHook(`plugin:${pluginId}:action:auth`, pluginId, () => 'administrator');
  addHook(`plugin:${pluginId}:action`, pluginId, async (result: any, extra?: { action?: string; payload?: any }) => {
    if (extra?.action !== 'invalidate') return result;
    const kv = kvBinding();
    if (!kv) return { handled: true, success: false, error: '未配置 TYPECHO_CACHE binding' };
    const requested = String(extra.payload?.domain || 'all');
    const allowed = new Set<PublicCacheDomain | 'all'>(['home', 'post', 'page', 'note', 'archive', 'other', 'all']);
    if (!allowed.has(requested as PublicCacheDomain | 'all')) {
      return { handled: true, success: false, error: '缓存域无效' };
    }
    await invalidateDomains(kv, [requested as PublicCacheDomain] as PublicCacheDomain[] | ['all']);
    if (requested === 'all') await invalidateSharedDomains(kv, ['all']);
    return { handled: true, success: true, message: '缓存代际已更新' };
  });
}

void earlyRequestProvider;
