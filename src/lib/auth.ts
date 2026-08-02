import { eq, and } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';

// Typecho user groups: administrator(0), editor(1), contributor(2), subscriber(3), visitor(4)
export const UserGroup = {
  administrator: 'administrator',
  editor: 'editor',
  contributor: 'contributor',
  subscriber: 'subscriber',
  visitor: 'visitor',
} as const;

export type UserGroupType = typeof UserGroup[keyof typeof UserGroup];

const groupHierarchy: Record<string, number> = {
  administrator: 0,
  editor: 1,
  contributor: 2,
  subscriber: 3,
  visitor: 4,
};

/**
 * Check if a user passes a certain group level
 * Lower number = higher privilege
 */
export function hasPermission(userGroup: string, requiredGroup: string, strict = false): boolean {
  const userLevel = groupHierarchy[userGroup] ?? 4;
  const requiredLevel = groupHierarchy[requiredGroup] ?? 4;
  return strict ? userLevel === requiredLevel : userLevel <= requiredLevel;
}

/**
 * Ownership check with automatic admin override.
 *
 * `canManageResource(user, resource)` returns true when either:
 *   - the user is in the administrator group, or
 *   - the resource's owner id equals the user's uid.
 *
 * Prefer this over open-coding the pattern at API boundaries — it
 * centralises the admin-override rule so tightening (e.g. a
 * super-admin-only override) can happen in one place.
 */
export function canManageResource(
  user: { uid: number; group?: string | null },
  resource: { authorId?: number | null; ownerId?: number | null },
): boolean {
  if (hasPermission(user.group || 'visitor', 'administrator')) return true;
  const owner = resource.authorId ?? resource.ownerId ?? -1;
  return owner === user.uid;
}

/**
 * Recommended PBKDF2 iteration count (OWASP 2024+).
 * `verifyPassword` honours whatever count is embedded in the stored hash, so
 * raising this value is fully backwards compatible — older hashes still
 * verify, and `passwordHashNeedsRehash` flags them for transparent upgrade
 * after the next successful login.
 */
export const PBKDF2_ITERATIONS = 600_000;

/**
 * Hash a password using PBKDF2 with a random salt (Cloudflare Workers compatible).
 * Output format: $PBKDF2$iterations$salt$hash
 */
export async function hashPassword(password: string): Promise<string> {
  const iterations = PBKDF2_ITERATIONS;
  const salt = generateSalt(16);
  const hash = await pbkdf2Hash(password, salt, iterations);
  return `$PBKDF2$${iterations}$${salt}$${hash}`;
}

/**
 * Detect whether a stored PBKDF2 hash uses fewer iterations than the current
 * recommendation. The login route uses this to opportunistically upgrade
 * legacy hashes to the new strength without forcing a password reset.
 */
