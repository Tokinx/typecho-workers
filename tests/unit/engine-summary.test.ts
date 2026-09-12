import { describe, expect, it, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';
import {
  upsertSummary,
  readSummary,
  listPublishedForSummary,
  ENGINE_SUMMARY_FIELD,
} from '@/plugins/typecho-plugin-engine/summary';

describe('engine summary helpers', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('upserts and reads engine_summary field', async () => {
    const [row] = await db.insert(schema.contents).values({
      title: 'Hello',
      slug: 'hello',
      created: 1,
      modified: 1,
      text: 'body',
      type: 'post',
      status: 'publish',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });

    await upsertSummary(db, row.cid!, 'first summary');
    expect(await readSummary(db, row.cid!)).toBe('first summary');

    await upsertSummary(db, row.cid!, 'updated summary');
    expect(await readSummary(db, row.cid!)).toBe('updated summary');

    const field = await db.query.fields.findFirst({
      where: and(eq(schema.fields.cid, row.cid!), eq(schema.fields.name, ENGINE_SUMMARY_FIELD)),
    });
    expect(field?.str_value).toBe('updated summary');
  });

  it('lists published posts and pages with hasSummary flag', async () => {
    const now = Math.floor(Date.now() / 1000);
    const [post] = await db.insert(schema.contents).values({
      title: 'Post',
      slug: 'post',
      created: now,
      modified: now,
      text: 'post body',
      type: 'post',
      status: 'publish',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });
    const [page] = await db.insert(schema.contents).values({
      title: 'Page',
      slug: 'page',
      created: now,
      modified: now,
      text: 'page body',
      type: 'page',
      status: 'publish',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });
    await db.insert(schema.contents).values({
      title: 'Draft',
      slug: 'draft',
      created: now,
      modified: now,
      text: 'draft',
      type: 'post_draft',
      status: 'publish',
      authorId: 1,
    });

    await upsertSummary(db, post.cid!, 'post summary');

    const items = await listPublishedForSummary(db);
    expect(items.map((i) => i.cid).sort()).toEqual([post.cid, page.cid].sort());
    expect(items.find((i) => i.cid === post.cid)?.hasSummary).toBe(true);
    expect(items.find((i) => i.cid === page.cid)?.hasSummary).toBe(false);
  });

  it('lists summaries for 100+ published posts without exceeding D1 bind limits', async () => {
    const now = Math.floor(Date.now() / 1000);
    const count = 105;
    const inserted = await db.insert(schema.contents).values(
      Array.from({ length: count }, (_, i) => ({
        title: `Post ${i + 1}`,
        slug: `post-${i + 1}`,
        created: now + i,
        modified: now + i,
        text: 'body',
        type: 'post' as const,
        status: 'publish' as const,
        authorId: 1,
      })),
    ).returning({ cid: schema.contents.cid });

    const withSummary = inserted.slice(0, 3).map((row) => row.cid!);
    for (const cid of withSummary) {
      await upsertSummary(db, cid, `summary-${cid}`);
    }

    const items = await listPublishedForSummary(db);
    expect(items).toHaveLength(count);
    expect(items.filter((i) => i.hasSummary).map((i) => i.cid).sort())
      .toEqual([...withSummary].sort());
  });
});
