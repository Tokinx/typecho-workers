/**
 * Unit tests for cache URL planning.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { schema } from '@/db';
import { buildContentPurgeUrls, buildContentWarmupUrls, invalidatePublicCache, resetCacheVersionMemo, warmPublicCacheUrls } from '@/lib/cache';
import { registerEarlyRequestLoaders, resetEarlyRequestProvidersForTests } from '@/lib/early-request';
import { createTestDb } from '../helpers';

beforeEach(() => {
  resetEarlyRequestProvidersForTests();
  resetCacheVersionMemo();
});

describe('buildContentPurgeUrls()', () => {
  it('includes custom permalink and related archive URLs', () => {
    const urls = buildContentPurgeUrls('https://example.com/', 42, {
      contentUrl: 'https://example.com/posts/hello/',
      categoryUrls: ['https://example.com/category/tech/'],
      tagUrls: ['https://example.com/tag/astro/'],
      authorUrl: 'https://example.com/author/1/',
    });

    expect(urls).toContain('https://example.com/');
    expect(urls).toContain('https://example.com/feed/rss/comments');
    expect(urls).toContain('https://example.com/archives/42/');
    expect(urls).toContain('https://example.com/posts/hello/');
    expect(urls).toContain('https://example.com/category/tech/');
    expect(urls).toContain('https://example.com/tag/astro/');
    expect(urls).toContain('https://example.com/author/1/');
  });

  it('deduplicates URLs', () => {
    const urls = buildContentPurgeUrls('https://example.com', 1, {
      contentUrl: 'https://example.com/archives/1/',
    });

    expect(urls.filter((url) => url === 'https://example.com/archives/1/')).toHaveLength(1);
  });
});

describe('buildContentWarmupUrls()', () => {
  it('includes related category and tag archive URLs', () => {
    const urls = buildContentWarmupUrls('https://example.com', 'https://example.com/archives/1/', {
      categoryUrls: ['https://example.com/category/tech/'],
      tagUrls: ['https://example.com/tag/astro/', 'https://example.com/tag/astro/'],
    });
    expect(urls).toEqual([
      'https://example.com/',
      'https://example.com/feed',
      'https://example.com/archives/1/',
      'https://example.com/category/tech/',
      'https://example.com/tag/astro/',
    ]);
  });

  it('builds home and feed plus the permalink', () => {
    expect(buildContentWarmupUrls('https://example.com', 'https://example.com/archives/1/')).toEqual([
      'https://example.com/',
      'https://example.com/feed',
      'https://example.com/archives/1/',
    ]);
  });

  it('keeps the list minimal without a permalink', () => {
    expect(buildContentWarmupUrls('https://example.com/')).toEqual([
      'https://example.com/',
      'https://example.com/feed',
    ]);
  });

  it('deduplicates when the permalink is the home page', () => {
    expect(buildContentWarmupUrls('https://example.com/', 'https://example.com/')).toEqual([
      'https://example.com/',
      'https://example.com/feed',
    ]);
  });

  it('returns nothing without a usable siteUrl', () => {
    expect(buildContentWarmupUrls('')).toEqual([]);
    expect(buildContentWarmupUrls('not-a-url', 'https://example.com/')).toEqual([]);
  });
});

describe('warmPublicCacheUrls()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches each URL with the warmup marker and tolerates failures', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(warmPublicCacheUrls(['https://example.com/', 'https://example.com/feed'])).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers['X-Typecho-Cache-Warmup']).toBe('1');
    expect(init.headers['Cache-Control']).toBe('no-cache');
  });
});

describe('invalidatePublicCache()', () => {
  it('skips the D1 cacheVersion write when an early provider handles invalidation', async () => {
    const db = await createTestDb() as any;
    await db.insert(schema.options).values({ name: 'cacheVersion', user: 0, value: '7' });
    registerEarlyRequestLoaders({
      cache: async () => ({
        handle: async (_context, next) => next(),
        invalidate: async () => true,
      }),
    });

    await expect(invalidatePublicCache(db, { reason: 'post-update', domains: ['all'] }))
      .resolves.toBe('early');
    const row = await db.query.options.findFirst({
      where: (options: any, { and, eq }: any) => and(eq(options.name, 'cacheVersion'), eq(options.user, 0)),
    });
    expect(row?.value).toBe('7');
  });

  it('does not write D1 cacheVersion when no page-cache provider can invalidate', async () => {
    const db = await createTestDb() as any;
    await db.insert(schema.options).values({ name: 'cacheVersion', user: 0, value: '7' });
    registerEarlyRequestLoaders({
      cache: async () => ({
        handle: async (_context, next) => next(),
        invalidate: async () => {
          throw new Error('KV unavailable');
        },
      }),
    });

    await expect(invalidatePublicCache(db, { reason: 'post-update', domains: ['all'] }))
      .resolves.toBe('none');
    const row = await db.query.options.findFirst({
      where: (options: any, { and, eq }: any) => and(eq(options.name, 'cacheVersion'), eq(options.user, 0)),
    });
    expect(row?.value).toBe('7');
  });
});
