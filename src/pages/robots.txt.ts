import type { APIRoute } from 'astro';
import { getDb } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async () => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);
  const custom = (options.robotsTxt as string | undefined) || '';

  const body =
    custom.trim() ||
    `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${urls.siteUrl}/sitemap.xml\n`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600',
      // Platform layer (Workers Caching) opt-in; otherwise @astrojs/cloudflare
      // would mark this response no-store and the s-maxage caching would stop.
      'Cloudflare-CDN-Cache-Control': 'public, max-age=3600',
    },
  });
};
