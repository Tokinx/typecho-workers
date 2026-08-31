import { describe, expect, it } from 'vitest';
import {
  aggregateMetrics,
  metricsCacheKey,
  parseMetricsMessage,
} from '../../scripts/performance/lib/metrics-parse';

describe('parseMetricsMessage', () => {
  it('parses a standard [metrics] log line', () => {
    const entry = parseMetricsMessage(
      '[metrics] {"cache":"L1","earlyMs":7.2,"status":200,"method":"GET","path":"/"}',
    );
    expect(entry).toEqual({
      cache: 'L1',
      earlyMs: 7.2,
      status: 200,
      method: 'GET',
      path: '/',
    });
  });

  it('returns null for unrelated log lines', () => {
    expect(parseMetricsMessage('hello world')).toBeNull();
    expect(parseMetricsMessage('[metrics] not-json')).toBeNull();
  });
});

describe('aggregateMetrics', () => {
  it('groups by cache status and collects phase timings', () => {
    const buckets = aggregateMetrics([
      { cache: 'L1', earlyMs: 8, bootstrapMs: 1, renderMs: 2 },
      { cache: 'L1', earlyMs: 10 },
      { cache: 'BYPASS', renderMs: 40, bootstrapMs: 12 },
      { status: 404 },
    ]);
    expect(buckets.map(bucket => bucket.cache)).toEqual(['L1', 'BYPASS', '(none)']);
    expect(buckets[0].count).toBe(2);
    expect(buckets[0].earlyMs).toEqual([8, 10]);
    expect(buckets[1].renderMs).toEqual([40]);
    expect(metricsCacheKey({})).toBe('(none)');
  });
});
