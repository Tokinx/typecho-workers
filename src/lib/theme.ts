/**
 * Theme system - discovers and manages themes from npm packages
 * 
 * Theme packages are identified by their package.json keywords
 * containing both "typecho" and "theme".
 * 
 * Theme package structure:
 *   typecho-theme-example/
 *     theme.json        - Theme metadata (required)
 *     style.css         - Main stylesheet (required)
 *     screenshot.png    - Theme preview image (optional)
 *     assets/           - Additional assets (optional)
 */

import {
  getConfigDefaults,
  parsePluginConfigFormData,
  type PluginConfigField,
} from '@/lib/plugin';

export interface ThemeManifest {
  /** Unique theme identifier */
  id: string;
  /** Display name */
  name: string;
  /** Theme description */
  description?: string;
  /** Author name */
  author?: string;
  /** Author URL */
  authorUrl?: string;
  /** Theme version */
  version?: string;
  /** Short build-time hash used to cache-bust theme stylesheets. */
  assetVersion?: string;
  /** Screenshot filename (relative to package root) */
  screenshot?: string;
  /** Main CSS file (relative to package root), defaults to 'style.css' */
  stylesheet?: string;
  /** Additional CSS files */
  stylesheets?: string[];
  /** Theme homepage / repository URL */
  homepage?: string;
  /** License */
  license?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Named Astro components available to individual pages */
  pageTemplates?: Record<string, { name: string; component: string }>;
  /** Whether comment rows are rendered during SSR or loaded from the public API. */
  commentsMode?: 'ssr' | 'api';
  /** Whether the theme's frontend HTML is safe to share across viewers. */
  publicHtml?: boolean;
  /** Typecho-style appearance settings rendered on /admin/options-theme */
  config?: Record<string, PluginConfigField>;
}

export interface ThemeInfo {
  /** Theme ID (slug) */
  id: string;
  /** npm package name */
  packageName: string;
  /** Theme manifest from theme.json */
  manifest: ThemeManifest;
  /** Whether this is the built-in default theme */
  isDefault: boolean;
  /** Whether this theme is currently active */
  isActive: boolean;
  /** Resolved CSS content (for serving) */
  cssPath: string;
}

/** Built-in fallback theme definition (when no themes are discovered) */
const WARM_THEME_CONFIG: Record<string, PluginConfigField> = {
  githubUrl: { type: 'text', label: 'GitHub 地址', default: '' },
  socialUrl: { type: 'text', label: '社交主页地址', default: '' },
  email: { type: 'text', label: '联系邮箱', default: '' },
  continuousLoadMode: {
    type: 'select',
    label: '内容列表',
    description: '控制首页、分类和笔记内容列表后续页的加载方式。',
    default: 'manual',
    options: { manual: '手动加载', 'auto-2': '滚动加载 2 次', infinite: '无限滚动加载' },
  },
  commentComponentLoadMode: {
    type: 'select',
    label: '评论组件',
    description: '控制评论框及其表单配置的加载方式。',
    default: 'manual',
    options: { manual: '手动加载', dwell: '停留 3 秒加载', auto: '自动加载' },
  },
  commentInitialLoadMode: {
    type: 'select',
    label: '评论列表',
    default: 'manual',
    options: { manual: '手动加载', 'auto-first': '加载第一页', 'auto-2': '滚动加载 2 次', infinite: '无限滚动加载' },
  },
};

const FALLBACK_THEME: ThemeManifest = {
  id: 'typecho-theme-warm',
  name: 'Typecho Warm',
  description: '静谧温润的单栏写作主题，支持文章与笔记混合时间线。',
  author: 'Tokinx',
  version: '1.0.0',
  assetVersion: '1.0.0',
  stylesheet: '/themes/typecho-theme-warm/style.css',
  homepage: 'https://github.com/Tokinx/typecho-workers/tree/master/src/themes/typecho-theme-warm',
  license: 'MIT',
  commentsMode: 'api',
  publicHtml: true,
  config: WARM_THEME_CONFIG,
};

/**
 * Module-level state — safe in Cloudflare Workers because:
 * 1. Workers are single-threaded per request
 * 2. themeRegistry is populated once at build time by the theme-loader integration
 *    and is effectively read-only at runtime (no mutations after init)
 */

/**
 * Registry of all discovered themes
 * Key: theme ID (slug), Value: ThemeInfo
 *
 * This is populated at build time by the theme-loader integration.
 * Themes are npm packages whose keywords contain both "typecho" and "theme".
 * The default theme is also discovered this way (typecho-theme-warm package).
 */
const themeRegistry = new Map<string, ThemeInfo>();

/**
 * Discover and register themes from npm packages.
 * 
 * Theme discovery happens at BUILD TIME via the theme-loader integration.
 * The discovered themes are compiled into the bundle as a static registry.
 * In Cloudflare Workers runtime, we can't access the filesystem.
 */

// Theme CSS is served from /themes/{id}/style.css
// We use a virtual module pattern to bundle theme CSS at build time.

/**
 * Get all available themes (including the built-in default)
 */
export function getAvailableThemes(activeThemeId: string): ThemeInfo[] {
  const themes: ThemeInfo[] = [];

  // All themes come from the registry (including default)
  for (const [id, info] of themeRegistry) {
    themes.push({
      ...info,
      manifest: normalizeThemeManifest(id, info.manifest),
      isActive: activeThemeId === id,
    });
  }

  // Keep the built-in theme available even when a test adapter or a partial
  // installation does not expose the npm package in the runtime registry.
  if (!themeRegistry.has(FALLBACK_THEME.id)) {
    themes.push({
      id: FALLBACK_THEME.id,
      packageName: 'built-in',
      manifest: FALLBACK_THEME,
      isDefault: true,
      isActive: activeThemeId === FALLBACK_THEME.id || themes.length === 0,
      cssPath: FALLBACK_THEME.stylesheet || '/themes/typecho-theme-warm/style.css',
    });
  }

  return themes;
}

