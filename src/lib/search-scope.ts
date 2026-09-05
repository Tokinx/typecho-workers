/**
 * Resolve public search scope from Engine plugin settings.
 * Core-owned so page-data does not import the plugin package.
 */
import { parsePluginOption } from '@/lib/plugin';

export const ENGINE_PLUGIN_ID = 'typecho-plugin-engine';
export const ENGINE_SUMMARY_FIELD = 'engine_summary';

export type SearchScope = 'default' | 'title' | 'title_summary';

export function resolveSearchScope(
  options: Record<string, unknown>,
  activatedPlugins: Set<string> | Iterable<string>,
): SearchScope {
  const active = activatedPlugins instanceof Set
    ? activatedPlugins
    : new Set(activatedPlugins);
  if (!active.has(ENGINE_PLUGIN_ID)) return 'default';

  const raw = parsePluginOption(options[`plugin:${ENGINE_PLUGIN_ID}`]);
  const scope = String(raw.searchScope || 'default').trim();
  if (scope === 'title' || scope === 'title_summary') return scope;
  return 'default';
}
