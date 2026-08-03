/**
 * Integration tests for POST /api/admin/meta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST, GET } from '@/pages/api/admin/meta';

const SECRET = 'test-secret-m';
const AUTH_CODE = 'authcodemeta';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

function makeAdminReq(path: string, formFields: Record<string, string | string[]>, cookie: string): Request {
  const formData = new URLSearchParams();
  for (const [name, value] of Object.entries(formFields)) {
    for (const item of Array.isArray(value) ? value : [value]) formData.append(name, item);
  }
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
    body: formData.toString(),
  });
}

async function insertCategory(values: Partial<typeof schema.metas.$inferInsert> & { name: string; slug: string }) {
  const [category] = await testDb.insert(schema.metas).values({
    type: 'category',
    parent: 0,
    order: 0,
    count: 0,
    ...values,
  }).returning();
  return category;
}

describe('POST /api/admin/meta', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/meta?action=create&type=category', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=Test',
    });
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('creates a new category', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=category', { name: 'Technology' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const meta = await testDb.query.metas.findFirst({
      where: (t, { eq }) => eq(t.name, 'Technology'),
    });
    expect(meta).not.toBeNull();
    expect(meta!.type).toBe('category');
    expect(meta!.slug).toBe('technology');
  });

  it('creates a new tag', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=tag', { name: 'JavaScript' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const meta = await testDb.query.metas.findFirst({
      where: (t, { eq }) => eq(t.name, 'JavaScript'),
    });
    expect(meta).not.toBeNull();
    expect(meta!.type).toBe('tag');
  });

  it('rejects create with empty name', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=category', { name: '' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(400);
  });

  it('rejects unsupported meta type writes', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=link', { name: 'Bad Type' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(400);
  });

  it('updates an existing meta', async () => {
    await testDb.insert(schema.metas).values({ name: 'Old', slug: 'old', type: 'category' });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta', { action: 'update', type: 'category', mid: '1', name: 'Updated' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const meta = await testDb.query.metas.findFirst({
      where: (t, { eq }) => eq(t.mid, 1),
    });
    expect(meta!.name).toBe('Updated');
  });

  it('deletes a meta and its relationships', async () => {
    await testDb.insert(schema.metas).values({ name: 'Temp', slug: 'temp', type: 'tag' });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta', { action: 'delete', type: 'tag', mid: '1' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const meta = await testDb.query.metas.findFirst({
      where: (t, { eq }) => eq(t.mid, 1),
    });
    expect(meta).toBeUndefined();
  });

  it('returns 400 for invalid action', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta', { action: 'invalid', type: 'category' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(400);
  });

  it('redirects to manage-categories for categories', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=category', { name: 'Cat' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/manage-categories');
  });

  it('redirects to manage-tags for tags', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=tag', { name: 'Tag' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/manage-tags');
  });
});

describe('POST /api/admin/meta category hierarchy and bulk actions', () => {
  it('creates a child category and returns to its parent list', async () => {
    const parent = await insertCategory({ name: 'Parent', slug: 'parent', order: 4 });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=category', {
      name: 'Child', parent: String(parent.mid),
    }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/manage-categories?parent=${parent.mid}`);
    const child = await testDb.query.metas.findFirst({
      where: (table, { eq }) => eq(table.name, 'Child'),
    });
    expect(child?.parent).toBe(parent.mid);
    expect(child?.order).toBe(1);
  });

  it('rejects missing parents and hierarchy cycles when updating a category', async () => {
    const root = await insertCategory({ name: 'Root', slug: 'root' });
    const child = await insertCategory({ name: 'Child', slug: 'child', parent: root.mid });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);

    const missingParent = makeAdminReq('/api/admin/meta', {
      action: 'update', type: 'category', mid: String(child.mid), name: 'Child', parent: '999',
    }, cookie);
    const missingParentRes = await POST({ request: missingParent, locals: {}, url: new URL(missingParent.url) } as any);
    expect(missingParentRes.status).toBe(400);

    const cycle = makeAdminReq('/api/admin/meta', {
      action: 'update', type: 'category', mid: String(root.mid), name: 'Root', parent: String(child.mid),
    }, cookie);
    const cycleRes = await POST({ request: cycle, locals: {}, url: new URL(cycle.url) } as any);
    expect(cycleRes.status).toBe(400);
    const unchangedRoot = await testDb.query.metas.findFirst({
      where: (table, { eq }) => eq(table.mid, root.mid),
    });
    expect(unchangedRoot?.parent).toBe(0);
  });

  it('sorts only the complete, direct set of categories', async () => {
    const first = await insertCategory({ name: 'First', slug: 'first', order: 1 });
    const second = await insertCategory({ name: 'Second', slug: 'second', order: 2 });
    const tag = await testDb.insert(schema.metas).values({ name: 'Tag', slug: 'tag', type: 'tag' }).returning();
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);

    const sort = makeAdminReq('/api/admin/meta?action=sort&type=category', {
      'mid[]': [String(second.mid), String(first.mid)], parent: '0',
    }, cookie);
    const sortRes = await POST({ request: sort, locals: {}, url: new URL(sort.url) } as any);
    expect(sortRes.status).toBe(200);
    await expect(sortRes.json()).resolves.toEqual({ success: 1, message: '分类排序已经完成' });
    const firstAfterSort = await testDb.query.metas.findFirst({ where: (table, { eq }) => eq(table.mid, first.mid) });
    const secondAfterSort = await testDb.query.metas.findFirst({ where: (table, { eq }) => eq(table.mid, second.mid) });
    expect(firstAfterSort?.order).toBe(2);
    expect(secondAfterSort?.order).toBe(1);

    for (const fields of [
      { 'mid[]': [String(first.mid), String(first.mid)], parent: '0' },
      { 'mid[]': [String(first.mid), String(second.mid)], parent: String(first.mid) },
      { 'mid[]': [String(tag[0].mid)], parent: '0' },
    ]) {
      const invalid = makeAdminReq('/api/admin/meta?action=sort&type=category', fields, cookie);
      const invalidRes = await POST({ request: invalid, locals: {}, url: new URL(invalid.url) } as any);
      expect(invalidRes.status).toBe(400);
    }
  });

  it('merges category relationships, deduplicates posts, reparents children, and refreshes the target count', async () => {
    const target = await insertCategory({ name: 'Target', slug: 'target' });
    const sourceA = await insertCategory({ name: 'Source A', slug: 'source-a' });
    const sourceB = await insertCategory({ name: 'Source B', slug: 'source-b' });
    const child = await insertCategory({ name: 'Child', slug: 'child', parent: sourceA.mid });
    await testDb.insert(schema.contents).values([
      { title: 'One', slug: 'one', type: 'post', status: 'publish' },
      { title: 'Two', slug: 'two', type: 'post', status: 'publish' },
    ]);
    const contents = await testDb.select().from(schema.contents).orderBy(schema.contents.cid);
    await testDb.insert(schema.relationships).values([
      { cid: contents[0].cid, mid: sourceA.mid },
      { cid: contents[0].cid, mid: sourceB.mid },
      { cid: contents[1].cid, mid: sourceA.mid },
      { cid: contents[1].cid, mid: target.mid },
    ]);

    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const merge = makeAdminReq('/api/admin/meta?action=merge&type=category', {
      'mid[]': [String(sourceA.mid), String(sourceB.mid)], merge: String(target.mid),
    }, cookie);
    const res = await POST({ request: merge, locals: {}, url: new URL(merge.url) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/manage-categories');

    const [targetAfterMerge, childAfterMerge] = await Promise.all([
      testDb.query.metas.findFirst({ where: (table, { eq }) => eq(table.mid, target.mid) }),
      testDb.query.metas.findFirst({ where: (table, { eq }) => eq(table.mid, child.mid) }),
    ]);
    expect(targetAfterMerge?.count).toBe(2);
    expect(childAfterMerge?.parent).toBe(target.mid);
    expect(await testDb.query.metas.findFirst({ where: (table, { eq }) => eq(table.mid, sourceA.mid) })).toBeUndefined();
    expect(await testDb.query.metas.findFirst({ where: (table, { eq }) => eq(table.mid, sourceB.mid) })).toBeUndefined();
    const targetRelationships = (await testDb.select().from(schema.relationships))
      .filter(relationship => relationship.mid === target.mid);
    expect(targetRelationships.map(relationship => relationship.cid).sort()).toEqual(contents.map(content => content.cid).sort());
  });

  it('rejects merging a default category or into a selected category descendant', async () => {
    const source = await insertCategory({ name: 'Source', slug: 'source' });
    const target = await insertCategory({ name: 'Target', slug: 'target' });
    const childTarget = await insertCategory({ name: 'Child target', slug: 'child-target', parent: source.mid });
    await testDb.insert(schema.options).values({ name: 'defaultCategory', user: 0, value: String(source.mid) });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);

    const defaultMerge = makeAdminReq('/api/admin/meta?action=merge&type=category', {
      'mid[]': [String(source.mid)], merge: String(target.mid),
    }, cookie);
    const defaultMergeRes = await POST({ request: defaultMerge, locals: {}, url: new URL(defaultMerge.url) } as any);
    expect(defaultMergeRes.status).toBe(400);

    await testDb.delete(schema.options).where(eq(schema.options.name, 'defaultCategory'));
    const descendantMerge = makeAdminReq('/api/admin/meta?action=merge&type=category', {
      'mid[]': [String(source.mid)], merge: String(childTarget.mid),
    }, cookie);
    const descendantMergeRes = await POST({ request: descendantMerge, locals: {}, url: new URL(descendantMerge.url) } as any);
    expect(descendantMergeRes.status).toBe(400);
  });
});

describe('POST /api/admin/meta tag merge', () => {
  it('merges tag relationships, deduplicates posts, and refreshes the target count', async () => {
    const [target, sourceA, sourceB] = await testDb.insert(schema.metas).values([
      { name: 'Target', slug: 'target', type: 'tag', count: 0 },
      { name: 'Source A', slug: 'source-a', type: 'tag', count: 0 },
      { name: 'Source B', slug: 'source-b', type: 'tag', count: 0 },
    ]).returning();
    await testDb.insert(schema.contents).values([
      { title: 'One', slug: 'one', type: 'post', status: 'publish' },
      { title: 'Two', slug: 'two', type: 'post', status: 'publish' },
    ]);
    const contents = await testDb.select().from(schema.contents).orderBy(schema.contents.cid);
    await testDb.insert(schema.relationships).values([
      { cid: contents[0].cid, mid: sourceA.mid },
      { cid: contents[0].cid, mid: sourceB.mid },
      { cid: contents[1].cid, mid: sourceA.mid },
      { cid: contents[1].cid, mid: target.mid },
    ]);

    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const merge = makeAdminReq('/api/admin/meta?action=merge&type=tag', {
      'mid[]': [String(sourceA.mid), String(sourceB.mid)], merge: target.name || 'Target',
    }, cookie);
    const res = await POST({ request: merge, locals: {}, url: new URL(merge.url) } as any);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/manage-tags');
    expect(await testDb.query.metas.findFirst({ where: (table, { eq }) => eq(table.mid, sourceA.mid) })).toBeUndefined();
    expect(await testDb.query.metas.findFirst({ where: (table, { eq }) => eq(table.mid, sourceB.mid) })).toBeUndefined();
    const targetAfterMerge = await testDb.query.metas.findFirst({ where: (table, { eq }) => eq(table.mid, target.mid) });
    expect(targetAfterMerge?.count).toBe(2);
    const targetRelationships = (await testDb.select().from(schema.relationships))
      .filter(relationship => relationship.mid === target.mid);
    expect(targetRelationships.map(relationship => relationship.cid).sort()).toEqual(contents.map(content => content.cid).sort());
  });

  it('creates the requested target tag and rejects an invalid source selection', async () => {
    const [source, category] = await testDb.insert(schema.metas).values([
      { name: 'Source', slug: 'source', type: 'tag', count: 0 },
      { name: 'Category', slug: 'category', type: 'category', count: 0 },
    ]).returning();
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);

    const merge = makeAdminReq('/api/admin/meta?action=merge&type=tag', {
      'mid[]': [String(source.mid)], merge: 'Merged',
    }, cookie);
    const mergeRes = await POST({ request: merge, locals: {}, url: new URL(merge.url) } as any);
    expect(mergeRes.status).toBe(302);
    expect(await testDb.query.metas.findFirst({ where: (table, { and, eq }) => and(eq(table.type, 'tag'), eq(table.name, 'Merged')) })).toBeTruthy();

    const invalid = makeAdminReq('/api/admin/meta?action=merge&type=tag', {
      'mid[]': [String(category.mid)], merge: 'Other',
    }, cookie);
    const invalidRes = await POST({ request: invalid, locals: {}, url: new URL(invalid.url) } as any);
    expect(invalidRes.status).toBe(404);
  });
});

describe('GET /api/admin/meta', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/meta');
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns JSON list of categories', async () => {
    await testDb.insert(schema.metas).values({ name: 'Cat1', slug: 'cat1', type: 'category', count: 0 });
    await testDb.insert(schema.metas).values({ name: 'Cat2', slug: 'cat2', type: 'category', count: 5 });

    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/meta', { headers: { cookie } });
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe('Cat1');
    expect(body[1].name).toBe('Cat2');
  });
});
