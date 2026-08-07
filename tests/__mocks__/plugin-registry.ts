/**
 * Vitest stand-in for `virtual:typecho-plugin-registry`.
 *
 * In production the plugin-loader Astro integration generates this module:
 * registerPluginLoaders() with one lazy dynamic import per plugin. The
 * middleware statically imports it so plugin loaders are registered before
 * the first request of a cold isolate runs setActivatedPlugins — page-ssr
 * scripts only execute after a page chunk loads, which never happens for a
 * plugin route like /api/admin/notes.
 *
 * Vitest does not run Astro integrations, so this file mirrors the generated
 * registry for the workspace plugins. Keep it in sync with src/plugins/*.
 * Loaders stay lazy: a plugin module is only evaluated once activated, which
 * keeps unrelated tests free of plugin side effects.
 */
import { registerPluginLoaders, addHook, HookPoints } from '@/lib/plugin';
import { registerEarlyRequestLoaders } from '@/lib/early-request';

registerPluginLoaders({
  'typecho-plugin-antispam': () => import('@/plugins/typecho-plugin-antispam/index').then((module) => module.default),
  'typecho-plugin-cache': () => import('@/plugins/typecho-plugin-cache/index').then((module) => module.default),
  'typecho-plugin-mailer': () => import('@/plugins/typecho-plugin-mailer/index').then((module) => module.default),
  'typecho-plugin-notes': () => import('@/plugins/typecho-plugin-notes/index').then((module) => module.default),
  'typecho-plugin-scribe': () => import('@/plugins/typecho-plugin-scribe/index').then((module) => module.default),
  'typecho-plugin-turnstile': () => import('@/plugins/typecho-plugin-turnstile/index').then((module) => module.default),
}, { addHook, HookPoints });

registerEarlyRequestLoaders({
  'typecho-plugin-cache': () => import('@/plugins/typecho-plugin-cache/index').then((module) => module.earlyRequestProvider),
});

export {};
