/**
 * Shared utilities for feed generation — used by the main feed route and
 * sub-channel feeds (category / tag / author).
 */

import type { FeedItem } from '@/lib/feed';
import { buildPermalink } from '@/lib/content';
import { generateRss2, generateAtom, generateRss1 } from '@/lib/feed';
import { renderContent } from '@/lib/markdown';
import { loadThemeConfig } from '@/lib/theme';
import { normalizeOptimizeParams, optimizeContentImages } from '@/lib/image-transform';
import {
  applyFilterSafely,
  parseActivatedPlugins,
  setActivatedPlugins,
  type HookContext,
} from '@/lib/plugin';
import { getDb } from '@/db';
import { computeUrls, loadOptions } from '@/lib/options';
import { getRequestCoreContextFromLocals } from '@/lib/context';
import { env } from 'cloudflare:workers';

export const FEED_ITEMS_DEFAULT = 10;
export const FEED_ITEMS_MIN = 5;
export const FEED_ITEMS_MAX = 50;

export function clampFeedItems(rawValue: unknown): number {
  const n = parseInt(String(rawValue ?? FEED_ITEMS_DEFAULT), 10) || FEED_ITEMS_DEFAULT;
  return Math.min(FEED_ITEMS_MAX, Math.max(FEED_ITEMS_MIN, n));
}

/**
 * EdgeOne image params declared by the active theme. Themes without the
 * field (or an unknown theme id) yield an empty string — no rewriting.
 */
export function getThemeImageOptimizeParams(options: Record<string, any>): string {
  return normalizeOptimizeParams(loadThemeConfig(options, options?.theme).imageOptimizeParams);
}

export async function getFeedRuntime(locals: App.Locals) {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  const pluginCtx: HookContext = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) {
    await setActivatedPlugins(
      pluginCtx,
      parseActivatedPlugins(options.activatedPlugins as string | undefined),
    );
  }
  return { db, options, urls: computeUrls(options), pluginCtx };
}

export async function buildFeedItem(
  post: { cid: number; slug: string | null; type: string | null; created: number | null; title: string | null; text?: string | null },
  siteUrl: string,
  permalinkPattern: string | undefined,
  pagePattern: string | undefined,
  pluginCtx: HookContext,
  feedFullText?: boolean,
  optimizeParams?: string,
): Promise<FeedItem> {
  const rendered = renderContent(post.text || '');
  const link = buildPermalink(post, siteUrl, permalinkPattern, pagePattern);

  let item: FeedItem = {
    title: post.title || '无标题',
    link,
    content: feedFullText ? optimizeContentImages(rendered.html, optimizeParams || '', siteUrl) : '',
    excerpt: rendered.plainExcerpt,
    date: new Date((post.created || 0) * 1000),
  };

  item = await applyFilterSafely(pluginCtx, 'feed:item', item);
  return item;
}

export function xmlResponse(xml: string, contentType: string): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, s-maxage=1800',
    },
  });
}