export function passwordHashNeedsRehash(storedHash: string): boolean {
  if (!storedHash.startsWith('$PBKDF2$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 5) return false;
  const iter = parseInt(parts[2], 10);
  if (!Number.isFinite(iter)) return false;
  return iter < PBKDF2_ITERATIONS;
}

/**
 * Verify a password against a stored hash.
 *
 * @returns `true` if the password matches, `'wrong_password'` if it doesn't,
 *          or `'needs_reset'` if the stored hash is a legacy format that
 *          requires the user to reset their password.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<true | 'wrong_password' | 'needs_reset'> {
  if (storedHash.startsWith('$PBKDF2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 5) return 'wrong_password';
    const iterations = parseInt(parts[2], 10);
    const salt = parts[3];
    const hash = parts[4];
    if (isNaN(iterations) || !salt || !hash) return 'wrong_password';
    const computed = await pbkdf2Hash(password, salt, iterations);
    return timeSafeEqual(hash, computed) ? true : 'wrong_password';
  }
  // Legacy hash formats — password verification not possible, force reset
  if (storedHash.startsWith('$SHA256$') ||
      storedHash.startsWith('$PHPASS$') ||
      storedHash.startsWith('$MD5$') ||
      storedHash.startsWith('$LEGACY$')) {
    return 'needs_reset';
  }
  return 'wrong_password';
}

/**
 * Generate auth token for cookie
 */
export async function generateAuthToken(uid: number, authCode: string, secret: string): Promise<string> {
  const payload = `${uid}:${authCode}`;
  const hash = await sha256(secret + payload);
  return `${uid}:${hash}`;
}

/**
 * Validate auth token from cookie
 */
export async function validateAuthToken(
  token: string,
  secret: string,
  db: Database
): Promise<{ uid: number; user: typeof schema.users.$inferSelect } | null> {
  const parts = token.split(':');
  if (parts.length !== 2) return null;

  const uid = parseInt(parts[0], 10);
  const hash = parts[1];

  if (isNaN(uid)) return null;

  const user = await db.query.users.findFirst({
    where: eq(schema.users.uid, uid),
  });

  if (!user || !user.authCode) return null;

  // Reject reset tokens during normal auth — they can't be valid sessions
  if (user.authCode.startsWith('reset:')) return null;

  const expected = await sha256(secret + `${uid}:${user.authCode}`);
  if (!timeSafeEqual(hash, expected)) return null;

  return { uid, user };
}

/**
 * Generate a CSRF security token (matches Typecho's Security widget),
 * salted with the current 1-hour bucket so tokens auto-rotate. Validation
 * accepts the current bucket plus the previous bucket to absorb cached HTML
 * straddling the boundary, capping useful lifetime at ~2 hours.
 */
const CSRF_BUCKET_SECONDS = 3600;

function currentCsrfBucket(now = Date.now()): number {
  return Math.floor(now / 1000 / CSRF_BUCKET_SECONDS);
}

export async function generateSecurityToken(secret: string, authCode: string, uid: number, bucket?: number): Promise<string> {
  const b = bucket ?? currentCsrfBucket();
  return await sha256(`${secret}${authCode}${uid}|${b}`);
}

/**
 * Validate CSRF token (accepts current or previous bucket).
 */
export async function validateSecurityToken(
  token: string,
  secret: string,
  authCode: string,
  uid: number,
  now = Date.now(),
): Promise<boolean> {
  const bucket = currentCsrfBucket(now);
  const expectedCurrent = await generateSecurityToken(secret, authCode, uid, bucket);
  if (timeSafeEqual(token, expectedCurrent)) return true;
  const expectedPrev = await generateSecurityToken(secret, authCode, uid, bucket - 1);
  return timeSafeEqual(token, expectedPrev);
}

/**
 * Validate an admin CSRF token from a request and return an error Response
 * if invalid, or null if valid. Handles token extraction from FormData (_ field),
 * query string (_ param), or JSON body (_ field).
 *
 * Use this after auth validation in admin API endpoints that perform state changes.
 */
export async function requireAdminCSRF(
  request: Request,
  secret: string,
  authCode: string,
  uid: number,
): Promise<Response | null> {
  const token = await extractAdminCSRFToken(request);
  if (!token) {
    return new Response('CSRF validation failed', { status: 403 });
  }
  const valid = await validateSecurityToken(token, secret, authCode, uid);
  if (!valid) {
    return new Response('CSRF validation failed', { status: 403 });
  }
  return null;
}

/**
 * Extract admin CSRF token from request.
 * Priority:
 *   1. X-CSRF-Token header (G8-3) — works for any method/content-type
 *      and avoids re-parsing the body. Preferred for fetch()/JSON clients.
 *   2. POST form data `_` field (legacy server-rendered form posts).
 *   3. POST JSON body `_` field.
 *   4. Query string `_` param (state-changing GETs are rare; covered for
 *      legacy callers).
 */
async function extractAdminCSRFToken(request: Request): Promise<string | null> {
  // 1. Header takes priority — covers fetch/AJAX clients without a body.
  const headerToken = request.headers.get('x-csrf-token');
  if (headerToken) return headerToken;

  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // POST with FormData → read from body
  if (method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') ||
        contentType.includes('multipart/form-data')) {
      try {
        const cloned = request.clone();
        const formData = await cloned.formData();
        const token = formData.get('_')?.toString();
        if (token) return token;
      } catch { /* ignore parse errors */ }
    }
    if (contentType.includes('application/json')) {
      try {
        const cloned = request.clone();
        const body = await cloned.json() as Record<string, unknown>;
        if (body._) return String(body._);
      } catch { /* ignore parse errors */ }
    }
  }

  // Fallback: query string
  const queryToken = url.searchParams.get('_');
  if (queryToken) return queryToken;

  return null;
}

/**
 * Generate a comment-form CSRF token bound to the target content ID.
 * Token = sha256(secret + '&cid=' + cid). Same-page cached HTML is fine
 * because the token depends only on the cid the form targets.
 */
export async function generateCommentToken(secret: string, cid: number): Promise<string> {
  return await sha256(`${secret}&cid=${cid}`);
}

/**
 * Validate a comment form CSRF token. Rejects if it doesn't match the
 * cid-bound expected value — no referer fallback, so an attacker cannot
 * reuse a token issued for /archives/1/ to post on /archives/2/.
 */
export async function validateCommentToken(
  token: string,
  secret: string,
  cid: number,
): Promise<boolean> {
  const expected = await generateCommentToken(secret, cid);
  return timeSafeEqual(token, expected);
}

/**
 * Issue a signed capability for viewing a newly submitted non-public comment.
 * A comment id alone is predictable and must never grant that access.
 */
export async function generateUnapprovedCommentToken(
  secret: string,
  cid: number,
  coid: number,
): Promise<string> {
  const payload = `${cid}:${coid}`;
  return `${payload}:${await sha256(`${secret}&unapproved-comment=${payload}`)}`;
}

/** Return the comment id only when a viewer capability is valid for this post. */
export async function validateUnapprovedCommentToken(
  token: string | null | undefined,
  secret: string,
  cid: number,
): Promise<number | null> {
  if (!token) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    return null;
  }

  const [tokenCid, tokenCoid, hash, ...rest] = decoded.split(':');
  if (rest.length > 0 || !/^\d+$/.test(tokenCid) || !/^\d+$/.test(tokenCoid) || !/^[a-f0-9]{64}$/.test(hash)) {
    return null;
  }

  const parsedCid = Number(tokenCid);
  const coid = Number(tokenCoid);
  if (!Number.isSafeInteger(parsedCid) || !Number.isSafeInteger(coid) || parsedCid !== cid || coid <= 0) {
    return null;
  }

  const expected = await generateUnapprovedCommentToken(secret, cid, coid);
  return timeSafeEqual(decoded, expected) ? coid : null;
}

