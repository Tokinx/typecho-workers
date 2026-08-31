/**
 * Minimal Cloudflare API helpers for performance analysis scripts.
 *
 * Auth (first match wins):
 *   CLOUDFLARE_API_TOKEN
 *   oauth_token in Wrangler config (~/.wrangler or macOS Preferences path)
 *
 * Required env:
 *   CLOUDFLARE_ACCOUNT_ID — account tag (or pass --account-id)
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'path';

const API_BASE = 'https://api.cloudflare.com/client/v4';

const WRANGLER_CONFIG_PATHS = [
  join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
  join(homedir(), '.wrangler', 'config', 'default.toml'),
  join(homedir(), '.config', '.wrangler', 'config', 'default.toml'),
];

function readWranglerOAuthToken(): string | null {
  for (const path of WRANGLER_CONFIG_PATHS) {
    try {
      const text = readFileSync(path, 'utf8');
      for (const line of text.split('\n')) {
        const quoted = line.match(/^oauth_token\s*=\s*"([^"]+)"/);
        if (quoted?.[1]) return quoted[1];
        const bare = line.match(/^oauth_token\s*=\s*'([^']+)'/);
        if (bare?.[1]) return bare[1];
      }
    } catch {
      // Try the next known Wrangler config location.
    }
  }
  return null;
}

export function resolveApiToken(options: { prefer?: 'env' | 'wrangler' } = {}): string {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const fromWrangler = readWranglerOAuthToken();
  const prefer = options.prefer
    ?? (process.env.CLOUDFLARE_AUTH_PREFER === 'wrangler' ? 'wrangler' : 'env');
  if (prefer === 'wrangler') {
    if (fromWrangler) return fromWrangler;
    if (fromEnv) return fromEnv;
  } else {
    if (fromEnv) return fromEnv;
    if (fromWrangler) return fromWrangler;
  }
  throw new Error(
    'Missing credentials. Export CLOUDFLARE_API_TOKEN or run `wrangler login`.',
  );
}

/** GraphQL analytics needs account-wide read; Wrangler OAuth is the usual fallback. */
export function resolveGraphqlToken(): string {
  return resolveApiToken({ prefer: 'wrangler' });
}

/** Telemetry queries often need a dedicated API token with Observability Read. */
export function resolveTelemetryToken(): string {
  return resolveApiToken({ prefer: 'env' });
}

function isAuthFailure(message: string): boolean {
  return /authentication error|invalid access token|not authorized|code:\s*9109|code:\s*10000/i.test(message);
}

/** Try env API token first, then Wrangler OAuth (deduped). */
export function telemetryTokenCandidates(): string[] {
  const candidates: string[] = [];
  const env = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const wrangler = readWranglerOAuthToken();
  if (env) candidates.push(env);
  if (wrangler && !candidates.includes(wrangler)) candidates.push(wrangler);
  if (candidates.length === 0) {
    throw new Error(
      'Missing credentials for telemetry. Export CLOUDFLARE_API_TOKEN or run `wrangler login`.',
    );
  }
  return candidates;
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Export it before running this script.`);
  }
  return value;
}

export function resolveAccountId(): string {
  const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;

  const whoami = spawnSync('bunx', ['wrangler', 'whoami'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const match = whoami.stdout.match(/│\s+[^│]+\s+│\s+([a-f0-9]{32})\s+│/);
  if (match?.[1]) return match[1];

  throw new Error(
    'Missing CLOUDFLARE_ACCOUNT_ID. Export it or run `wrangler login` so whoami can resolve the account.',
  );
}

export interface CloudflareApiError {
  code: number;
  message: string;
}

export async function cloudflareFetch<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const token = init.token ?? resolveApiToken();
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

export async function cloudflareFetchWithAuthFallback<T>(
  path: string,
  init: RequestInit,
  tokens: string[],
): Promise<T> {
  const failures: string[] = [];
  for (const token of tokens) {
    try {
      return await cloudflareFetch<T>(path, { ...init, token });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      failures.push(err.message);
      if (!isAuthFailure(err.message)) throw err;
    }
  }
  throw new Error(
    `Cloudflare API ${path} authentication failed (${tokens.length} credential(s) tried).\n`
    + failures.map((message, index) => `  ${index + 1}. ${message}`).join('\n')
    + '\nTelemetry needs CLOUDFLARE_API_TOKEN with Workers Observability Read, or a fresh `wrangler login`.',
  );
}

export async function cloudflareGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  token = resolveGraphqlToken(),
): Promise<T> {
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
