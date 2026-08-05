import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resetIsolateBoot,
  ensureDatabaseReady,
  ensureTablesReady,
  ensurePasswordResetSchema,
  ensureIndexes,
  TablesMissingError,
} from '@/lib/isolate-boot';

// Mock generateIndexSQL so the test doesn't depend on actual schema
vi.mock('@/lib/schema-sql', () => ({
  generateIndexSQL: vi.fn(() => [
    'CREATE INDEX IF NOT EXISTS idx_test ON typecho_contents(slug)',
  ]),
  generateTableSQL: vi.fn(() => [
    'CREATE TABLE IF NOT EXISTS typecho_db_cache (`cacheKey` TEXT PRIMARY KEY, `value` TEXT NOT NULL, `expiresAt` INTEGER NOT NULL)',
  ]),
}));

function mockD1(hasTable: boolean) {
  const first = vi.fn().mockResolvedValue(hasTable ? { name: 'typecho_options' } : null);
  return {
    prepare: vi.fn().mockReturnValue({ first, bind: vi.fn().mockReturnThis() }),
  } as unknown as D1Database;
}

beforeEach(() => {
  resetIsolateBoot();
});

describe('ensureTablesReady', () => {
  it('queries sqlite_master on first call', async () => {
    const d1 = mockD1(true);
    await ensureTablesReady(d1);
    expect(d1.prepare).toHaveBeenCalledTimes(1);
  });

  it('skips query on second call (cached)', async () => {
    const d1 = mockD1(true);
    await ensureTablesReady(d1);
    await ensureTablesReady(d1);
    expect(d1.prepare).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent checks into one D1 request', async () => {
    const d1 = mockD1(true);
    await Promise.all([ensureTablesReady(d1), ensureTablesReady(d1)]);
    expect(d1.prepare).toHaveBeenCalledTimes(1);
  });

  it('throws TablesMissingError when table absent', async () => {
    const d1 = mockD1(false);
    await expect(ensureTablesReady(d1)).rejects.toThrow(TablesMissingError);
  });

  it('throws generic Error when D1 query fails', async () => {
    const d1 = {
      prepare: vi.fn().mockReturnValue({
        first: vi.fn().mockRejectedValue(new Error('D1 down')),
        bind: vi.fn().mockReturnThis(),
      }),
    } as unknown as D1Database;
    // D1 failure → generic Error, NOT TablesMissingError
    await expect(ensureTablesReady(d1)).rejects.toThrow('D1 down');
  });

  it('retries on next isolate after resetIsolateBoot', async () => {
    const d1a = mockD1(true);
    await ensureTablesReady(d1a);

    resetIsolateBoot();
    const d1b = mockD1(false);
    await expect(ensureTablesReady(d1b)).rejects.toThrow(TablesMissingError);
  });
});

describe('ensureDatabaseReady', () => {
  it('uses the persistent schema version fast path on a cold isolate', async () => {
    const first = vi.fn().mockResolvedValue({ runtimeSchemaVersion: '20260806' });
    const d1 = {
      prepare: vi.fn().mockReturnValue({ first }),
      batch: vi.fn(),
    } as unknown as D1Database;

    await ensureDatabaseReady(d1);

    expect(d1.prepare).toHaveBeenCalledOnce();
    expect(d1.batch).not.toHaveBeenCalled();
  });

  it('creates the login failure table for an older installation', async () => {
    const createRun = vi.fn().mockResolvedValue({});
    const prepare = vi.fn((sql: string) => {
      if (sql.startsWith('SELECT (SELECT value')) {
        return { first: vi.fn().mockResolvedValue({ runtimeSchemaVersion: '20260804', loginFailuresExists: 0 }) };
      }
      if (sql.includes("name IN ('typecho_password_reset_requests'")) {
        return { all: vi.fn().mockResolvedValue({ results: [{ name: 'typecho_password_reset_requests' }] }) };
      }
      if (sql.startsWith('PRAGMA table_info')) {
        return { all: vi.fn().mockResolvedValue({
          results: ['email', 'lastSentAt', 'uid', 'tokenHash', 'expiresAt'].map(name => ({ name })),
        }) };
      }
      if (sql.startsWith('INSERT INTO typecho_options')) {
        return { bind: vi.fn(() => ({ run: createRun })) };
      }
      return { run: createRun };
    });
    const d1 = { prepare, batch: vi.fn().mockResolvedValue([]) } as unknown as D1Database;

    await ensureDatabaseReady(d1);

    expect(createRun).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1][0]).toContain('CREATE TABLE IF NOT EXISTS typecho_login_failures');
  });

  it('coalesces concurrent cold-isolate initialization', async () => {
    let release!: (value: { user_version: number }) => void;
    const first = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const d1 = {
      prepare: vi.fn().mockReturnValue({ first }),
      batch: vi.fn(),
    } as unknown as D1Database;

    const a = ensureDatabaseReady(d1);
    const b = ensureDatabaseReady(d1);
    release({ runtimeSchemaVersion: '20260806' } as any);
    await Promise.all([a, b]);

    expect(d1.prepare).toHaveBeenCalledOnce();
  });

  it('upgrades a stale marker and persists the current schema version', async () => {
    const markerRun = vi.fn().mockResolvedValue({});
    const prepare = vi.fn((sql: string) => {
      if (sql.startsWith('SELECT (SELECT value')) {
        return { first: vi.fn().mockResolvedValue({ runtimeSchemaVersion: null }) };
      }
      if (sql.includes("name IN ('typecho_password_reset_requests'")) {
        return { all: vi.fn().mockResolvedValue({ results: [{ name: 'typecho_password_reset_requests' }] }) };
      }
      if (sql.startsWith('PRAGMA table_info')) {
        return { all: vi.fn().mockResolvedValue({
          results: ['email', 'lastSentAt', 'uid', 'tokenHash', 'expiresAt'].map(name => ({ name })),
        }) };
      }
      if (sql.startsWith('INSERT INTO typecho_options')) {
        return { bind: vi.fn(() => ({ run: markerRun })) };
      }
      return { sql };
    });
    const batch = vi.fn().mockResolvedValue([]);
    const d1 = { prepare, batch } as unknown as D1Database;

    await ensureDatabaseReady(d1);

    expect(batch).toHaveBeenCalledTimes(2);
    expect((batch.mock.calls[0][0] as Array<{ sql: string }>)[0].sql).toContain('typecho_db_cache');
    expect(markerRun).toHaveBeenCalledOnce();
  });
});

