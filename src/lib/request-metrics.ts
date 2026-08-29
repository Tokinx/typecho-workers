/**
 * Sampled request phase timing for Workers Logs.
 *
 * Phases (wall clock; DB/KV I/O counts toward the phase that awaits it):
 * - bootstrapMs — middleware bootstrap (DB ready, options, plugins) before
 *   the route handler runs. Never measured on page-cache hits: the early
 *   provider serves those without entering the render chain at all.
 * - renderMs — the Astro route handler inside the render chain.
 * - earlyMs — the whole early-request provider chain, which on a page-cache
 *   hit serves the response without entering bootstrap/render, and on a
 *   miss includes both phases above.
 *
 * Every request gets a tiny holder object; only sampled requests produce a
 * log line. The isolate's first request is always sampled so cold-start CPU
 * shows up in the data.
 */
export const METRICS_SAMPLE_RATE = 0.05;

export interface RequestPhases {
  cold: boolean;
  earlyStartedAt: number;
  earlyMs?: number;
  bootstrapMs?: number;
  renderMs?: number;
}

export function shouldSampleRequest(
  seenRequest: boolean,
  random: () => number = Math.random,
): { sampled: boolean; cold: boolean } {
  const cold = !seenRequest;
  return { sampled: cold || random() < METRICS_SAMPLE_RATE, cold };
}

export function formatRequestMetrics(
  phases: RequestPhases,
  extra: { path: string; method: string; status: number; cache: string | null },
): string {
  const round = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : Math.round(value * 100) / 100;
  return JSON.stringify({
    cold: phases.cold || undefined,
    bootstrapMs: round(phases.bootstrapMs),
    renderMs: round(phases.renderMs),
    earlyMs: round(phases.earlyMs),
    cache: extra.cache || undefined,
    status: extra.status,
    method: extra.method,
    path: extra.path,
  });
}
