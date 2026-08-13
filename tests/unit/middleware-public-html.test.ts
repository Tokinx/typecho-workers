import { describe, expect, it } from 'vitest';
import { isPublicHtmlCandidate } from '@/middleware';
import { PUBLIC_HTML_HEADER } from '@/lib/cache';

/**
 * isPublicHtmlCandidate drives the middleware backfill of the cache plugin's
 * public-HTML marker. Streaming SSR makes `Astro.response.headers.set()`
 * inside theme components unreliable, so the middleware marks rendered public
 * pages before the early-request provider inspects them.
 */
describe('isPublicHtmlCandidate', () => {
  const html = () => new Response('<html>page</html>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

  it('marks GET text/html responses on public paths', () => {
    for (const path of ['/', '/archives/1/', '/note/1', '/category/x/', '/page/2/']) {
      expect(isPublicHtmlCandidate(new Request(`http://localhost:4321${path}`), html())).toBe(true);
    }
  });

  it('does not touch responses already carrying the marker or plugin cache headers', () => {
    const marked = html();
    marked.headers.set(PUBLIC_HTML_HEADER, '1');
    expect(isPublicHtmlCandidate(new Request('http://localhost:4321/'), marked)).toBe(false);

    const pluginHandled = html();
    pluginHandled.headers.set('X-Typecho-Cache', 'L1');
    expect(isPublicHtmlCandidate(new Request('http://localhost:4321/'), pluginHandled)).toBe(false);
  });

  it('rejects non-HTML responses such as feeds and sitemaps', () => {
    const xml = new Response('<rss/>', {
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
    expect(isPublicHtmlCandidate(new Request('http://localhost:4321/feed'), xml)).toBe(false);
  });

  it('rejects non-GET requests', () => {
    const request = new Request('http://localhost:4321/', { method: 'POST' });
    expect(isPublicHtmlCandidate(request, html())).toBe(false);
  });

  it('rejects install, admin, api, and upload paths', () => {
    for (const path of ['/install', '/admin', '/admin/manage-posts', '/api/comments', '/api/admin/content', '/usr/uploads/2026/01/a.png']) {
      expect(isPublicHtmlCandidate(new Request(`http://localhost:4321${path}`), html())).toBe(false);
    }
  });
});
