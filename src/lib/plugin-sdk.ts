// Plugin SDK — public API surface for Typecho plugins and themes.
// Plugins import from 'typecho/plugin-sdk'; the host project resolves it
// via package.json exports (self-referencing).

// ── Types ──
export type { PluginInitContext, PluginRouteResult, PluginManifest, PluginConfigField } from './plugin';
export type { AttachmentMeta } from './attachment';
export type { Database } from '../db/index';
export type {
  EarlyRequestProvider,
  EarlyRequestContext,
  EarlyRequestLifecycleEvent,
  EarlyRequestSyncContext,
} from './early-request';
export type { PublicCacheDomain, PublicCacheInvalidation } from './cache';

// ── Plugin system ──
export {
  HookPoints,
  parsePluginOption,
  parsePluginConfigFormData,
  loadPluginConfig,
  escapeAttr,
  registerPluginAdminPath,
} from './plugin';
export { getClientIp } from './client-ip';

// ── Auth ──
export { hasPermission, verifyPassword } from './auth';

// ── Content ──
export { buildPermalink, formatDate, buildAuthorLink, buildCategoryLink } from './content';
export { compilePermalinkPattern, renderPermalinkPattern } from './permalink-pattern';

// ── Markdown / HTML ──
export { escapeHtml } from './escape';
export {
  renderMarkdown,
  renderMarkdownFiltered,
  renderContentExcerpt,
  generateExcerpt,
  autop,
  stripTypechoMarkers,
  stripHtmlTags,
} from './markdown';

// ── Network ──
export { fetchWithTimeout } from './fetch';

// ── Attachments ──
export { parseAttachmentMeta } from './attachment';

// ── URL ──
export { normalizeHttpUrl } from './url';

// ── Options ──
export { getOption, setOption } from './options';
