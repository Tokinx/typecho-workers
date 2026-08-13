import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { buildPermalink } from '@/lib/content';
import { escapeXml } from '@/lib/escape';
import { eq, or, lte, desc, and } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

const SITEMAP_LIMIT = 5000;

export const GET: APIRoute = async () => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);
  const nowSec = Math.floor(Date.now() / 1000);

  const rows = await db
    .select({
      cid: schema.contents.cid,
      slug: schema.contents.slug,
      type: schema.contents.type,
      modified: schema.contents.modified,
      created: schema.contents.created,
    })
    .from(schema.contents)
    .where(
      and(
        or(eq(schema.contents.type, 'post'), eq(schema.contents.type, 'page')),
        eq(schema.contents.status, 'publish'),
        lte(schema.contents.created, nowSec),
      ),
    )
    .orderBy(desc(schema.contents.modified))
    .limit(SITEMAP_LIMIT);

  const items = rows
    .map((r) => {
      const loc = buildPermalink(
        { cid: r.cid, slug: r.slug, type: r.type, created: r.created },
        urls.siteUrl,
        options.permalinkPattern as string | undefined,
        options.pagePattern as string | undefined,
      );
      const lastmod = new Date((r.modified || r.created || 0) * 1000)
        .toISOString()
        .slice(0, 10);
      return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=1800',
      // Platform layer (Workers Caching) opt-in; otherwise @astrojs/cloudflare
      // would mark this response no-store and the s-maxage caching would stop.
      'Cloudflare-CDN-Cache-Control': 'public, max-age=1800',
    },
  });
};
