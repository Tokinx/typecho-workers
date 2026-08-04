/**
 * Unit tests for cache URL planning.
 */
import { beforeEach, describe, it, expect } from 'vitest';
import { schema } from '@/db';
import { buildContentPurgeUrls, invalidatePublicCache, resetCacheVersionMemo } from '@/lib/cache';
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