describe('ensureIndexes', () => {
  it('only runs once per isolate', () => {
    const d1 = { prepare: vi.fn(), batch: vi.fn().mockResolvedValue([]) } as unknown as D1Database;
    ensureIndexes(d1);
    ensureIndexes(d1);
    expect(d1.batch).toHaveBeenCalledTimes(1);
  });

  it('uses waitUntil when available', () => {
    let waited: Promise<unknown> | undefined;
    const d1 = {
      prepare: vi.fn().mockReturnValue({}),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;
    const executionContext = {
      waitUntil: (p: Promise<unknown>) => { waited = p; },
    };

    ensureIndexes(d1, executionContext);
    expect(waited).toBeDefined();
  });

  it('preserves the ExecutionContext receiver when scheduling index backfill', () => {
    const d1 = {
      prepare: vi.fn().mockReturnValue({}),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;
    const executionContext = {
      waitUntil(this: unknown, _promise: Promise<unknown>) {
        if (this !== executionContext) {
          throw new TypeError('Illegal invocation: incorrect this reference');
        }
      },
    };

    expect(() => ensureIndexes(d1, executionContext)).not.toThrow();
  });

  it('does not crash when batch fails', () => {
    const d1 = {
      prepare: vi.fn().mockReturnValue({}),
      batch: vi.fn().mockRejectedValue(new Error('D1 down')),
    } as unknown as D1Database;
    // Should not throw — fire-and-forget with catch
    expect(() => ensureIndexes(d1)).not.toThrow();
  });
});

describe('ensurePasswordResetSchema', () => {
  it('renames the legacy throttle table and adds reset-token columns', async () => {
    const prepare = vi.fn((sql: string) => ({
      sql,
      all: vi.fn().mockResolvedValue(
        sql.includes('sqlite_master')
          ? { results: [{ name: 'typecho_password_reset_throttle' }] }
          : { results: [{ name: 'email' }, { name: 'lastSentAt' }] },
      ),
    }));
    const batch = vi.fn().mockResolvedValue([]);
    const d1 = { prepare, batch } as unknown as D1Database;

    await ensurePasswordResetSchema(d1);

    expect(batch).toHaveBeenCalledTimes(2);
    const rename = batch.mock.calls[0][0] as Array<{ sql: string }>;
    expect(rename[0].sql).toBe(
      'ALTER TABLE typecho_password_reset_throttle RENAME TO typecho_password_reset_requests',
    );
    expect(rename[1].sql).toBe('DROP INDEX IF EXISTS typecho_password_reset_tokenHash');
    const upgrades = batch.mock.calls[1][0] as Array<{ sql: string }>;
    expect(upgrades.map(statement => statement.sql)).toEqual([
      'ALTER TABLE typecho_password_reset_requests ADD COLUMN uid INTEGER',
      'ALTER TABLE typecho_password_reset_requests ADD COLUMN tokenHash TEXT',
      'ALTER TABLE typecho_password_reset_requests ADD COLUMN expiresAt INTEGER',
    ]);
  });

  it('runs only once after a successful upgrade', async () => {
    const prepare = vi.fn((sql: string) => ({
      sql,
      all: vi.fn().mockResolvedValue(
        sql.includes('sqlite_master')
          ? { results: [{ name: 'typecho_password_reset_requests' }] }
          : {
              results: [
                { name: 'email' },
                { name: 'lastSentAt' },
                { name: 'uid' },
                { name: 'tokenHash' },
                { name: 'expiresAt' },
              ],
            },
      ),
    }));
    const batch = vi.fn().mockResolvedValue([]);
    const d1 = { prepare, batch } as unknown as D1Database;

    await ensurePasswordResetSchema(d1);
    await ensurePasswordResetSchema(d1);

    expect(batch).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
