/**
 * Unit tests for sampled request phase metrics (src/lib/request-metrics.ts).
 */
import { describe, it, expect } from 'vitest';
import { formatRequestMetrics, shouldSampleRequest } from '@/lib/request-metrics';

describe('shouldSampleRequest()', () => {
  it('always samples the first request in an isolate and marks it cold', () => {
    const first = shouldSampleRequest(false, () => 0.99);
    expect(first.sampled).toBe(true);
    expect(first.cold).toBe(true);
  });

  it('samples later requests only below the rate', () => {
    expect(shouldSampleRequest(true, () => 0.01).sampled).toBe(true);
    expect(shouldSampleRequest(true, () => 0.99).sampled).toBe(false);
    expect(shouldSampleRequest(true, () => 0.99).cold).toBe(false);
  });
});

describe('formatRequestMetrics()', () => {
  it('emits one JSON line with measured phases and request identity', () => {
    const line = formatRequestMetrics(
      { cold: true, earlyStartedAt: 0, earlyMs: 12.345, bootstrapMs: 3.211, renderMs: 8.901 },
      { path: '/', method: 'GET', status: 200, cache: 'L1' },
    );
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      cold: true,
      earlyMs: 12.35,
      bootstrapMs: 3.21,
      renderMs: 8.9,
      cache: 'L1',
      status: 200,
      method: 'GET',
      path: '/',
    });
  });

  it('drops unset phases, warm flags and empty cache markers', () => {
    const line = formatRequestMetrics(
      { cold: false, earlyStartedAt: 0 },
      { path: '/feed', method: 'GET', status: 200, cache: null },
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.bootstrapMs).toBeUndefined();
    expect(parsed.renderMs).toBeUndefined();
    expect(parsed.earlyMs).toBeUndefined();
    expect(parsed.cache).toBeUndefined();
    expect(parsed.cold).toBeUndefined();
    expect(parsed).toMatchObject({ path: '/feed', method: 'GET', status: 200 });
  });
});
