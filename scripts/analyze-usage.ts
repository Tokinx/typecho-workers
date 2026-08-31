#!/usr/bin/env bun
/**
 * Pull Cloudflare GraphQL usage summaries for typecho-workers.
 *
 * Usage:
 *   bun run perf:usage -- --days 3
 *   bun run perf:usage -- --from 2026-08-29 --to 2026-08-31
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 *   TYPECHO_WORKER_NAME (default: typecho-workers)
 *   TYPECHO_D1_DATABASE_ID (optional, for per-database D1 rows)
 */

import {
  cloudflareGraphql,
  parseDateRange,
  requireEnv,
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
          accountTag: $accountTag
          scriptName: $scriptName
          date_geq: $dateFrom
          date_leq: $dateTo
        }
        limit: 10000
      ) {
        dimensions { date }
        sum {
          requests
          requestsStatusExceededCpu
          errors
        }
        quantiles {
          cpuTimeUsP50
          cpuTimeUsP75
          cpuTimeUsP90
          cpuTimeUsP99
        }
      }
      workersCacheRequestsAdaptiveGroups(
        filter: {
          accountTag: $accountTag
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
          accountTag: $accountTag
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
          accountTag: $accountTag
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
    requestsStatusExceededCpu?: number;
    errors?: number;
    readQueries?: number;
    writeQueries?: number;
  };
  quantiles?: {
    cpuTimeUsP50?: number;
    cpuTimeUsP75?: number;
    cpuTimeUsP90?: number;
    cpuTimeUsP99?: number;
  };
}

interface UsageQueryData {
  viewer: {
    accounts: Array<{
      workersInvocationsAdaptive: UsageRow[];
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

function printWorkerCpu(rows: UsageRow[]): void {
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
        String(sum.requestsStatusExceededCpu ?? 0).padStart(6),
        String(sum.errors ?? 0).padStart(7),
        usToMs(q.cpuTimeUsP50).padStart(6),
        usToMs(q.cpuTimeUsP75).padStart(6),
        usToMs(q.cpuTimeUsP90).padStart(6),
        usToMs(q.cpuTimeUsP99).padStart(6),
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
  console.log('## D1 read/write');
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
  const accountTag = requireEnv('CLOUDFLARE_ACCOUNT_ID');

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

  printWorkerCpu(account.workersInvocationsAdaptive || []);
  printCacheStatus(account.workersCacheRequestsAdaptiveGroups || []);
  printD1(account.d1AnalyticsAdaptiveGroups || []);
  printKv(account.kvOperationsAdaptiveGroups || []);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
