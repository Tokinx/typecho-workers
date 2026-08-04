/**
 * Public archives must use lookahead pagination so a page view never needs an
 * exact count(*) scan. The page-data layer also owns the out-of-range 404
 * decision used by every themed public archive route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import {
  prepareAuthorData,
  prepareCategoryData,
  prepareIndexData,
  prepareSearchData,
  prepareTagData,
} from '@/lib/page-data';

function buildCtx() {
  return {
    db: testDb,
    options: {
      siteUrl: 'https://example.com',
      pageSize: 2,
      categoryPattern: '/category/{slug}/',
      permalinkPattern: '/archives/{cid}/',
      pagePattern: '/{slug}.html',
      commentsAvatarRating: 'G',
      commentsOrder: 'ASC',
      timezone: 0,
      commentsAntiSpam: 0,
      secret: '',
    } as any,
    urls: { siteUrl: 'https://example.com' } as any,
    user: null,
    isLoggedIn: false,
    csrfToken: null,
    activatedPlugins: new Set<string>(),
  } as any;
}

async function seedArchives() {
  await testDb.insert(schema.users).values({
    name: 'alice', mail: 'alice@example.com', group: 'editor', authCode: 'x',
  });
  const author = (await testDb.query.users.findFirst())!;

  await testDb.insert(schema.metas).values({
    name: 'Tech', slug: 'tech', type: 'category', count: 0, order: 1,
  });
  await testDb.insert(schema.metas).values({
    name: 'TypeScript', slug: 'typescript', type: 'tag', count: 0, order: 1,
  });
  const category = (await testDb.query.metas.findFirst({
    where: (table, { eq }) => eq(table.slug, 'tech'),
  }))!;
  const tag = (await testDb.query.metas.findFirst({
    where: (table, { eq }) => eq(table.slug, 'typescript'),
  }))!;

  const now = Math.floor(Date.now() / 1000);
  for (let index = 1; index <= 3; index++) {
    await testDb.insert(schema.contents).values({
      title: `Lookahead article ${index}`,
      slug: `lookahead-${index}`,
      text: `searchable lookahead article ${index}`,
      type: 'post',
      status: 'publish',
      authorId: author.uid,
      created: now - index,
      modified: now - index,
    });
    const content = (await testDb.query.contents.findFirst({
      where: (table, { eq }) => eq(table.slug, `lookahead-${index}`),
    }))!;
    await testDb.insert(schema.relationships).values([
      { cid: content.cid, mid: category.mid },
      { cid: content.cid, mid: tag.mid },
    ]);
  }

  return { author, category, tag };
}

function expectArchiveData(result: unknown): { posts: unknown[]; pagination: any } {
  if (result instanceof Response) throw new Error('expected archive data');
  return result as { posts: unknown[]; pagination: any };
}

describe('public lookahead pagination', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('uses pageSize + 1 state for the homepage and rejects an out-of-range page', async () => {
    await seedArchives();
    const ctx = buildCtx();

    const first = expectArchiveData(await prepareIndexData(
      ctx, 'https://example.com/', {}, new URL('https://example.com/'),
    ));
    expect(first.posts).toHaveLength(2);
    expect(first.pagination).toMatchObject({
      totalsExact: false,
      totalItems: null,
      totalPages: null,
      hasPrev: false,
      hasNext: true,
      nextUrl: 'https://example.com/page/2/',
      pages: [],
    });

    const final = expectArchiveData(await prepareIndexData(
      ctx, 'https://example.com/page/2/', { _page: 2 }, new URL('https://example.com/page/2/'),
    ));
    expect(final.posts).toHaveLength(1);
    expect(final.pagination.hasNext).toBe(false);
    expect(final.pagination.prevUrl).toBe('https://example.com/');

    const outOfRange = await prepareIndexData(
      ctx, 'https://example.com/page/3/', { _page: 3 }, new URL('https://example.com/page/3/'),
    );
    expect(outOfRange).toBeInstanceOf(Response);
    expect((outOfRange as Response).status).toBe(404);
  });

  it('uses the same 404 behavior for category, tag, author, and search archives', async () => {
    const { author, category, tag } = await seedArchives();
    const ctx = buildCtx();
    const loaders = [
      (locals: Record<string, unknown>) => prepareCategoryData(
        ctx, 'tech', 'https://example.com/category/tech/', locals,
        new URL('https://example.com/category/tech/'), category,
      ),
      (locals: Record<string, unknown>) => prepareTagData(
        ctx, 'typescript', 'https://example.com/tag/typescript/', locals,
        new URL('https://example.com/tag/typescript/'), tag,
      ),
      (locals: Record<string, unknown>) => prepareAuthorData(
        ctx, author.uid, `https://example.com/author/${author.uid}/`, locals,
        new URL(`https://example.com/author/${author.uid}/`), author,
      ),
      (locals: Record<string, unknown>) => prepareSearchData(
        ctx, 'lookahead', 'https://example.com/search/lookahead/', locals,
        new URL('https://example.com/search/lookahead/'),
      ),
    ];

    for (const load of loaders) {
      const first = expectArchiveData(await load({}));
      expect(first.posts).toHaveLength(2);
      expect(first.pagination.totalsExact).toBe(false);
      expect(first.pagination.hasNext).toBe(true);

      const outOfRange = await load({ _page: 3 });
      expect(outOfRange).toBeInstanceOf(Response);
      expect((outOfRange as Response).status).toBe(404);
    }
  });
});
