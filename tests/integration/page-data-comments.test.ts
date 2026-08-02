import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';
import { generateUnapprovedCommentToken } from '@/lib/auth';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { preparePostData } from '@/lib/page-data';

const secret = 'comment-status-secret';

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
      secret,
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
  });
});
