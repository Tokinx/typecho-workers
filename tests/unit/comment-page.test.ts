import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';
import { loadCommentPage } from '@/lib/comment-page';
import type { SiteOptions } from '@/lib/options';

let db: TestDatabase;

const options = (overrides: Partial<SiteOptions> = {}) => ({
  commentsPageBreak: 1,
  commentsThreaded: 1,
  commentsPageSize: 2,
  commentsPageDisplay: 'first',
  commentsOrder: 'ASC',
  ...overrides,
} as SiteOptions);

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await disposeTestDb(db);
});

async function addComment(created: number, parent = 0) {
  const [row] = await db.insert(schema.comments).values({
    cid: 1,
    created,
    parent,
    author: `user-${created}`,
    text: `comment-${created}`,
    status: 'approved',
  }).returning();
  return row;
}

describe('loadCommentPage', () => {
  it('keeps the legacy full result when pagination is disabled', async () => {
    await addComment(1);
    await addComment(2);
    await addComment(3);

    const page = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageBreak: 0 }),
      'https://example.com/post',
    );

    expect(page.rows.map(row => row.created)).toEqual([1, 2, 3]);
    expect(page.pagination.enabled).toBe(false);
    expect(page.pagination.totalComments).toBe(3);
  });

  it('paginates flat comments without overlap and preserves the global count', async () => {
    for (let created = 1; created <= 5; created++) await addComment(created);

    const first = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0 }),
      'https://example.com/post?commentPage=1',
    );
    const second = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0 }),
      'https://example.com/post?commentPage=2',
    );

    expect(first.rows.map(row => row.created)).toEqual([1, 2]);
    expect(second.rows.map(row => row.created)).toEqual([3, 4]);
    expect(second.pagination.totalComments).toBe(5);
    expect(second.pagination.totalPages).toBe(3);
  });

  it('paginates threaded comments by root and keeps descendants together', async () => {
    const rootOne = await addComment(1);
    await addComment(2, rootOne.coid);
    const rootTwo = await addComment(3);
    await addComment(4, rootTwo.coid);

    const second = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageSize: 1 }),
      'https://example.com/post?commentPage=2',
    );

    expect(second.rows.map(row => row.coid)).toEqual([rootTwo.coid, rootTwo.coid + 1]);
    expect(second.rows.some(row => row.coid === rootOne.coid)).toBe(false);
    expect(second.pagination.totalComments).toBe(4);
    expect(second.pagination.totalPages).toBe(2);
  });

  it('treats approved replies with a missing or unapproved parent as roots', async () => {
    const waitingParent = await db.insert(schema.comments).values({
      cid: 1,
      created: 1,
      parent: 0,
      author: 'waiting-parent',
      text: 'waiting',
      status: 'waiting',
    }).returning();
    const orphanedByModeration = await addComment(2, waitingParent[0].coid);
    const preservedDescendant = await addComment(3, orphanedByModeration.coid);
    const missingParent = await addComment(4, 999_999);

    const first = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageSize: 1 }),
      'https://example.com/post?commentPage=1',
    );
    const second = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageSize: 1 }),
      'https://example.com/post?commentPage=2',
    );

    expect(first.rows.map(row => row.coid)).toEqual([
      orphanedByModeration.coid,
      preservedDescendant.coid,
    ]);
    expect(second.rows.map(row => row.coid)).toEqual([missingParent.coid]);
    expect(first.pagination.totalComments).toBe(3);
    expect(first.pagination.totalPages).toBe(2);
  });

  it('shows a non-public comment only when its submitted id is explicitly allowed', async () => {
    await addComment(1);
    const [waiting] = await db.insert(schema.comments).values({
      cid: 1,
      created: 2,
      parent: 0,
      author: 'waiting-user',
      text: 'waiting comment',
      status: 'waiting',
    }).returning();

    const hidden = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageBreak: 0, commentsThreaded: 0 }),
      'https://example.com/post',
    );
    const visible = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageBreak: 0, commentsThreaded: 0 }),
      'https://example.com/post',
      waiting.coid,
    );

    expect(hidden.rows.map(row => row.coid)).not.toContain(waiting.coid);
    expect(visible.rows.map(row => row.coid)).toContain(waiting.coid);
    expect(visible.pagination.totalComments).toBe(2);
  });

  it('uses the last page by default and clamps invalid pages', async () => {
    for (let created = 1; created <= 5; created++) await addComment(created);

    const last = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0, commentsPageDisplay: 'last' }),
      'https://example.com/post',
    );
    const clamped = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0 }),
      'https://example.com/post?commentPage=999',
    );

    expect(last.pagination.currentPage).toBe(3);
    expect(last.rows.map(row => row.created)).toEqual([5]);
    expect(clamped.pagination.currentPage).toBe(3);
  });
});
