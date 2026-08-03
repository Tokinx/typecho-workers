import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { preparePageData, preparePostData } from '@/lib/page-data';

function buildContext() {
  return {
    db: testDb,
    options: {
      siteUrl: 'https://example.com',
      permalinkPattern: '/archives/{cid}/',
      pagePattern: '/{slug}.html',
      categoryPattern: '/category/{slug}/',
      commentsAvatarRating: 'G',
      commentsOrder: 'ASC',
      commentsPageBreak: 0,
      commentsThreaded: 0,
      commentsAntiSpam: 0,
      timezone: 0,
      secret: '',
    },
    urls: { siteUrl: 'https://example.com' },
    user: null,
    isLoggedIn: false,
    csrfToken: null,
  };
}

describe('admin preview data', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await disposeTestDb(testDb);
  });

  it('renders a post draft only when the authenticated preview route opts in', async () => {
    const now = Math.floor(Date.now() / 1000);
    const [draft] = await testDb.insert(schema.contents).values({
      title: 'Post draft', slug: 'post-draft', text: 'Preview body', type: 'post_draft', status: 'draft', password: 'secret', created: now, modified: now,
    }).returning();
    const context = buildContext();

    const publicResult = await preparePostData(context as any, draft.cid, 'https://example.com/archives/1/', null, draft);
    expect(publicResult).toBeInstanceOf(Response);

    const previewResult = await preparePostData(context as any, draft.cid, 'https://example.com/admin/preview', null, draft, null, { previewMode: true });
    expect(previewResult).not.toBeInstanceOf(Response);
    if (previewResult instanceof Response) throw new Error('expected preview props');
    expect(previewResult.post).toMatchObject({ cid: draft.cid, title: 'Post draft' });
    expect(previewResult.post.content).toContain('Preview body');
  });

  it('renders a page draft through page data in preview mode', async () => {
    const now = Math.floor(Date.now() / 1000);
    const [draft] = await testDb.insert(schema.contents).values({
      title: 'Page draft', slug: 'page-draft', text: 'Preview body', type: 'page_draft', status: 'draft', created: now, modified: now,
    }).returning();

    const result = await preparePageData(
      buildContext() as any,
      draft.slug!,
      'https://example.com/admin/preview',
      null,
      draft,
      null,
      { previewMode: true },
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error('expected preview props');
    expect(result.page).toMatchObject({ cid: draft.cid, title: 'Page draft', slug: 'page-draft' });
  });
});
