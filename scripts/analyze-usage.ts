#!/usr/bin/env bun
/**
 * Pull Cloudflare GraphQL usage summaries for typecho-workers.
 *
 * Usage:
 *   bun run perf:usage -- --days 3
 *   bun run perf:usage -- --from 2026-08-29 --to 2026-08-31
 *
 * Auth: Wrangler OAuth (`wrangler login`) preferred; or an API token with
 * Account Analytics Read scoped to the target account.
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID — auto-detected from `wrangler whoami` when omitted
 *   TYPECHO_WORKER_NAME (default: typecho-workers)
 *   TYPECHO_D1_DATABASE_ID (optional, for per-database D1 rows)
 */

import {
  cloudflareGraphql,
  parseDateRange,
  resolveAccountId,
} from './performance/lib/cloudflare-api.ts';

interface CliOptions {
  from?: string;
  to?: string;
  days?: number;
  scriptName: string;
  databaseId?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    scriptName: process.env.TYPECHO_WORKER_NAME?.trim() || 'typecho-workers',
    databaseId: process.env.TYPECHO_D1_DATABASE_ID?.trim(),
  };
  for (let i = 0; i < args.length; i++) {
    const next = (): string => {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${args[i - 1]}`);
      return value;
    };
    switch (args[i]) {
      case '--from': opts.from = next(); break;
      case '--to': opts.to = next(); break;
      case '--days': opts.days = Number(next()); break;
      case '--script': opts.scriptName = next(); break;
      case '--database-id': opts.databaseId = next(); break;
      case '--help':
        console.log('Usage: bun run scripts/analyze-usage.ts [--days N | --from DATE --to DATE]');
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  return opts;
}

const USAGE_QUERY = /* GraphQL */ `
query TypechoUsage(
  $accountTag: String!
  $scriptName: String!
  $dateFrom: Date!
  $dateTo: Date!
  $databaseId: String
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        filter: {
          scriptName: $scriptName
          date_geq: $dateFrom
          date_leq: $dateTo
        }
        limit: 10000
      ) {
        dimensions { date }
        sum {
          requests
          errors
        }
        quantiles {
          cpuTimeP50
          cpuTimeP75
          cpuTimeP90
          cpuTimeP99
        }
      }
      workersInvocationsAdaptiveExceeded: workersInvocationsAdaptive(
        filter: {
          scriptName: $scriptName
          date_geq: $dateFrom
          date_leq: $dateTo
          status: "exceededCpu"
        }
        limit: 10000
      ) {
        dimensions { date }
        sum { requests }
      }
      workersCacheRequestsAdaptiveGroups(
        filter: {
          scriptName: $scriptName
          date_geq: $dateFrom
          date_leq: $dateTo
        }
        limit: 10000
      ) {
        dimensions { date cacheStatus }
        sum { requests }
      }
      d1AnalyticsAdaptiveGroups(
        filter: {
          date_geq: $dateFrom
          date_leq: $dateTo
          databaseId: $databaseId
        }
        limit: 10000
      ) {
        dimensions { date }
        sum { readQueries writeQueries }
      }
      kvOperationsAdaptiveGroups(
        filter: {
          date_geq: $dateFrom
          date_leq: $dateTo
        }
        limit: 10000
      ) {
        dimensions { date actionType }
        sum { requests }
      }
    }
  }
}
`;

interface UsageRow {
  dimensions?: { date?: string; cacheStatus?: string; actionType?: string };
  sum?: {
    requests?: number;
    errors?: number;
    readQueries?: number;
    writeQueries?: number;
  };
  quantiles?: {
    cpuTimeP50?: number;
    cpuTimeP75?: number;
    cpuTimeP90?: number;
    cpuTimeP99?: number;
  };
}

interface UsageQueryData {
  viewer: {
    accounts: Array<{
      workersInvocationsAdaptive: UsageRow[];
      workersInvocationsAdaptiveExceeded: UsageRow[];
      workersCacheRequestsAdaptiveGroups: UsageRow[];
      d1AnalyticsAdaptiveGroups: UsageRow[];
      kvOperationsAdaptiveGroups: UsageRow[];
    }>;
  };
}

function usToMs(value: number | undefined): string {
  if (value === undefined || value === null) return '—';
  return (value / 1_000).toFixed(1);
}

function exceededByDate(rows: UsageRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const date = row.dimensions?.date;
    if (!date) continue;
    map.set(date, row.sum?.requests ?? 0);
  }
  return map;
}

function printWorkerCpu(rows: UsageRow[], exceededRows: UsageRow[]): void {
  const exceeded = exceededByDate(exceededRows);
  console.log('## Worker CPU / invocations');
  console.log('date       requests  1102   errors  P50ms  P75ms  P90ms  P99ms');
  for (const row of rows.sort((a, b) => (a.dimensions?.date || '').localeCompare(b.dimensions?.date || ''))) {
    const date = row.dimensions?.date || '?';
    const sum = row.sum || {};
    const q = row.quantiles || {};
    console.log(
      [
        date,
        String(sum.requests ?? 0).padStart(8),
        String(exceeded.get(date) ?? 0).padStart(6),
        String(sum.errors ?? 0).padStart(7),
        usToMs(q.cpuTimeP50).padStart(6),
        usToMs(q.cpuTimeP75).padStart(6),
        usToMs(q.cpuTimeP90).padStart(6),
        usToMs(q.cpuTimeP99).padStart(6),
      ].join('  '),
    );
  }
  console.log('');
}

function printCacheStatus(rows: UsageRow[]): void {
  const byDate = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const date = row.dimensions?.date;
    const status = row.dimensions?.cacheStatus;
    if (!date || !status) continue;
    if (!byDate.has(date)) byDate.set(date, new Map());
    byDate.get(date)!.set(status, row.sum?.requests ?? 0);
  }
  console.log('## L1 cache status (workersCacheRequestsAdaptiveGroups)');
  for (const date of [...byDate.keys()].sort()) {
    const statuses = byDate.get(date)!;
    const total = [...statuses.values()].reduce((sum, count) => sum + count, 0);
    const parts = [...statuses.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `${status} ${count} (${((count / total) * 100).toFixed(1)}%)`);
    console.log(`${date}  total=${total}  ${parts.join('  ')}`);
  }
  console.log('');
}

function printD1(rows: UsageRow[]): void {
  if (rows.length === 0) {
    console.log('## D1 (skipped — set TYPECHO_D1_DATABASE_ID or --database-id)');
    console.log('');
    return;
  }
  console.log('## D1 read/write (database queries, not row reads)');
  console.log('date       reads      writes');
  for (const row of rows.sort((a, b) => (a.dimensions?.date || '').localeCompare(b.dimensions?.date || ''))) {
    console.log(
      `${row.dimensions?.date || '?'}  `
      + `${String(row.sum?.readQueries ?? 0).padStart(9)}  `
      + `${String(row.sum?.writeQueries ?? 0).padStart(9)}`,
    );
  }
  console.log('');
}

function printKv(rows: UsageRow[]): void {
  const byDate = new Map<string, { read: number; write: number }>();
  for (const row of rows) {
    const date = row.dimensions?.date;
    const action = row.dimensions?.actionType;
    if (!date || !action) continue;
    if (!byDate.has(date)) byDate.set(date, { read: 0, write: 0 });
    const bucket = byDate.get(date)!;
    const count = row.sum?.requests ?? 0;
    if (action === 'read' || action === 'get') bucket.read += count;
    else if (action === 'write' || action === 'put') bucket.write += count;
  }
  console.log('## KV operations (account-wide)');
  console.log('date       reads   writes');
  for (const date of [...byDate.keys()].sort()) {
    const bucket = byDate.get(date)!;
    console.log(`${date}  ${String(bucket.read).padStart(5)}  ${String(bucket.write).padStart(6)}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const range = parseDateRange(opts);
  const accountTag = resolveAccountId();

  const data = await cloudflareGraphql<UsageQueryData>(USAGE_QUERY, {
    accountTag,
    scriptName: opts.scriptName,
    dateFrom: range.from,
    dateTo: range.to,
    databaseId: opts.databaseId || null,
  });

  const account = data.viewer.accounts[0];
  if (!account) throw new Error('Account not found in GraphQL response');

  console.log(`# Cloudflare usage ${range.from} .. ${range.to}`);
  console.log(`script=${opts.scriptName}  account=${accountTag}`);
  console.log('');

  printWorkerCpu(
    account.workersInvocationsAdaptive || [],
    account.workersInvocationsAdaptiveExceeded || [],
  );
  printCacheStatus(account.workersCacheRequestsAdaptiveGroups || []);
  printD1(account.d1AnalyticsAdaptiveGroups || []);
  printKv(account.kvOperationsAdaptiveGroups || []);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