// ---- Utilities ----

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns false if strings differ in length (without leaking which bytes differ).
 */
export function timeSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  // Constant-time comparison: XOR all bytes and accumulate differences
  // This avoids short-circuit evaluation that leaks timing information
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

async function sha256(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a hex-encoded hash using PBKDF2 with SHA-256.
 */
async function pbkdf2Hash(password: string, salt: string, iterations: number): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const hashArray = Array.from(new Uint8Array(derivedBits));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a cryptographically random salt of the given length (in bytes),
 * returned as a hex-encoded string.
 */
function generateSalt(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a cryptographically random alphanumeric string of the given length.
 * Uses rejection sampling to avoid modulo bias.
 */
export function generateRandomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const charsLen = chars.length; // 62
  // Largest multiple of charsLen that fits in a byte (252 = 62 * 4)
  const limit = 256 - (256 % charsLen);
  const result: string[] = [];
  while (result.length < length) {
    const batch = new Uint8Array(length - result.length);
    crypto.getRandomValues(batch);
    for (const b of batch) {
      if (result.length >= length) break;
      if (b < limit) {
        result.push(chars[b % charsLen]);
      }
    }
  }
  return result.join('');
}

// ---- Cookie helpers ----

const AUTH_COOKIE_NAME = '__typecho_uid';
const AUTH_CODE_COOKIE_NAME = '__typecho_authCode';

/** Read one cookie without coupling public request features to auth cookies. */
export function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(';')) {
    const [key, ...values] = segment.trim().split('=');
    if (key === name) return values.join('=') || null;
  }
  return null;
}