/**
 * Get the active theme info
 */
export function getActiveTheme(activeThemeId: string): ThemeInfo {
  const theme = themeRegistry.get(activeThemeId);
  if (theme) {
    return { ...theme, manifest: normalizeThemeManifest(activeThemeId, theme.manifest), isActive: true };
  }

  // Fallback to default theme from registry
  const defaultTheme = themeRegistry.get(FALLBACK_THEME.id);
  if (defaultTheme) {
    return { ...defaultTheme, manifest: normalizeThemeManifest(defaultTheme.id, defaultTheme.manifest), isActive: true };
  }

  // Ultimate fallback if no themes discovered at all
  return {
    id: FALLBACK_THEME.id,
    packageName: 'built-in',
    manifest: FALLBACK_THEME,
    isDefault: true,
    isActive: true,
    cssPath: FALLBACK_THEME.stylesheet || '/themes/typecho-theme-warm/style.css',
  };
}

/**
 * Register an npm theme into the registry.
 * Called by the theme loader integration at build time.
 */
export function registerTheme(
  packageName: string,
  manifest: ThemeManifest,
  cssPath: string,
): void {
  const id = manifest.id || packageName;
  const normalizedManifest = normalizeThemeManifest(id, manifest);
  themeRegistry.set(id, {
    id,
    packageName,
    manifest: normalizedManifest,
    isDefault: id === FALLBACK_THEME.id,
    isActive: false,
    cssPath,
  });
}

/**
 * Get the CSS path(s) for a theme
 * Order: stylesheets (base CSS like normalize/grid) → main stylesheet
 */
export function getThemeStylesheets(activeThemeId: string): string[] {
  const theme = getActiveTheme(activeThemeId);
  const sheets: string[] = [];
  const assetVersion = theme.manifest.assetVersion;

  // Additional stylesheets first (e.g. normalize.css, grid.css)
  if (theme.manifest.stylesheets) {
    for (const extra of theme.manifest.stylesheets) {
      const href = extra.startsWith('/') ? extra : `/themes/${theme.id}/${extra}`;
      sheets.push(withAssetVersion(href, assetVersion));
    }
  }

  // Main stylesheet last
  sheets.push(withAssetVersion(theme.cssPath, assetVersion));

  return sheets;
}

function withAssetVersion(href: string, assetVersion?: string): string {
  if (!assetVersion) return href;
  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}v=${encodeURIComponent(assetVersion)}`;
}

/**
 * Check if a theme exists
 */
export function themeExists(themeId: string): boolean {
  return themeRegistry.has(themeId) || themeId === FALLBACK_THEME.id;
}

/** Check whether a theme exposes appearance settings. */
export function themeHasConfig(themeId: string): boolean {
  const theme = getThemeInfo(themeId);
  return !!theme?.manifest.config && Object.keys(theme.manifest.config).length > 0;
}

/** Return a theme's manifest configuration definition. */
export function getThemeConfigDefinition(themeId: string): Record<string, PluginConfigField> | undefined {
  return getThemeInfo(themeId)?.manifest.config;
}

/** Return the default values declared by a theme manifest. */
export function getThemeConfigDefaults(themeId: string): Record<string, any> {
  return getConfigDefaults(getThemeConfigDefinition(themeId));
}

/**
 * Load a theme's settings from the options snapshot. Values are namespaced by
 * theme id so switching themes cannot leak one theme's settings into another.
 */
export function loadThemeConfig(
  options: Record<string, any>,
  themeId: string,
): Record<string, any> {
  const defaults = getThemeConfigDefaults(themeId);
  const raw = options?.[`theme:${themeId}`];
  if (!raw) return { ...defaults };

  try {
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return saved && typeof saved === 'object' ? { ...defaults, ...saved } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

/** Parse a theme config form using the same field semantics as plugins. */
export const parseThemeConfigFormData = parsePluginConfigFormData;

function getThemeInfo(themeId: string): ThemeInfo | undefined {
  const theme = themeRegistry.get(themeId);
  if (theme) {
    return { ...theme, manifest: normalizeThemeManifest(themeId, theme.manifest), isActive: false };
  }
  if (themeId === FALLBACK_THEME.id) {
    return {
      id: FALLBACK_THEME.id,
      packageName: 'built-in',
      manifest: FALLBACK_THEME,
      isDefault: true,
      isActive: true,
      cssPath: FALLBACK_THEME.stylesheet || '/themes/typecho-theme-warm/style.css',
    };
  }
  return undefined;
}

function normalizeThemeManifest(themeId: string, manifest: ThemeManifest): ThemeManifest {
  const commentsMode = manifest.commentsMode === 'api'
    ? 'api'
    : manifest.commentsMode === 'ssr'
      ? 'ssr'
      : themeId === FALLBACK_THEME.id
        ? 'api'
        : 'ssr';
  if (themeId !== FALLBACK_THEME.id) return { ...manifest, id: themeId, commentsMode, publicHtml: manifest.publicHtml === true };

  // Preserve metadata from an installed default theme while keeping the
  // built-in Warm fallback complete when its package is not registered.
  return {
    ...FALLBACK_THEME,
    ...manifest,
    id: themeId,
    commentsMode,
    publicHtml: manifest.publicHtml !== false,
    config: {
      ...WARM_THEME_CONFIG,
      ...manifest.config,
    },
  };
}

/**
 * Get theme count
 */
export function getThemeCount(): number {
  return themeRegistry.size;
}
