import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST } from '@/pages/api/admin/editor-size';

const secret = 'editor-size-secret';
const authCode = 'editor-size-auth-code';

async function requestFor(size: string, cookie: string) {
  return new Request('https://example.com/api/admin/editor-size', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: 'https://example.com',
    },
    body: new URLSearchParams({ size }).toString(),
  });
}

describe('POST /api/admin/editor-size', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedAdmin(testDb, { secret, authCode, group: 'contributor' });
    await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
  });

  it('stores a valid editor height on the authenticated user rather than globally', async () => {
    const user = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, user!.uid, authCode, secret);
    const response = await POST({ request: await requestFor('480', cookie) } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ size: 480 });
    const saved = await testDb.query.options.findFirst({
      where: (table, { and, eq }) => and(eq(table.name, 'editorSize'), eq(table.user, user!.uid)),
    });
    expect(saved?.value).toBe('480');
    expect(await testDb.query.options.findFirst({
      where: (table, { and, eq }) => and(eq(table.name, 'editorSize'), eq(table.user, 0)),
    })).toBeUndefined();
  });

  it('rejects heights outside the supported range', async () => {
    const user = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, user!.uid, authCode, secret);
    const response = await POST({ request: await requestFor('99', cookie) } as any);

    expect(response.status).toBe(400);
    expect(await testDb.query.options.findFirst({
      where: (table, { eq }) => eq(table.name, 'editorSize'),
    })).toBeUndefined();
  });
});
