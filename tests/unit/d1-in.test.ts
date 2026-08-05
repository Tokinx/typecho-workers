import { describe, expect, it } from 'vitest';
import { schema } from '@/db';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { D1_IN_CHUNK_SIZE, D1_MAX_CLIENT_IDS, parseBoundedIds, sqlInChunks } from '@/lib/d1-in';

describe('D1 IN predicate bounds', () => {
  it('rejects more than 200 client IDs and accepts the boundary', () => {
    expect(parseBoundedIds(Array.from({ length: D1_MAX_CLIENT_IDS }, (_, i) => String(i + 1)))).toHaveLength(D1_MAX_CLIENT_IDS);
    expect(parseBoundedIds(Array.from({ length: D1_MAX_CLIENT_IDS + 1 }, (_, i) => String(i + 1)))).toBeNull();
    expect(parseBoundedIds(['1', 'not-an-id'])).toBeNull();
  });

  it('splits 100+ IDs into bounded parameter chunks', async () => {
    let db: TestDatabase | undefined;
    try {
      db = await createTestDb();
      const ids = Array.from({ length: 205 }, (_, i) => i + 1);
      await db.insert(schema.contents).values(ids.map(cid => ({
        cid,
        title: `Post ${cid}`,
        slug: `post-${cid}`,
        type: 'post' as const,
        status: 'publish' as const,
        created: 100,
        modified: 100,
        text: 'body',
      })));

      const statement = db.select({ cid: schema.contents.cid })
        .from(schema.contents)
        .where(sqlInChunks(schema.contents.cid, ids));
      const query = statement.toSQL();
      expect(query.params).toHaveLength(205);
      expect(query.sql.match(/ IN /g)).toHaveLength(Math.ceil(ids.length / D1_IN_CHUNK_SIZE));
      expect(await statement).toHaveLength(205);
    } finally {
      if (db) await disposeTestDb(db);
    }
  });
});
