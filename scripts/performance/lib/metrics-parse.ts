/**
 * Parse `[metrics]` console.log lines emitted by src/lib/request-metrics.ts.
 */

export interface MetricsEntry {
  cold?: boolean;
  bootstrapMs?: number;
  renderMs?: number;
  earlyMs?: number;
  cache?: string | null;
  status?: number;
  method?: string;
  path?: string;
}

export interface MetricsBucketStats {
  cache: string;
  count: number;
  earlyMs: number[];
  bootstrapMs: number[];
  renderMs: number[];
}

const METRICS_PREFIX = '[metrics] ';

/** Extract JSON payload from a Workers log message line. */
export function parseMetricsMessage(message: string): MetricsEntry | null {
  const trimmed = message.trim();
  const index = trimmed.indexOf(METRICS_PREFIX);
  if (index < 0) return null;
  const json = trimmed.slice(index + METRICS_PREFIX.length).trim();
  if (!json.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(json) as MetricsEntry;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function metricsCacheKey(entry: MetricsEntry): string {
  const cache = entry.cache?.trim();
  return cache && cache.length > 0 ? cache : '(none)';
}

export function aggregateMetrics(entries: MetricsEntry[]): MetricsBucketStats[] {
  const buckets = new Map<string, MetricsBucketStats>();
  for (const entry of entries) {
    const key = metricsCacheKey(entry);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { cache: key, count: 0, earlyMs: [], bootstrapMs: [], renderMs: [] };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (typeof entry.earlyMs === 'number' && Number.isFinite(entry.earlyMs)) {
      bucket.earlyMs.push(entry.earlyMs);
    }
    if (typeof entry.bootstrapMs === 'number' && Number.isFinite(entry.bootstrapMs)) {
      bucket.bootstrapMs.push(entry.bootstrapMs);
    }
    if (typeof entry.renderMs === 'number' && Number.isFinite(entry.renderMs)) {
      bucket.renderMs.push(entry.renderMs);
    }
  }
  const order = ['L1', 'L2', 'L3', 'MISS', 'BYPASS', '(none)'];
  return [...buckets.values()].sort((a, b) => {
    const ai = order.indexOf(a.cache);
    const bi = order.indexOf(b.cache);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.cache.localeCompare(b.cache) || b.count - a.count;
  });
}
