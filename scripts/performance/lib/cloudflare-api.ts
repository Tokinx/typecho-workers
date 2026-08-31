/**
 * Minimal Cloudflare API helpers for performance analysis scripts.
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN — Analytics Read + Workers Observability Read
 *   CLOUDFLARE_ACCOUNT_ID — account tag (bc920e…)
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Export it before running this script.`);
  }
  return value;
}

export interface CloudflareApiError {
  code: number;
  message: string;
}

export async function cloudflareFetch<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const token = init.token ?? requireEnv('CLOUDFLARE_API_TOKEN');
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const resultBody = await response.text();
  let body: {
    success?: boolean;
    errors?: CloudflareApiError[];
    result?: T;
  };
  try {
    body = JSON.parse(resultBody) as typeof body;
  } catch {
    throw new Error(`Cloudflare API ${path} failed (HTTP ${response.status} ${response.statusText}, non-JSON body)`);
  }
  if (!response.ok || body.success === false) {
    const detail = body.errors?.map(error => `${error.code}: ${error.message}`).join('; ')
      || response.statusText;
    throw new Error(`Cloudflare API ${path} failed: ${detail}`);
  }
  return body.result as T;
}

export async function cloudflareGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const response = await fetch(`${API_BASE}/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${response.statusText}`);
  }
  if (body.errors?.length) {
    throw new Error(`GraphQL error: ${body.errors.map(error => error.message).join('; ')}`);
  }
  if (!body.data) {
    throw new Error('GraphQL response missing data');
  }
  return body.data;
}

export function utcDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function parseDateRange(argv: {
  from?: string;
  to?: string;
  days?: number;
}): { from: string; to: string } {
  const to = argv.to || utcToday();
  const from = argv.from || utcDateDaysAgo(argv.days ?? 2);
  if (from > to) throw new Error(`Invalid date range: ${from} > ${to}`);
  return { from, to };
}

export function dateRangeToMs(from: string, to: string): { fromMs: number; toMs: number } {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T23:59:59.999Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error(`Invalid date range: ${from} .. ${to}`);
  }
  return { fromMs, toMs };
}
