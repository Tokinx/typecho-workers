/**
 * Integration test for /api/users/logout (G1-1).
 *
 * GET must NOT clear cookies — that closes the CSRF logout vector via
 * <img src=...>. Only POST is allowed to mutate session state.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, disposeTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';
import { validateAuthToken } from '@/lib/auth';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { GET, POST } from '@/pages/api/users/logout';

const SECRET = 'logout-test-secret';
const AUTH_CODE = 'logout-test-auth';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('users/logout endpoint (G1-1)', () => {
  it('GET redirects without clearing cookies', async () => {
    const response = await GET({
      request: new Request('https://example.com/api/users/logout'),
      locals: {},
    } as any);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
    // Critical: no cookie mutation on GET (CSRF defence).
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('POST clears auth cookies', async () => {
    const response = await POST({
      request: new Request('https://example.com/api/users/logout', { method: 'POST' }),
      locals: {},
    } as any);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
    const setCookie = response.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('__typecho_uid=');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('POST rotates authCode so the old token is invalid', async () => {
    const user = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, user!.uid, AUTH_CODE, SECRET);
    const oldToken = (await import('@/lib/auth')).generateAuthToken(user!.uid, AUTH_CODE, SECRET);
    const response = await POST({
      request: new Request('https://example.com/api/users/logout', {
        method: 'POST',
        headers: { cookie, origin: 'https://example.com' },
      }),
      locals: {},
    } as any);

    expect(response.status).toBe(302);
    expect((await testDb.query.users.findFirst())!.authCode).not.toBe(AUTH_CODE);
    expect(await validateAuthToken(await oldToken, SECRET, testDb as any)).toBeNull();
  });

  it('POST omits Secure for plain http (dev mode)', async () => {
    const response = await POST({
      request: new Request('http://localhost:4321/api/users/logout', { method: 'POST' }),
      locals: {},
    } as any);
    expect(response.headers.get('Set-Cookie') || '').not.toContain('Secure');
  });

  it('POST emits Secure for https', async () => {
    const response = await POST({
      request: new Request('https://example.com/api/users/logout', { method: 'POST' }),
      locals: {},
    } as any);
    expect(response.headers.get('Set-Cookie') || '').toContain('Secure');
  });

  it('POST rejects a cross-origin logout form', async () => {
    const response = await POST({
      request: new Request('https://example.com/api/users/logout', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
      }),
      locals: {},
    } as any);
    expect(response.status).toBe(403);
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });
});
