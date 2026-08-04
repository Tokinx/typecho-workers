import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { generateRss2 } from '@/lib/feed';
import { clampFeedItems, buildFeedItem, getFeedRuntime, xmlResponse } from '@/lib/feed-helpers';
import { eq, and, desc } from 'drizzle-orm';
import { publishedPostCondition } from '@/lib/content-visibility';
import { findPublicMeta } from '@/lib/public-metas';

export const GET: APIRoute = async ({ locals, params }) => {
  const slug = params.slug || '';
  const { db, options, urls, pluginCtx } = await getFeedRuntime(locals);

  const tag = await findPublicMeta(db, 'tag', slug);
  if (!tag) return new Response('Not Found', { status: 404 });

  const limit = clampFeedItems(options.feedItems);
  const rows = await db
    .select({ contents: schema.contents })
    .from(schema.contents)
    .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
    .where(
      and(
        eq(schema.relationships.mid, tag.mid),
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

  const config = { title: `${options.title} - 标签：${tag.name}`, link: `${urls.siteUrl}/tag/${slug}/`, description: '', feedUrl: urls.siteUrl, language: 'zh-CN', lastBuildDate: items[0]?.date || new Date() };
  return xmlResponse(generateRss2(config, items), 'application/rss+xml; charset=utf-8');
};
