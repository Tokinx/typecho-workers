/** Compute a percentile from a sorted numeric array (linear interpolation). */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function roundMs(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

export function sortNumbers(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}
