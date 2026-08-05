/**
 * Per-isolate boot state for Cloudflare Workers.
 *
 * Workers reuse the same isolate across many requests. Certain one-time
 * checks (table existence, index creation) only need to run once per
 * isolate lifetime. This module aggregates those checks so middleware
 * doesn't carry module-level mutable booleans.
 *
 * All state is intentionally per-isolate (module-scope). Pending promises
 * coalesce requests that interleave while the first async check is running.
 */

import { generateIndexSQL, generateTableSQL } from '@/lib/schema-sql';
import { schema } from '@/db';

/** Thrown when D1 has no typecho_options table — legitimate install-redirect case. */
export class TablesMissingError extends Error {
  constructor() {
    super('tables-missing');
    this.name = 'TablesMissingError';
  }
}

interface IsolateBoot {
  databaseReadyPassed: boolean;
  tableCheckPassed: boolean;
  passwordResetSchemaPassed: boolean;
  indexEnsurePassed: boolean;
  databaseReadyPending?: Promise<void>;
  tableCheckPending?: Promise<void>;
  passwordResetSchemaPending?: Promise<void>;
  indexEnsurePending?: Promise<void>;
}

const state: IsolateBoot = {
  databaseReadyPassed: false,
  tableCheckPassed: false,
  passwordResetSchemaPassed: false,
  indexEnsurePassed: false,
};

/**
 * Resets all boot state. Exposed for tests so individual test cases
 * can simulate a cold isolate without forking a new worker process.
 */
export function resetIsolateBoot(): void {
  state.databaseReadyPassed = false;
  state.tableCheckPassed = false;
  state.passwordResetSchemaPassed = false;
  state.indexEnsurePassed = false;
  state.databaseReadyPending = undefined;
  state.tableCheckPending = undefined;
  state.passwordResetSchemaPending = undefined;
  state.indexEnsurePending = undefined;
}

// Reserved by the Typecho-Workers runtime schema bootstrap. Bump this whenever the
// runtime password-reset upgrade or generated index set changes. A stable
// database needs one query per cold isolate instead of probing every table,
// column and index.
const RUNTIME_SCHEMA_VERSION = '20260806';
const RUNTIME_SCHEMA_VERSION_KEY = 'runtimeSchemaVersion';

export async function ensureDatabaseReady(d1: D1Database): Promise<void> {
  if (state.databaseReadyPassed) return;
  if (state.databaseReadyPending) return state.databaseReadyPending;

  const pending = (async () => {
    let marker: { runtimeSchemaVersion: string | null; loginFailuresExists?: boolean | number } | null;
    try {
      marker = await d1.prepare(
      "SELECT (SELECT value FROM typecho_options " +
      "WHERE name='runtimeSchemaVersion' AND user=0 LIMIT 1) AS runtimeSchemaVersion " +
      ", EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' " +
      "AND name='typecho_login_failures') AS loginFailuresExists " +
      "FROM sqlite_master WHERE type='table' AND name='typecho_options' LIMIT 1",
      ).first<{ runtimeSchemaVersion: string | null; loginFailuresExists?: boolean | number }>();
    } catch (error) {
      if (error instanceof Error && /no such table:\s*typecho_options/i.test(error.message)) {
        throw new TablesMissingError();
      }
      throw error;
    }
    if (!marker) throw new TablesMissingError();
    state.tableCheckPassed = true;

    // Older installations may predate the persistent login throttle table.
    // Create it before the fast path so login never fails with SQLITE_ERROR.
    if (marker.loginFailuresExists === false || marker.loginFailuresExists === 0) {
      await d1.prepare(
        'CREATE TABLE IF NOT EXISTS typecho_login_failures (' +
        'ip TEXT PRIMARY KEY NOT NULL, ' +
        'failures INTEGER NOT NULL DEFAULT 0, ' +
        'windowStartedAt INTEGER NOT NULL DEFAULT 0, ' +
        'bannedUntil INTEGER NOT NULL DEFAULT 0)',
      ).run();
    }

    if (marker.runtimeSchemaVersion === RUNTIME_SCHEMA_VERSION) {
      state.tableCheckPassed = true;
      state.passwordResetSchemaPassed = true;
      state.indexEnsurePassed = true;
      state.databaseReadyPassed = true;
      return;
    }

    await ensurePasswordResetSchema(d1);
    await ensureEdgeCacheSchema(d1);
    await ensureIndexesReady(d1);
    await d1.prepare(
      'INSERT INTO typecho_options (name, user, value) VALUES (?, ?, ?) ' +
      'ON CONFLICT(name, user) DO UPDATE SET value=excluded.value',
    ).bind(RUNTIME_SCHEMA_VERSION_KEY, 0, RUNTIME_SCHEMA_VERSION).run();
    state.databaseReadyPassed = true;
  })();
  state.databaseReadyPending = pending;
  try {
    await pending;
  } finally {
    if (state.databaseReadyPending === pending) state.databaseReadyPending = undefined;
  }
}

async function ensureEdgeCacheSchema(d1: D1Database): Promise<void> {
  const statements = generateTableSQL(schema.edgeCache).map(sql => d1.prepare(sql));
  if (statements.length > 0) await d1.batch(statements);
}

