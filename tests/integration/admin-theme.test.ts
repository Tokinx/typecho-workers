/**
 * Integration tests for POST /api/admin/theme
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';
import { registerPlugin } from '@/lib/plugin';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST } from '@/pages/api/admin/theme';
import { GET as GET_CONFIG, POST as POST_CONFIG } from '@/pages/api/admin/theme-config';

const SECRET = 'test-secret-th';
const AUTH_CODE = 'authcodetheme';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('POST /api/admin/theme', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'typecho-theme-warm' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 when no theme specified', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({}),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent theme', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ theme: 'nonexistent-theme' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed JSON', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: 'not json',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('reads the active theme appearance settings', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/theme-config', {
      headers: { cookie },
    });
    const res = await GET_CONFIG({ request: req, url: new URL(req.url) } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.theme).toBe('typecho-theme-warm');
    expect(body.fields.commentComponentLoadMode.type).toBe('select');
    expect(body.values.commentInitialLoadMode).toBe('manual');
  });

  it('saves only declared active theme appearance settings', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/theme-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({
        settings: {
          githubUrl: 'https://github.com/example',
          commentComponentLoadMode: 'dwell',
          imageOptimizeParams: '?quality=80&format=auto',
          thumbOptimizeParams: '?quality=80&width=500&format=auto',
          unexpected: 'discard me',
        },
      }),
    });
    const res = await POST_CONFIG({ request: req, locals: {} } as any);
    expect(res.status).toBe(200);
    const saved = await testDb.query.options.findFirst({
      where: (options, { eq }) => eq(options.name, 'theme:typecho-theme-warm'),
    });
    expect(JSON.parse(saved?.value || '{}')).toMatchObject({
      githubUrl: 'https://github.com/example',
      commentComponentLoadMode: 'dwell',
      commentInitialLoadMode: 'manual',
      continuousLoadMode: 'manual',
      imageOptimizeParams: '?quality=80&format=auto',
      thumbOptimizeParams: '?quality=80&width=500&format=auto',
    });
    expect(JSON.parse(saved?.value || '{}')).not.toHaveProperty('unexpected');
  });
});
