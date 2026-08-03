import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { generateSecurityToken } from '@/lib/auth';
import { createTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { GET, POST } from '@/pages/api/admin/comment-edit';

const SECRET = 'comment-edit-secret';
const AUTH_CODE = 'comment-edit-auth-code';
const ORIGIN = 'https://example.com';

async function seedPost(authorId: number, commentsNum = 1) {
  const [post] = await testDb.insert(schema.contents).values({
    title: '评论文章',
    slug: 'comment-edit-post',
    type: 'post',
    status: 'publish',
    authorId,
    commentsNum,
    created: 100,
  }).returning();
  return post;
}

async function seedComment(
  cid: number,
  ownerId: number,
  overrides: Partial<typeof schema.comments.$inferInsert> = {},
) {
  const [comment] = await testDb.insert(schema.comments).values({
    cid,
    ownerId,
    author: '访客',
    mail: 'visitor@example.com',
    url: 'https://visitor.example.com/',
    text: '原始评论',
    type: 'comment',
    status: 'approved',
    created: 200,
    ...overrides,
  }).returning();
  return comment;
}

async function requestFor(
  body: Record<string, string>,
  cookie: string,
  options: { origin?: string; csrf?: boolean } = {},
) {
  const csrf = options.csrf === false ? '' : await generateSecurityToken(SECRET, AUTH_CODE, 1);
  const form = new URLSearchParams(body);
  if (csrf) form.set('_', csrf);
  return new Request(`${ORIGIN}/api/admin/comment-edit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: options.origin ?? ORIGIN,
      referer: `${options.origin ?? ORIGIN}/admin/manage-comments`,
    },
    body: form.toString(),
  });
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: ORIGIN });
});

describe('/api/admin/comment-edit', () => {
  it('returns the complete editable comment only to an authorized moderator', async () => {
    const admin = await testDb.query.users.findFirst();
    const post = await seedPost(admin!.uid);
    const comment = await seedComment(post.cid, admin!.uid, { text: 'x'.repeat(800) });
    const cookie = await makeAuthCookie(testDb, admin!.uid, AUTH_CODE, SECRET);

    const response = await GET({
      request: new Request(`${ORIGIN}/api/admin/comment-edit?coid=${comment.coid}`, { headers: { cookie } }),
      locals: {},
    } as any);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.comment.text).toHaveLength(800);
    expect(body.comment.coid).toBe(comment.coid);
  });

  it('returns sanitized HTML for comment-manager rendering', async () => {
    const admin = await testDb.query.users.findFirst();
    const post = await seedPost(admin!.uid);
    const comment = await seedComment(post.cid, admin!.uid, {
      text: '<strong>允许</strong><script>alert(1)</script>',
    });
    await testDb.insert(schema.options).values({
      name: 'commentsHTMLTagAllowed', user: 0, value: '<strong>',
    });
    const cookie = await makeAuthCookie(testDb, admin!.uid, AUTH_CODE, SECRET);

    const response = await GET({
      request: new Request(`${ORIGIN}/api/admin/comment-edit?coid=${comment.coid}`, { headers: { cookie } }),
      locals: {},
    } as any);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.comment.html).toContain('<strong>允许</strong>');
    expect(body.comment.html).not.toContain('<script>');
    expect(body.comment.html).not.toContain('alert(1)');
  });

  it('updates comment author fields and text with Typecho-compatible normalization', async () => {
    const admin = await testDb.query.users.findFirst();
    const post = await seedPost(admin!.uid);
    const comment = await seedComment(post.cid, admin!.uid);
    const cookie = await makeAuthCookie(testDb, admin!.uid, AUTH_CODE, SECRET);

    const response = await POST({
      request: await requestFor({
        action: 'edit',
        coid: String(comment.coid),
        author: '<b>Alice</b>',
        mail: 'alice@example.com',
        url: 'https://alice.example.com',
        text: '更新后的评论',
      }, cookie),
      locals: {},
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      comment: expect.objectContaining({ author: 'Alice', text: '更新后的评论' }),
    }));
    const saved = await testDb.query.comments.findFirst({ where: eq(schema.comments.coid, comment.coid) });
    expect(saved).toMatchObject({
      author: 'Alice',
      mail: 'alice@example.com',
      url: 'https://alice.example.com/',
      text: '更新后的评论',
    });
  });

  it('rejects a missing CSRF token and cross-origin comment edits', async () => {
    const admin = await testDb.query.users.findFirst();
    const post = await seedPost(admin!.uid);
    const comment = await seedComment(post.cid, admin!.uid);
    const cookie = await makeAuthCookie(testDb, admin!.uid, AUTH_CODE, SECRET);
    const edit = { action: 'edit', coid: String(comment.coid), author: 'Alice', mail: '', url: '', text: 'changed' };

    const missingCsrf = await POST({ request: await requestFor(edit, cookie, { csrf: false }), locals: {} } as any);
    expect(missingCsrf.status).toBe(403);

    const crossOrigin = await POST({ request: await requestFor(edit, cookie, { origin: 'https://attacker.example' }), locals: {} } as any);
    expect(crossOrigin.status).toBe(403);

    const unchanged = await testDb.query.comments.findFirst({ where: eq(schema.comments.coid, comment.coid) });
    expect(unchanged?.text).toBe('原始评论');
  });

  it('rejects invalid edited contact data before persisting it', async () => {
    const admin = await testDb.query.users.findFirst();
    const post = await seedPost(admin!.uid);
    const comment = await seedComment(post.cid, admin!.uid);
    const cookie = await makeAuthCookie(testDb, admin!.uid, AUTH_CODE, SECRET);

    const response = await POST({
      request: await requestFor({
        action: 'edit', coid: String(comment.coid), author: 'Alice', mail: 'not-an-email', url: '', text: 'changed',
      }, cookie),
      locals: {},
    } as any);

    expect(response.status).toBe(400);
    const unchanged = await testDb.query.comments.findFirst({ where: eq(schema.comments.coid, comment.coid) });
    expect(unchanged?.text).toBe('原始评论');
  });

  it('only lets the current post author edit a comment', async () => {
    const admin = await testDb.query.users.findFirst();
    const post = await seedPost(admin!.uid);
    const comment = await seedComment(post.cid, admin!.uid);
    await testDb.insert(schema.users).values({
      name: 'contributor', mail: 'contributor@example.com', group: 'contributor', authCode: 'other-auth-code',
    });
    const contributor = await testDb.query.users.findFirst({ where: eq(schema.users.name, 'contributor') });
    const cookie = await makeAuthCookie(testDb, contributor!.uid, 'other-auth-code', SECRET);
    const csrf = await generateSecurityToken(SECRET, 'other-auth-code', contributor!.uid);
    const form = new URLSearchParams({ action: 'edit', coid: String(comment.coid), author: 'Nope', mail: '', url: '', text: 'changed', _: csrf });

    const response = await POST({
      request: new Request(`${ORIGIN}/api/admin/comment-edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: ORIGIN, referer: `${ORIGIN}/admin/manage-comments` },
        body: form.toString(),
      }),
      locals: {},
    } as any);

    expect(response.status).toBe(403);
  });

  it('creates an approved child comment and increments the post count on reply', async () => {
    const admin = await testDb.query.users.findFirst();
    const post = await seedPost(admin!.uid, 1);
    const parent = await seedComment(post.cid, admin!.uid);
    const cookie = await makeAuthCookie(testDb, admin!.uid, AUTH_CODE, SECRET);

    const response = await POST({
      request: await requestFor({ action: 'reply', coid: String(parent.coid), text: '后台回复' }, cookie),
      locals: {},
    } as any);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.comment).toMatchObject({
      cid: post.cid,
      author: 'admin',
      text: '后台回复',
      status: 'approved',
      parent: parent.coid,
    });
    const reply = await testDb.query.comments.findFirst({ where: eq(schema.comments.coid, body.comment.coid) });
    expect(reply).toMatchObject({
      authorId: admin!.uid,
      ownerId: admin!.uid,
      parent: parent.coid,
      text: '后台回复',
      status: 'approved',
    });
    const updatedPost = await testDb.query.contents.findFirst({ where: eq(schema.contents.cid, post.cid) });
    expect(updatedPost?.commentsNum).toBe(2);
  });

  it('refuses replies to comments that are not approved normal comments', async () => {
    const admin = await testDb.query.users.findFirst();
    const post = await seedPost(admin!.uid);
    const waiting = await seedComment(post.cid, admin!.uid, { status: 'waiting' });
    const cookie = await makeAuthCookie(testDb, admin!.uid, AUTH_CODE, SECRET);

    const response = await POST({
      request: await requestFor({ action: 'reply', coid: String(waiting.coid), text: '后台回复' }, cookie),
      locals: {},
    } as any);

    expect(response.status).toBe(400);
    expect(await testDb.select().from(schema.comments)).toHaveLength(1);
  });
});
