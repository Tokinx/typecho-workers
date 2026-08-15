/**
 * Unit tests for src/lib/scanner-protection.ts.
 * Covers scanner-path classification, the in-isolate 404 rate limit, and
 * the page-slug negative cache used by [slug].astro.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FAST_404_HTML,
  isKnownMissingSlug,
  isScannerPath,
  markSlugMissing,
  resetScannerProtectionForTests,
  shouldRateLimitScanner,
} from '@/lib/scanner-protection';
import { resetSlidingWindow } from '@/lib/login-rate-limit';

describe('isScannerPath', () => {
  it('classifies multi-segment paths as scanner paths', () => {
    expect(isScannerPath('/.git/config')).toBe(true);
    expect(isScannerPath('/wp-content/plugins/x.php')).toBe(true);
    expect(isScannerPath('/foo/bar/')).toBe(true);
    expect(isScannerPath('/a/b/c')).toBe(true);
  });

  it('classifies dangerous single-segment extensions', () => {
    expect(isScannerPath('/wp-login.php')).toBe(true);
    expect(isScannerPath('/shell.php')).toBe(true);
    expect(isScannerPath('/backup.zip')).toBe(true);
    expect(isScannerPath('/config.yml')).toBe(true);
    expect(isScannerPath('/credentials.key')).toBe(true);
    expect(isScannerPath('/index.php')).toBe(true);
  });

  it('is case-insensitive for extensions', () => {
    expect(isScannerPath('/Shell.PHP')).toBe(true);
    expect(isScannerPath('/config.YML')).toBe(true);
    expect(isScannerPath('/README.MD')).toBe(false); // .md is not dangerous
  });

  it('classifies dotfiles as scanner paths', () => {
    expect(isScannerPath('/.env')).toBe(true);
    expect(isScannerPath('/.git')).toBe(true);
    expect(isScannerPath('/.htaccess')).toBe(true);
    expect(isScannerPath('/.DS_Store')).toBe(true);
  });

  it('leaves ordinary single-segment slugs untouched', () => {
    expect(isScannerPath('/about')).toBe(false);
    expect(isScannerPath('/hello-world')).toBe(false);
    expect(isScannerPath('/note')).toBe(false);
    expect(isScannerPath('/')).toBe(false);
    expect(isScannerPath('/about.html')).toBe(false); // built-in page route
    expect(isScannerPath('/feed')).toBe(false);
  });

  it('does not treat dots inside slugs as extensions', () => {
    // A slug containing a dot but not ending in a dangerous extension.
    expect(isScannerPath('/v1.2')).toBe(false);
  });

  it('serves minimal HTML as the fast-fail body', () => {
    expect(FAST_404_HTML).toContain('404');
    expect(FAST_404_HTML).toContain('<title>');
    expect(FAST_404_HTML.length).toBeLessThan(400);
  });
});

describe('shouldRateLimitScanner', () => {
  const now = 1_000_000;

  beforeEach(() => {
    resetSlidingWindow();
  });
  afterEach(() => {
    resetSlidingWindow();
  });

  it('allows requests under the limit and rejects beyond it', () => {
    let t = now;
    // SCANNER_404_RATE_LIMIT = { windowSeconds: 60, maxRequests: 120 }
    for (let i = 0; i < 120; i += 1) {
      expect(shouldRateLimitScanner('1.2.3.4', t)).toBe(false);
    }
    expect(shouldRateLimitScanner('1.2.3.4', t)).toBe(true);
  });

  it('counts per IP independently', () => {
    for (let i = 0; i < 200; i += 1) {
      shouldRateLimitScanner('5.6.7.8', now);
    }
    expect(shouldRateLimitScanner('5.6.7.8', now)).toBe(true); // exhausted
    expect(shouldRateLimitScanner('9.9.9.9', now)).toBe(false); // separate bucket
  });

  it('resets after the window elapses', () => {
    for (let i = 0; i < 121; i += 1) {
      shouldRateLimitScanner('1.1.1.1', now);
    }
    expect(shouldRateLimitScanner('1.1.1.1', now)).toBe(true);
    expect(shouldRateLimitScanner('1.1.1.1', now + 61_000)).toBe(false);
  });

  it('shares a bucket for requests without an IP', () => {
    for (let i = 0; i < 121; i += 1) {
      shouldRateLimitScanner('', now);
    }
    expect(shouldRateLimitScanner('', now)).toBe(true);
  });
});

describe('page slug negative cache', () => {
  beforeEach(() => {
    resetScannerProtectionForTests();
  });
  afterEach(() => {
    resetScannerProtectionForTests();
  });

  it('misses unknown slugs and hits after markSlugMissing', () => {
    expect(isKnownMissingSlug('nope')).toBe(false);
    markSlugMissing('nope', 1_000);
    expect(isKnownMissingSlug('nope', 1_000)).toBe(true);
  });

  it('expires entries after the TTL', () => {
    markSlugMissing('nope', 1_000);
    expect(isKnownMissingSlug('nope', 1_000 + 30_000)).toBe(true); // within TTL
    expect(isKnownMissingSlug('nope', 1_000 + 30_001)).toBe(false); // expired
  });

  it('does not re-record an existing entry', () => {
    markSlugMissing('nope', 1_000);
    markSlugMissing('nope', 1_000); // no-op, expiry stays at first write
    expect(isKnownMissingSlug('nope', 1_000 + 29_999)).toBe(true);
    expect(isKnownMissingSlug('nope', 1_000 + 30_001)).toBe(false);
  });

  it('evicts expired entries when at capacity', () => {
    // Write MAX entries, then a new one forces eviction of the oldest.
    for (let i = 0; i < 10_000; i += 1) {
      markSlugMissing(`slug-${i}`, 1_000);
    }
    markSlugMissing('newest', 1_000);
    expect(isKnownMissingSlug('newest', 1_000)).toBe(true);
    // The oldest entry was evicted; capacity is preserved.
    expect(isKnownMissingSlug('slug-0', 1_000)).toBe(false);
  });
});
