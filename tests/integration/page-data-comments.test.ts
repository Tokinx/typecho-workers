import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';
import { generateUnapprovedCommentToken } from '@/lib/auth';

const { loadCommentPageSpy } = vi.hoisted(() => ({ loadCommentPageSpy: vi.fn() }));

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('@/lib/comment-page', async () => {
  const actual = await vi.importActual<typeof import('@/lib/comment-page')>('@/lib/comment-page');
  return {
    ...actual,
    loadCommentPage: (...args: Parameters<typeof actual.loadCommentPage>) => {
      loadCommentPageSpy();
      return actual.loadCommentPage(...args);
    },
  };
});

import { preparePageData, preparePostData } from '@/lib/page-data';
import { registerTheme } from '@/lib/theme';

const secret = 'comment-status-secret';

function buildContext(theme = 'typecho-theme-minimal') {
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
      secret,
      theme,
    },
    urls: { siteUrl: 'https://example.com' },
    user: null,
    isLoggedIn: false,
    csrfToken: null,
  };
}

describe('page data comment moderation state', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    loadCommentPageSpy.mockClear();
    registerTheme('typecho-theme-warm', {
      id: 'typecho-theme-warm',
      name: 'Warm',
      commentsMode: 'api',
    }, '/themes/typecho-theme-warm/style.css');
  });

  afterEach(async () => {
    await disposeTestDb(testDb);
  });

  it('exposes a submitted waiting comment and its moderation state only with its signed capability', async () => {
    const created = Math.floor(Date.now() / 1000) - 60;
    const [post] = await testDb.insert(schema.contents).values({
      title: 'Published post',
      slug: 'published-post',
      type: 'post',
      status: 'publish',
      created,
      modified: created,
    }).returning();
    const [comment] = await testDb.insert(schema.comments).values({
      cid: post.cid,
      author: 'Commenter',
      text: 'Waiting for moderation',
      created,
      status: 'waiting',
    }).returning();
    const token = await generateUnapprovedCommentToken(secret, post.cid, comment.coid);

    const result = await preparePostData(
      buildContext() as any,
      post.cid,
      `https://example.com/archives/${post.cid}/`,
      null,
      post,
      token,
    );

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error('expected post props');
    expect(result.comments).toEqual([
      expect.objectContaining({ coid: comment.coid, status: 'waiting' }),
    ]);
    expect(loadCommentPageSpy).toHaveBeenCalledOnce();
  });

  it('skips comment-row queries for Warm post data', async () => {
    const created = Math.floor(Date.now() / 1000) - 60;
    const [post] = await testDb.insert(schema.contents).values({
      title: 'Warm post',
      slug: 'warm-post',
      type: 'post',
      status: 'publish',
      created,
      modified: created,
      commentsNum: 3,
    }).returning();

    const result = await preparePostData(
      buildContext('typecho-theme-warm') as any,
      post.cid,
      `https://example.com/archives/${post.cid}/`,
      null,
      post,
      null,
    );

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error('expected post props');
    expect(result.comments).toEqual([]);
    expect(result.gravatarMap).toEqual({});
    expect(result.commentPagination.totalComments).toBe(3);
    expect(loadCommentPageSpy).not.toHaveBeenCalled();
  });

  it('skips comment-row queries for Warm page data', async () => {
    const created = Math.floor(Date.now() / 1000) - 60;
    const [page] = await testDb.insert(schema.contents).values({
      title: 'Warm page',
      slug: 'warm-page',
      type: 'page',
      status: 'publish',
      created,
      modified: created,
      commentsNum: 2,
    }).returning();

    const result = await preparePageData(
      buildContext('typecho-theme-warm') as any,
      page.slug || '',
      `https://example.com/${page.slug}.html`,
      null,
      page,
      null,
    );

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error('expected page props');
    expect(result.comments).toEqual([]);
    expect(result.commentPagination.totalComments).toBe(2);
    expect(loadCommentPageSpy).not.toHaveBeenCalled();
  });
});
