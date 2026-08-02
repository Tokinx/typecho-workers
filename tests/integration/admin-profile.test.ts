/**
 * Integration tests for POST /api/admin/profile
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';
import { generateAuthToken, hashPassword, validateAuthToken } from '@/lib/auth';
import { and, eq } from 'drizzle-orm';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST } from '@/pages/api/admin/profile';

const SECRET = 'test-secret-p';
const AUTH_CODE = 'authcodeprof';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('POST /api/admin/profile', () => {
  it('returns 401 without auth cookie', async () => {
    const formData = new URLSearchParams({ screenName: 'Test', mail: 'test@example.com' });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://example.com' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 when mail is empty', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({ screenName: 'New Name' });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid email format', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({ mail: 'not-an-email' });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('updates screenName and mail successfully', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      screenName: 'Updated Admin',
      mail: 'newadmin@example.com',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const user = await testDb.query.users.findFirst();
    expect(user!.screenName).toBe('Updated Admin');
    expect(user!.mail).toBe('newadmin@example.com');
  });

  it('updates password when provided', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      do: 'password',
      mail: 'admin@example.com',
      password: 'newpassword123',
      passwordConfirm: 'newpassword123',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const user = await testDb.query.users.findFirst();
    expect(user!.password).not.toBeNull();
    expect(user!.password).toContain('$PBKDF2$');
  });

  it('rejects password change when confirmation does not match', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      do: 'password',
      mail: 'admin@example.com',
      password: 'newpassword123',
      passwordConfirm: 'different',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('rejects short password', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      do: 'password',
      mail: 'admin@example.com',
      password: '12345',
      passwordConfirm: '12345',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('stores contributor writing settings as user options', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams([
      ['do', 'options'],
      ['markdown', '0'],
      ['xmlrpcMarkdown', '1'],
      ['autoSave', '1'],
      ['defaultAllow', 'comment'],
      ['defaultAllow', 'feed'],
    ]);
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const rows = await testDb.select().from(schema.options).where(eq(schema.options.user, 1));
    expect(Object.fromEntries(rows.map((row) => [row.name, row.value]))).toMatchObject({
      markdown: '0',
      xmlrpcMarkdown: '1',
      autoSave: '1',
      defaultAllowComment: '1',
      defaultAllowPing: '0',
      defaultAllowFeed: '1',
    });
  });

  it('accepts Typecho array-style default permission fields', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams([
      ['do', 'options'],
      ['markdown', '1'],
      ['defaultAllow[]', 'ping'],
    ]);
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const rows = await testDb.select().from(schema.options).where(eq(schema.options.user, 1));
    expect(Object.fromEntries(rows.map((row) => [row.name, row.value]))).toMatchObject({
      markdown: '1',
      defaultAllowComment: '0',
      defaultAllowPing: '1',
      defaultAllowFeed: '0',
    });
  });

  it('forbids subscribers from changing contributor writing settings', async () => {
    await testDb.update(schema.users).set({ group: 'subscriber' }).where(eq(schema.users.uid, 1));
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({ do: 'options', markdown: '0' });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
    expect(await testDb.query.options.findFirst({
      where: and(eq(schema.options.name, 'markdown'), eq(schema.options.user, 1)),
    })).toBeUndefined();
  });

  it('rotates existing sessions when changing the password and refreshes this browser session', async () => {
    const oldToken = await generateAuthToken(1, AUTH_CODE, SECRET);
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      do: 'password',
      password: 'newpassword123',
      passwordConfirm: 'newpassword123',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });

    const res = await POST({ request: req, locals: {} } as any);
    const user = await testDb.query.users.findFirst();
    expect(res.status).toBe(302);
    expect(user!.authCode).not.toBe(AUTH_CODE);
    expect(await validateAuthToken(oldToken, SECRET, testDb as any)).toBeNull();
    expect(res.headers.get('set-cookie')).toContain('__typecho_authCode=');
  });

  it('updates url field', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      mail: 'admin@example.com',
      url: 'https://myblog.example.com',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const user = await testDb.query.users.findFirst();
    expect(user!.url).toBe('https://myblog.example.com/');
  });

  it('rejects invalid url', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      mail: 'admin@example.com',
      url: 'javascript:alert(1)',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });
});