/**
 * Ensures the D1 database has the typecho_options table.
 *
 * On the first request after a cold start, queries sqlite_master.
 * If the table exists, sets tableCheckPassed=true so subsequent
 * requests skip this check.
 *
 * Throws 'tables-missing' if the table does not exist, letting the
 * caller redirect to /install.
 */
export async function ensureTablesReady(d1: D1Database): Promise<void> {
  if (state.tableCheckPassed) return;
  if (state.tableCheckPending) return state.tableCheckPending;
  const pending = (async () => {
    const row = await d1
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='typecho_options'")
      .first<{ name: string }>();
    if (!row) throw new TablesMissingError();
    state.tableCheckPassed = true;
  })();
  state.tableCheckPending = pending;
  try {
    await pending;
  } finally {
    if (state.tableCheckPending === pending) state.tableCheckPending = undefined;
  }
}

const PASSWORD_RESET_COLUMNS = [
  ['uid', 'INTEGER'],
  ['tokenHash', 'TEXT'],
  ['expiresAt', 'INTEGER'],
] as const;

/**
 * Ensures the password-reset request table exists and is current.
 *
 * The earlier implementation called this table
 * `typecho_password_reset_throttle`. Rename that table in place so existing
 * rate-limit and pending-token state survives the terminology correction.
 */
export async function ensurePasswordResetSchema(d1: D1Database): Promise<void> {
  if (state.passwordResetSchemaPassed) return;
  if (state.passwordResetSchemaPending) return state.passwordResetSchemaPending;
  const pending = (async () => {
    const tables = await d1.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' " +
      "AND name IN ('typecho_password_reset_requests', 'typecho_password_reset_throttle')",
    ).all<{ name: string }>();
    const tableNames = new Set((tables.results ?? []).map(table => table.name));
    const hasCurrent = tableNames.has('typecho_password_reset_requests');
    const hasLegacy = tableNames.has('typecho_password_reset_throttle');

    if (hasLegacy && !hasCurrent) {
      await d1.batch([
        d1.prepare(
          'ALTER TABLE typecho_password_reset_throttle ' +
          'RENAME TO typecho_password_reset_requests',
        ),
        d1.prepare('DROP INDEX IF EXISTS typecho_password_reset_tokenHash'),
      ]);
    } else if (!hasCurrent) {
      await d1.batch([
        d1.prepare(
          'CREATE TABLE typecho_password_reset_requests (' +
          'email TEXT PRIMARY KEY NOT NULL, ' +
          'lastSentAt INTEGER NOT NULL DEFAULT 0, ' +
          'uid INTEGER, tokenHash TEXT, expiresAt INTEGER)',
        ),
      ]);
    }

    const result = await d1
      .prepare("PRAGMA table_info('typecho_password_reset_requests')")
      .all<{ name: string }>();
    const existing = new Set((result.results ?? []).map(column => column.name));
    const upgrades: D1PreparedStatement[] = [];
    for (const [name, type] of PASSWORD_RESET_COLUMNS) {
      if (!existing.has(name)) {
        upgrades.push(
          d1.prepare(`ALTER TABLE typecho_password_reset_requests ADD COLUMN ${name} ${type}`),
        );
      }
    }
    if (upgrades.length > 0) await d1.batch(upgrades);
    state.passwordResetSchemaPassed = true;
  })();
  state.passwordResetSchemaPending = pending;
  try {
    await pending;
  } finally {
    if (state.passwordResetSchemaPending === pending) state.passwordResetSchemaPending = undefined;
  }
}

/**
 * Backfills any newly-added indexes exactly once per isolate.
 *
 * Off the request path via waitUntil if available; otherwise
 * fire-and-forget. CREATE INDEX IF NOT EXISTS is idempotent.
 */
export function ensureIndexes(
  d1: D1Database,
  executionContext?: Pick<ExecutionContext, 'waitUntil'>,
): void {
  if (state.indexEnsurePassed) return;
  const backfill = ensureIndexesReady(d1).catch(
    err => console.warn('[isolate-boot] ensureIndexes failed:', err),
  );
  if (executionContext) executionContext.waitUntil(backfill);
}

async function ensureIndexesReady(d1: D1Database): Promise<void> {
  if (state.indexEnsurePassed) return;
  if (state.indexEnsurePending) return state.indexEnsurePending;
  const indexStatements = generateIndexSQL();
  if (indexStatements.length === 0) {
    state.indexEnsurePassed = true;
    return;
  }
  // Explicit loop — .prepare() loses its `this` binding when passed as a
  // .map() callback inside Cloudflare Workers' native API proxies.
  const stmts: D1PreparedStatement[] = [];
  for (const sql of indexStatements) {
    stmts.push(d1.prepare(sql));
  }
  const pending = d1.batch(stmts).then(() => {
    state.indexEnsurePassed = true;
  });
  state.indexEnsurePending = pending;
  try {
    await pending;
  } finally {
    if (state.indexEnsurePending === pending) state.indexEnsurePending = undefined;
  }
}
