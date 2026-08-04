import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';

describe('public threaded comment query plan', () => {
  let db: TestDatabase | undefined;

  afterEach(async () => {
    if (db) await disposeTestDb(db);
    db = undefined;
  });

  it('uses the ordered public-list and parent traversal indexes', async () => {
    db = await createTestDb();
    const plan = await db.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      WITH RECURSIVE selected_roots(coid) AS (
        SELECT candidate.coid
        FROM typecho_comments AS candidate INDEXED BY typecho_comments_cid_status_created
        LEFT JOIN typecho_comments AS parent_comment
          ON parent_comment.coid = candidate.parent
          AND parent_comment.cid = 1
          AND parent_comment.status = 'approved'
        WHERE candidate.cid = 1
          AND candidate.status = 'approved'
          AND (candidate.parent = 0 OR parent_comment.coid IS NULL)
        ORDER BY candidate.created ASC, candidate.coid ASC
        LIMIT 10 OFFSET 0
      ),
      thread AS (
        SELECT comment.*
        FROM typecho_comments AS comment
        INNER JOIN selected_roots AS root ON root.coid = comment.coid
        UNION ALL
        SELECT child.*
        FROM typecho_comments AS child INDEXED BY typecho_comments_cid_parent_status
        INNER JOIN thread AS parent_comment ON child.parent = parent_comment.coid
        WHERE child.cid = 1
          AND child.status = 'approved'
      )
      SELECT * FROM thread ORDER BY created ASC, coid ASC
    `);
    const detail = plan.map(row => row.detail).join('\n');

    expect(detail).toContain('typecho_comments_cid_status_created');
    expect(detail).toContain('typecho_comments_cid_parent_status');
  });
});
