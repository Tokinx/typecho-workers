/**
 * Unit tests for src/lib/login-rate-limit.ts.
 * Covers sliding-window failure tracking and the lock/unlock lifecycle
 * used by /api/users/login (G1-3).
 *
 * State is now persisted in D1 rather than an in-isolate Map, so tests
 * exercise a real SQLite database via the test-helper factory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_LOGIN_RATE_LIMIT,
  clearLoginFailures,
  loginLockedUntil,
  readLoginRateLimitConfig,
  recordLoginFailure,
  purgeExpiredLoginFailures,
  resetSlidingWindow,
  slidingWindowRetryAfterSeconds,
  trackSlidingWindow,
  type LoginRateLimitConfig,
} from '@/lib/login-rate-limit';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';

const cfg: LoginRateLimitConfig = {
  enabled: true,
  windowSeconds: 60,
  maxFailures: 3,
  banSeconds: 30,
};

let db: TestDatabase;

describe('login-rate-limit', () => {
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await disposeTestDb(db);
  });

  it('does nothing when disabled', async () => {
    const disabled: LoginRateLimitConfig = { ...cfg, enabled: false };
    for (let i = 0; i < 100; i++) await recordLoginFailure(db, '1.2.3.4', disabled);
    expect(await loginLockedUntil(db, '1.2.3.4', disabled)).toBe(0);
  });

  it('does nothing for empty IP', async () => {
    await recordLoginFailure(db, '', cfg);
    expect(await loginLockedUntil(db, '', cfg)).toBe(0);
  });

  it('does not lock until maxFailures is reached', async () => {
    await recordLoginFailure(db, '1.2.3.4', cfg);
    await recordLoginFailure(db, '1.2.3.4', cfg);
    expect(await loginLockedUntil(db, '1.2.3.4', cfg)).toBe(0);
  });

  it('locks after the configured number of failures', async () => {
    const now = Date.now();
    for (let i = 0; i < cfg.maxFailures; i++) await recordLoginFailure(db, '1.2.3.4', cfg, now);
    const until = await loginLockedUntil(db, '1.2.3.4', cfg, now);
    expect(until).toBeGreaterThan(now);
    expect(until).toBeLessThanOrEqual(now + cfg.banSeconds * 1000 + 5);
  });

  it('lock expires after banSeconds', async () => {
    const start = Date.now();
    for (let i = 0; i < cfg.maxFailures; i++) await recordLoginFailure(db, '1.2.3.4', cfg, start);
    expect(await loginLockedUntil(db, '1.2.3.4', cfg, start)).toBeGreaterThan(start);
    // Probe past the ban window — IP should be unlocked again.
    expect(await loginLockedUntil(db, '1.2.3.4', cfg, start + cfg.banSeconds * 1000 + 1)).toBe(0);
  });

  it('window resets after windowSeconds with intermittent failures', async () => {
    const t0 = Date.now();
    await recordLoginFailure(db, '1.2.3.4', cfg, t0);
    await recordLoginFailure(db, '1.2.3.4', cfg, t0 + 1000);
    // Failure beyond window — counter starts over.
    await recordLoginFailure(db, '1.2.3.4', cfg, t0 + cfg.windowSeconds * 1000 + 1);
    expect(await loginLockedUntil(db, '1.2.3.4', cfg, t0 + cfg.windowSeconds * 1000 + 2)).toBe(0);
  });

  it('clearLoginFailures resets the counter', async () => {
    await recordLoginFailure(db, '1.2.3.4', cfg);
    await recordLoginFailure(db, '1.2.3.4', cfg);
    await clearLoginFailures(db, '1.2.3.4');
    // Should now require maxFailures fresh failures to lock.
    await recordLoginFailure(db, '1.2.3.4', cfg);
    expect(await loginLockedUntil(db, '1.2.3.4', cfg)).toBe(0);
  });

  it('different IPs have independent counters', async () => {
    for (let i = 0; i < cfg.maxFailures; i++) await recordLoginFailure(db, '1.1.1.1', cfg);
    expect(await loginLockedUntil(db, '1.1.1.1', cfg)).toBeGreaterThan(0);
    expect(await loginLockedUntil(db, '2.2.2.2', cfg)).toBe(0);
  });

  it('purgeExpiredLoginFailures removes rows whose ban has passed', async () => {
    const start = Date.now();
    for (let i = 0; i < cfg.maxFailures; i++) await recordLoginFailure(db, '1.2.3.4', cfg, start);
    // Fast-forward past the ban window and purge.
    await purgeExpiredLoginFailures(db, undefined, start + cfg.banSeconds * 1000 + 1);
    // Row is gone → next lookup returns 0 without special-casing.
    expect(await loginLockedUntil(db, '1.2.3.4', cfg, start + cfg.banSeconds * 1000 + 1)).toBe(0);
  });
});

describe('readLoginRateLimitConfig', () => {
  it('falls back to defaults when options are empty', () => {
    expect(readLoginRateLimitConfig({})).toEqual(DEFAULT_LOGIN_RATE_LIMIT);
  });

  it('honours numeric overrides within range', () => {
    const out = readLoginRateLimitConfig({
      loginFailBanWindowSeconds: 600,
      loginFailBanMaxFailures: 10,
      loginFailBanSeconds: 1800,
    });
    expect(out.windowSeconds).toBe(600);
    expect(out.maxFailures).toBe(10);
    expect(out.banSeconds).toBe(1800);
  });

  it('clamps out-of-range values', () => {
    const out = readLoginRateLimitConfig({
      loginFailBanMaxFailures: 9999,
      loginFailBanWindowSeconds: 0,
      loginFailBanSeconds: 99999,
    });
    expect(out.maxFailures).toBeLessThanOrEqual(100);
    expect(out.windowSeconds).toBeGreaterThanOrEqual(10);
    expect(out.banSeconds).toBeLessThanOrEqual(86400);
  });

  it('parses string numerics from form input', () => {
    const out = readLoginRateLimitConfig({
      loginFailBanMaxFailures: '7',
      loginFailBanWindowSeconds: '120',
      loginFailBanSeconds: '600',
    });
    expect(out.maxFailures).toBe(7);
    expect(out.windowSeconds).toBe(120);
    expect(out.banSeconds).toBe(600);
  });

  it('treats falsy enabled values as disabled', () => {
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: 0 }).enabled).toBe(false);
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: '0' }).enabled).toBe(false);
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: false }).enabled).toBe(false);
  });

  it('treats truthy enabled values as enabled', () => {
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: 1 }).enabled).toBe(true);
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: '1' }).enabled).toBe(true);
    expect(readLoginRateLimitConfig({ loginFailBanEnabled: true }).enabled).toBe(true);
  });
});

describe('trackSlidingWindow', () => {
  beforeEach(() => resetSlidingWindow());

  it('allows requests up to maxRequests, then rejects within the window', () => {
    const config = { windowSeconds: 60, maxRequests: 3 };
    expect(trackSlidingWindow('k', config, 1_000)).toBe(true);
    expect(trackSlidingWindow('k', config, 2_000)).toBe(true);
    expect(trackSlidingWindow('k', config, 3_000)).toBe(true);
    expect(trackSlidingWindow('k', config, 4_000)).toBe(false);
  });

  it('resets the window once windowSeconds elapse', () => {
    const config = { windowSeconds: 60, maxRequests: 1 };
    expect(trackSlidingWindow('k', config, 1_000)).toBe(true);
    expect(trackSlidingWindow('k', config, 2_000)).toBe(false);
    // Window holds until strictly past windowSeconds (60_000 ms later).
    expect(trackSlidingWindow('k', config, 61_001)).toBe(true);
  });

  it('tracks keys independently', () => {
    const config = { windowSeconds: 60, maxRequests: 1 };
    expect(trackSlidingWindow('a', config, 1_000)).toBe(true);
    expect(trackSlidingWindow('b', config, 1_000)).toBe(true);
    expect(trackSlidingWindow('a', config, 2_000)).toBe(false);
    expect(trackSlidingWindow('b', config, 2_000)).toBe(false);
  });
});

describe('slidingWindowRetryAfterSeconds', () => {
  beforeEach(() => resetSlidingWindow());

  it('returns 0 when no window is active for the key', () => {
    expect(slidingWindowRetryAfterSeconds('missing')).toBe(0);
  });

  it('reports the seconds remaining until the window resets', () => {
    trackSlidingWindow('k', { windowSeconds: 60, maxRequests: 1 }, 10_000);
    expect(slidingWindowRetryAfterSeconds('k', 25_000)).toBe(45);
  });

  it('returns 0 after the window has expired', () => {
    trackSlidingWindow('k', { windowSeconds: 60, maxRequests: 1 }, 10_000);
    expect(slidingWindowRetryAfterSeconds('k', 70_000)).toBe(0);
  });
});
