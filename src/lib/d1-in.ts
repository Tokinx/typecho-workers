import { sql, type SQL } from 'drizzle-orm';

/** Keep every D1 statement below SQLite/D1's practical bound-parameter limit. */
export const D1_IN_CHUNK_SIZE = 80;
/** Maximum number of IDs accepted from one client request. */
export const D1_MAX_CLIENT_IDS = 200;

/**
 * Parse positive integer IDs from a form/query collection. Invalid input and
 * oversized client selections return null so callers can fail with 400.
 */
export function parseBoundedIds(values: readonly unknown[], max = D1_MAX_CLIENT_IDS): number[] | null {
  if (values.length > max) return null;
  const ids: number[] = [];
  for (const value of values) {
    const raw = typeof value === 'string' ? value : String(value ?? '');
    if (!/^[1-9]\d*$/.test(raw)) return null;
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

/**
 * Build a parameterized IN predicate split into <= 80-ID clauses. The helper
 * intentionally does not impose the client-input limit because archive/feed
 * rows are server-derived; use parseBoundedIds at request boundaries.
 */
export function sqlInChunks(column: unknown, ids: readonly number[]): SQL {
  if (ids.length === 0) return sql`1 = 0`;
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('D1 ID list contains an invalid value');
  }

  const clauses: SQL[] = [];
  for (let offset = 0; offset < ids.length; offset += D1_IN_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + D1_IN_CHUNK_SIZE);
    clauses.push(sql`${column} IN (${sql.join(chunk.map(id => sql`${id}`), sql`, `)})`);
  }
  return clauses.length === 1 ? clauses[0] : sql`(${sql.join(clauses, sql` OR `)})`;
}
