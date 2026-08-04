import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { generateRss2, generateAtom } from '@/lib/feed';
import { clampFeedItems, buildFeedItem, getFeedRuntime, xmlResponse } from '@/lib/feed-helpers';
import { eq, and, desc } from 'drizzle-orm';
import { publishedPostCondition } from '@/lib/content-visibility';
import { findPublicMeta } from '@/lib/public-metas';

export const GET: APIRoute = async ({ locals, params }) => {
  const slug = params.slug || '';
  const { db, options, urls, pluginCtx } = await getFeedRuntime(locals);

  const cat = await findPublicMeta(db, 'category', slug);
  if (!cat) return new Response('Not Found', { status: 404 });

  const limit = clampFeedItems(options.feedItems);
  const rows = await db
    .select({ contents: schema.contents })
    .from(schema.contents)
    .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
    .where(
      and(
        eq(schema.relationships.mid, cat.mid),
        publishedPostCondition(),
        eq(schema.contents.allowFeed, '1'),
      ),
    )
    .orderBy(desc(schema.contents.created))
    .limit(limit);

  const items = [];
  for (const { contents: p } of rows) {
    items.push(
      await buildFeedItem(p, urls.siteUrl, options.permalinkPattern as string | undefined, undefined, pluginCtx, !!(options.feedFullText)),
    );
  }

  const isAtom = params.slug?.startsWith('atom-');
  const config = { title: `${options.title} - 分类：${cat.name}`, link: `${urls.siteUrl}/category/${slug}/`, description: '', feedUrl: urls.siteUrl, language: 'zh-CN', lastBuildDate: items[0]?.date || new Date() };
  const xml = isAtom ? generateAtom(config, items) : generateRss2(config, items);
  return xmlResponse(xml, isAtom ? 'application/atom+xml; charset=utf-8' : 'application/rss+xml; charset=utf-8');
};
