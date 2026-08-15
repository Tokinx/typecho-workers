/**
 * Sidebar data loader
 * Aggregates recent posts, comments, categories, and archives
 * Uses db.batch() to execute all queries in a single D1 round-trip.
 */
import { eq, desc, and, sql } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { buildPermalink, buildCategoryLink, buildDateLink } from '@/lib/content';
import { applyFilterSafely, type HookContext } from '@/lib/plugin';
import { publishedPostCondition } from '@/lib/content-visibility';
import { loadEarlyRequestSharedData } from '@/lib/early-request';

type SidebarDatabase = Pick<Database, 'batch' | 'select'>;
export interface SidebarData {
  recentPosts: Array<{ title: string; permalink: string }>;
  recentComments: Array<{ author: string; excerpt: string; permalink: string }>;
  categories: Array<{ name: string; slug: string; count: number; permalink: string }>;
  archives: Array<{ date: string; permalink: string }>;
}

export type NavPage = { title: string; slug: string; permalink: string };

function cloneSidebarData(data: SidebarData): SidebarData {
  return {
    recentPosts: data.recentPosts.map(item => ({ ...item })),
    recentComments: data.recentComments.map(item => ({ ...item })),
    categories: data.categories.map(item => ({ ...item })),
    archives: data.archives.map(item => ({ ...item })),
  };
}

export async function loadSidebarData(
  ctx: HookContext,
  db: SidebarDatabase,
  siteUrl: string,
  permalinkPattern?: string | null,
  categoryPattern?: string | null,
  _cacheVersion: string | number = 0,
): Promise<SidebarData> {
  const cacheKey = JSON.stringify([_cacheVersion, siteUrl, permalinkPattern || '', categoryPattern || '']);
  const sidebarData = await loadEarlyRequestSharedData('sidebar', cacheKey, async () => {
    // Execute all 4 queries in a single D1 round-trip
    const [recentPostRows, recentCommentRows, categoryRows, archiveRows] = await db.batch([
      // Recent posts
      db
        .select({
          cid: schema.contents.cid,
          title: schema.contents.title,
          slug: schema.contents.slug,
          type: schema.contents.type,
          created: schema.contents.created,
        })
        .from(schema.contents)
        .where(publishedPostCondition())
        .orderBy(desc(schema.contents.created))
        .limit(10),

    // Recent comments — only need a short preview, not the whole body.
    db
      .select({
        coid: schema.comments.coid,
        cid: schema.comments.cid,
        author: schema.comments.author,
        text: sql<string>`substr(${schema.comments.text}, 1, 200)`,
      })
      .from(schema.comments)
      .where(eq(schema.comments.status, 'approved'))
      .orderBy(desc(schema.comments.created))
      .limit(10),

    // Categories
    db
      .select({
        name: schema.metas.name,
        slug: schema.metas.slug,
        count: schema.metas.count,
        order: schema.metas.order,
      })
      .from(schema.metas)
      .where(eq(schema.metas.type, 'category'))
      .orderBy(schema.metas.order),

    // Archives (by month)
    db
      .select({
        year: sql<number>`cast(strftime('%Y', ${schema.contents.created}, 'unixepoch') as integer)`,
        month: sql<number>`cast(strftime('%m', ${schema.contents.created}, 'unixepoch') as integer)`,
      })
      .from(schema.contents)
      .where(publishedPostCondition())
      .groupBy(
        sql`strftime('%Y', ${schema.contents.created}, 'unixepoch')`,
        sql`strftime('%m', ${schema.contents.created}, 'unixepoch')`,
      )
      .orderBy(desc(sql`strftime('%Y', ${schema.contents.created}, 'unixepoch')`), desc(sql`strftime('%m', ${schema.contents.created}, 'unixepoch')`)),
    ] as const);

    const recentPosts = recentPostRows.map((p) => ({
      title: p.title || '无标题',
      permalink: buildPermalink(
        { cid: p.cid, slug: p.slug, type: p.type, created: p.created },
        siteUrl,
        permalinkPattern,
      ),
    }));

    const recentComments = recentCommentRows.map((c) => ({
      author: c.author || '匿名',
      excerpt: (c.text || '').replace(/<[^>]+>/g, '').substring(0, 35) + (c.text && c.text.length > 35 ? '...' : ''),
      permalink: `${siteUrl.replace(/\/$/, '')}/archives/${c.cid}/#comment-${c.coid}`,
    }));

    const categories = categoryRows.map((c) => ({
      name: c.name || '',
      slug: c.slug || '',
      count: c.count || 0,
      permalink: buildCategoryLink(c.slug || '', siteUrl, categoryPattern),
    }));

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];

    const archives = archiveRows.map((a) => ({
      date: `${monthNames[a.month - 1]} ${a.year}`,
      permalink: buildDateLink(a.year, a.month, undefined, siteUrl),
    }));

    return { recentPosts, recentComments, categories, archives };
  });

  // Apply widget:sidebar filter — plugins can add/modify sidebar widgets
  return await applyFilterSafely(ctx, 'widget:sidebar', cloneSidebarData(sidebarData), db, siteUrl);
}

/**
 * Load navigation pages (published pages for header nav)
 */
export async function loadNavPages(
  db: SidebarDatabase,
  siteUrl: string,
  pagePattern?: string | null,
  _cacheVersion: string | number = 0,
): Promise<NavPage[]> {
  const cacheKey = JSON.stringify([_cacheVersion, siteUrl, pagePattern || '']);
  return loadEarlyRequestSharedData('navigation', cacheKey, async () => {
    const rows = await db
      .select({
        cid: schema.contents.cid,
        title: schema.contents.title,
        slug: schema.contents.slug,
        type: schema.contents.type,
        created: schema.contents.created,
        order: schema.contents.order,
      })
      .from(schema.contents)
      .where(
        and(
          eq(schema.contents.type, 'page'),
          eq(schema.contents.status, 'publish')
        )
      )
      .orderBy(schema.contents.order);

    return rows.map((p) => ({
      title: p.title || '无标题',
      slug: p.slug || '',
      permalink: buildPermalink(
        { cid: p.cid, slug: p.slug, type: p.type, created: p.created },
        siteUrl,
        undefined,
        pagePattern,
      ),
    }));
  });
}