/**
 * Decide whether to emit the `Secure` cookie attribute. Production deploys
 * always run on HTTPS via Cloudflare, but `pnpm run dev` exposes the worker
 * over plain http://localhost. Marking cookies Secure on http drops them.
 */
export function shouldUseSecureCookie(request?: Request): boolean {
  if (!request) return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

export function getAuthCookies(cookieHeader: string | null): { token: string | null; uid: string | null; code: string | null } {
  const uid = getCookieValue(cookieHeader, AUTH_COOKIE_NAME);
  const code = getCookieValue(cookieHeader, AUTH_CODE_COOKIE_NAME);
  if (uid && code) {
    return { token: `${uid}:${code}`, uid, code };
  }
  return { token: null, uid: null, code: null };
}

/**
 * Lightweight check used by the edge cache layer: returns true only when
 * both auth cookies are present and look syntactically valid (uid is a
 * number, code is non-empty). substring matching against the cookie header
 * is unsafe because attackers can name unrelated cookies similarly and
 * stale cookies linger after logout.
 */
export function hasAuthCookies(cookieHeader: string | null): boolean {
  const { uid, code } = getAuthCookies(cookieHeader);
  if (!uid || !code) return false;
  return /^\d+$/.test(uid) && code.length > 0;
}

export function setAuthCookieHeaders(uid: number, hash: string, maxAge = 30 * 24 * 3600, request?: Request): string[] {
  const secureFlag = shouldUseSecureCookie(request) ? '; Secure' : '';
  const base = `Path=/; HttpOnly${secureFlag}; SameSite=Lax`;
  const opts = maxAge > 0 ? `${base}; Max-Age=${maxAge}` : base;
  return [
    `${AUTH_COOKIE_NAME}=${uid}; ${opts}`,
    `${AUTH_CODE_COOKIE_NAME}=${hash}; ${opts}`,
  ];
}

export function clearAuthCookieHeaders(request?: Request): string[] {
  const secureFlag = shouldUseSecureCookie(request) ? '; Secure' : '';
  const opts = `Path=/; HttpOnly${secureFlag}; SameSite=Lax; Max-Age=0`;
  return [
    `${AUTH_COOKIE_NAME}=; ${opts}`,
    `${AUTH_CODE_COOKIE_NAME}=; ${opts}`,
  ];
}

// ── Password reset tokens ─────────────────────────────────────────────

const RESET_TOKEN_PREFIX = 'reset:';
export const RESET_TOKEN_EXPIRY_SEC = 3600;

export function generateResetToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${RESET_TOKEN_PREFIX}${hex}`;
}

export async function hashResetToken(token: string): Promise<string> {
  return sha256(token);
}

export interface ResetToken {
  valid: boolean;
  uid?: number;
  error?: 'expired' | 'malformed' | 'consumed';
}

export async function parseResetToken(
  token: string,
  db: Database,
  now = Math.floor(Date.now() / 1000),
): Promise<ResetToken> {
  if (!token.startsWith(RESET_TOKEN_PREFIX)) return { valid: false, error: 'malformed' };
  const body = token.slice(RESET_TOKEN_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(body)) return { valid: false, error: 'malformed' };

  const tokenHash = await hashResetToken(token);
  const pending = await db.query.passwordResetRequests.findFirst({
    where: eq(schema.passwordResetRequests.tokenHash, tokenHash),
    columns: { uid: true, expiresAt: true },
  });
  if (!pending?.uid || !pending.expiresAt) return { valid: false, error: 'consumed' };
  if (pending.expiresAt < now) return { valid: false, error: 'expired' };

  return { valid: true, uid: pending.uid };
}
