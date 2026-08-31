#!/usr/bin/env bun
/**
 * Aggregate `[metrics]` Workers log samples by cache status.
 *
 * Usage:
 *   # Live query (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
 *   bun run perf:metrics -- --days 3
 *   bun run perf:metrics -- --from 2026-08-29 --to 2026-08-31
 *
 *   # Offline: NDJSON export (one JSON object per line with a `message` field)
 *   bun run perf:metrics -- --file ./metrics.ndjson
 *   cat metrics.ndjson | bun run perf:metrics -- --stdin
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 *   TYPECHO_WORKER_NAME (default: typecho-workers)
 */

import { readFileSync } from 'node:fs';
import {
  cloudflareFetch,
  dateRangeToMs,
  parseDateRange,
  requireEnv,
} from './performance/lib/cloudflare-api.ts';
import {
  aggregateMetrics,
  parseMetricsMessage,
  type MetricsEntry,
} from './performance/lib/metrics-parse.ts';
import { percentile, roundMs, sortNumbers } from './performance/lib/stats.ts';

interface CliOptions {
  from?: string;
  to?: string;
  days?: number;
  file?: string;
  stdin: boolean;
  service: string;
  limit: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    stdin: false,
    service: process.env.TYPECHO_WORKER_NAME?.trim() || 'typecho-workers',
    limit: 10_000,
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
      case '--file': opts.file = next(); break;
      case '--stdin': opts.stdin = true; break;
      case '--service': opts.service = next(); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--help':
        console.log(`Usage: bun run scripts/analyze-metrics.ts [--days N | --from YYYY-MM-DD --to YYYY-MM-DD]
       bun run scripts/analyze-metrics.ts --file path.ndjson
       bun run scripts/analyze-metrics.ts --stdin`);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  return opts;
}

function entriesFromNdjson(text: string): MetricsEntry[] {
  const entries: MetricsEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message = trimmed;
    try {
      const row = JSON.parse(trimmed) as { message?: string; Message?: string };
      message = row.message || row.Message || trimmed;
    } catch {
      // Plain log line.
    }
    const entry = parseMetricsMessage(message);
    if (entry) entries.push(entry);
  }
  return entries;
}

interface TelemetryEvent {
  message?: string;
  timestamp?: string;
}

interface TelemetryQueryResult {
  events?: TelemetryEvent[];
  continuationToken?: string;
}

async function fetchTelemetryEvents(
  accountId: string,
  fromMs: number,
  toMs: number,
  service: string,
  limit: number,
): Promise<MetricsEntry[]> {
  const entries: MetricsEntry[] = [];
  let continuationToken: string | undefined;
  do {
    const body: Record<string, unknown> = {
      timeframe: { from: fromMs, to: toMs },
      limit: Math.min(limit - entries.length, 1_000),
      parameters: {
        datasets: ['workers'],
        filters: [
          { key: '$metadata.service', operation: 'eq', value: service, type: 'string' },
          { key: 'message', operation: 'includes', value: '[metrics]', type: 'string' },
        ],
      },
    };
    if (continuationToken) body.continuationToken = continuationToken;

    const result = await cloudflareFetch<TelemetryQueryResult>(
      `/accounts/${accountId}/workers/observability/telemetry/query`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    for (const event of result.events || []) {
      if (!event.message) continue;
      const entry = parseMetricsMessage(event.message);
      if (entry) entries.push(entry);
    }
    continuationToken = result.continuationToken;
  } while (continuationToken && entries.length < limit);

  return entries;
}

function printReport(entries: MetricsEntry[]): void {
  if (entries.length === 0) {
    console.log('No [metrics] samples found.');
    return;
  }
  const buckets = aggregateMetrics(entries);
  console.log(`Samples: ${entries.length}`);
  console.log('');
  console.log(
    ['cache', 'count', 'early P50', 'early P90', 'bootstrap P50', 'render P50', 'render P90']
      .map(column => column.padEnd(14))
      .join(''),
  );
  for (const bucket of buckets) {
    const early = sortNumbers(bucket.earlyMs);
    const bootstrap = sortNumbers(bucket.bootstrapMs);
    const render = sortNumbers(bucket.renderMs);
    console.log(
      [
        bucket.cache,
        String(bucket.count),
        roundMs(percentile(early, 50)),
        roundMs(percentile(early, 90)),
        roundMs(percentile(bootstrap, 50)),
        roundMs(percentile(render, 50)),
        roundMs(percentile(render, 90)),
      ].map((value, index) => (index === 0 ? value.padEnd(14) : value.padStart(14))).join(''),
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  let entries: MetricsEntry[];

  if (opts.stdin) {
    entries = entriesFromNdjson(readFileSync(0, 'utf8'));
  } else if (opts.file) {
    entries = entriesFromNdjson(readFileSync(opts.file, 'utf8'));
  } else {
    const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
    const range = parseDateRange(opts);
    const { fromMs, toMs } = dateRangeToMs(range.from, range.to);
    console.error(`Querying telemetry ${range.from} .. ${range.to} (${opts.service})…`);
    entries = await fetchTelemetryEvents(accountId, fromMs, toMs, opts.service, opts.limit);
  }

  printReport(entries);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
