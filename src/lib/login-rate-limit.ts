/**
 * Persistent brute-force throttle for the admin login form.
 *
 * Counters live in D1 (typecho_login_failures) so that Cloudflare Workers
 * spawning many isolates per PoP — and requests balanced across PoPs — see
 * the same count. Previous in-isolate `Map` gave the attacker effectively
 * N × maxFailures attempts where N was the number of isolates they hit.
 *
 * Locked is keyed by client IP only — locking by username creates a
 * trivial DoS where any attacker can lock out a known administrator. IPs
 * trade off a small amount of false positives behind shared NATs for a
 * meaningful guard against credential stuffing.
 */

import { schema, type Database } from '@/db';
import { and, eq, lt } from 'drizzle-orm';

type LoginRateLimitDatabase = Pick<Database, 'query' | 'insert' | 'update' | 'delete'>;

export interface LoginRateLimitConfig {
  enabled: boolean;
  /** Sliding window in seconds during which failures accumulate. */
  windowSeconds: number;
  /** Failures before the IP is locked. */
  maxFailures: number;
  /** Lock duration in seconds. */
  banSeconds: number;
}

export const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimitConfig = {
  enabled: true,
  windowSeconds: 300,
  maxFailures: 5,
  banSeconds: 900,
};

/**
 * Read login rate-limit configuration from the merged options object.
 * Falls back to defaults for any missing/invalid value so the worker can
 * never fail open due to a typo in the admin form.
 */
export function readLoginRateLimitConfig(options: Record<string, unknown>): LoginRateLimitConfig {
  const num = (key: string, fallback: number, min: number, max: number) => {
    const raw = options[key];
    const parsed = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };

  return {
    enabled: options.loginFailBanEnabled === undefined
      ? DEFAULT_LOGIN_RATE_LIMIT.enabled
      : (options.loginFailBanEnabled !== 0 && options.loginFailBanEnabled !== '0' && options.loginFailBanEnabled !== false),
    windowSeconds: num('loginFailBanWindowSeconds', DEFAULT_LOGIN_RATE_LIMIT.windowSeconds, 10, 86_400),
    maxFailures: num('loginFailBanMaxFailures', DEFAULT_LOGIN_RATE_LIMIT.maxFailures, 1, 100),
    banSeconds: num('loginFailBanSeconds', DEFAULT_LOGIN_RATE_LIMIT.banSeconds, 10, 86_400),
  };
}

/**
 * Returns the lock expiry in milliseconds, or 0 if not locked. If the ban
 * has already expired we opportunistically delete the row to keep the
 * table small under long-running attacks.
 */
export async function loginLockedUntil(
  db: LoginRateLimitDatabase,
  ip: string,
  config: LoginRateLimitConfig,
  now = Date.now(),
): Promise<number> {
  if (!config.enabled || !ip) return 0;
  const row = await db.query.loginFailures.findFirst({ where: eq(schema.loginFailures.ip, ip) });
  if (!row) return 0;
  if (row.bannedUntil > now) return row.bannedUntil;
  // Ban expired or never set — treat as unlocked. We do NOT delete the
  // row here so an ongoing sliding-window attack keeps accumulating.
  return 0;
}

export async function recordLoginFailure(
  db: LoginRateLimitDatabase,
  ip: string,
  config: LoginRateLimitConfig,
  now = Date.now(),
): Promise<void> {
  if (!config.enabled || !ip) return;
  const windowMs = config.windowSeconds * 1000;
  const banMs = config.banSeconds * 1000;
  const current = await db.query.loginFailures.findFirst({ where: eq(schema.loginFailures.ip, ip) });

  const inWindow = current && now - current.windowStartedAt <= windowMs;
  const failures = (inWindow ? current!.failures : 0) + 1;
  const windowStartedAt = inWindow ? current!.windowStartedAt : now;
  const bannedUntil = failures >= config.maxFailures ? now + banMs : 0;

  if (current) {
    await db
      .update(schema.loginFailures)
      .set({ failures, windowStartedAt, bannedUntil })
      .where(eq(schema.loginFailures.ip, ip));
  } else {
    await db.insert(schema.loginFailures).values({ ip, failures, windowStartedAt, bannedUntil });
  }
}

export async function clearLoginFailures(db: LoginRateLimitDatabase, ip: string): Promise<void> {
  if (!ip) return;
  await db.delete(schema.loginFailures).where(eq(schema.loginFailures.ip, ip));
}

/**
 * Delete rows whose window and ban have both expired. Callers can invoke
 * this from a scheduled job — never inline on the request path.
 *
 * Pass `windowSeconds` (from the current LoginRateLimitConfig) to also
 * clean up rows whose sliding window has aged out even though a ban was
 * never issued. Without this, an IP that got 1 failure and then vanished
 * leaves a permanent row.
 */
export async function purgeExpiredLoginFailures(
  db: LoginRateLimitDatabase,
  windowSeconds?: number,
  now = Date.now(),
): Promise<void> {
  if (windowSeconds && windowSeconds > 0) {
    const windowExpiry = now - windowSeconds * 1000;
    await db.delete(schema.loginFailures).where(and(
      lt(schema.loginFailures.bannedUntil, now),
      lt(schema.loginFailures.windowStartedAt, windowExpiry),
    ));
    return;
  }
  await db.delete(schema.loginFailures).where(lt(schema.loginFailures.bannedUntil, now));
}

// ─── Per-actor sliding-window rate limiter ─────────────────────────────────
// Reused by the upload endpoint (G5-4) to cap per-user request rate.

interface SlidingWindowState {
  count: number;
  windowStartedAt: number;
  windowSeconds: number;
}

const slidingWindows = new Map<string, SlidingWindowState>();

export interface SlidingWindowConfig {
  windowSeconds: number;
  maxRequests: number;
}

/**
 * Returns true if the request is allowed under the sliding window for
 * the given key, false if rate-limited. Intentionally light — no Retry
 * timestamps; callers should report 429 with a `Retry-After: <window>`
 * header.
 */
export function trackSlidingWindow(
  key: string,
  config: SlidingWindowConfig,
  now = Date.now(),
): boolean {
  const windowMs = config.windowSeconds * 1000;
  const state = slidingWindows.get(key);
  if (!state || now - state.windowStartedAt > windowMs) {
    slidingWindows.set(key, { count: 1, windowStartedAt: now, windowSeconds: config.windowSeconds });
    return true;
  }
  if (state.count >= config.maxRequests) return false;
  state.count += 1;
  return true;
}

/**
 * Seconds remaining until the sliding window for the key resets, or 0 when
 * no window is currently active for the key. Lets callers report a precise
 * retry delay instead of the full window.
 */
export function slidingWindowRetryAfterSeconds(key: string, now = Date.now()): number {
  const state = slidingWindows.get(key);
  if (!state) return 0;
  const remainingMs = state.windowStartedAt + state.windowSeconds * 1000 - now;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

/** For tests only. */
export function resetSlidingWindow(): void {
  slidingWindows.clear();
}
