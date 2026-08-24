/**
 * Integration tests for POST /api/comment
 *
 * Tests the comment submission flow including validation, anti-spam,
 * auth checks, and auto-close enforcement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, makeAuthCookie, randomPassword, type TestDatabase } from '../helpers';
import { generateCommentToken } from '@/lib/auth';
import { resetSlidingWindow } from '@/lib/login-rate-limit';

let testDb: TestDatabase;
const { mockApplyFilter, mockDoHook } = vi.hoisted(() => ({
  mockApplyFilter: vi.fn(async (_ctx: any, _hook: string, data: any) => data),
  mockDoHook: vi.fn(async () => {}),
}));

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

// Mock plugin module to be a no-op in tests
vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
  applyFilter: mockApplyFilter,
  doHook: mockDoHook,
}));

import { POST } from '@/pages/api/comment';

// ---- test helpers -----------------------------------------------------------

async function seedContent(
  db: TestDatabase,
  overrides: Partial<typeof schema.contents.$inferInsert> = {},
) {
  const slug = String(overrides.slug || 'test-post');
  await db.insert(schema.contents).values({
    title: 'Test Post',
    slug,
    created: Math.floor(Date.now() / 1000) - 100,
    type: 'post',
    status: 'publish',
    allowComment: '1',
    ...overrides,
  });
  const row = await db.query.contents.findFirst({ where: (c, { eq }) => eq(c.slug, slug) });
  return row!;
}

async function seedOptions(
  db: TestDatabase,
  opts: Record<string, string> = {},
) {
  const defaults: Record<string, string> = {
    secret: 'test-secret',
    siteUrl: 'https://example.com',
    commentsRequireMail: '0',
    commentsRequireURL: '0',
    commentsPostIntervalEnable: '0',
    commentsRequireModeration: '0',
    commentsWhitelist: '0',
    commentsAutoClose: '0',
    commentsCheckReferer: '0',
    commentsAntiSpam: '0',
    ...opts,
  };
  for (const [name, value] of Object.entries(defaults)) {
    await db.insert(schema.options).values({ name, user: 0, value });
  }
}

function makeCommentRequest(
  formFields: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const body = new URLSearchParams(formFields);
  return new Request('https://example.com/api/comment', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'TestAgent/1.0',
      'origin': 'https://example.com',
      'referer': 'https://example.com/',
      ...headers,
    },
    body: body.toString(),
  });
}

// ---- tests ------------------------------------------------------------------

describe('POST /api/comment', () => {
  beforeEach(async () => {
    resetSlidingWindow();
    testDb = await createTestDb();
    mockApplyFilter.mockImplementation(async (_ctx: any, _hook: string, data: any) => data);
    mockDoHook.mockClear();
  });

  it('returns 400 when cid is missing', async () => {
    await seedOptions(testDb);
    const req = makeCommentRequest({ text: 'Hello' });
    const ctx = { request: req, locals: {} } as any;
    const res = await POST(ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when text is empty', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: '' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 404 when content does not exist', async () => {
    await seedOptions(testDb);
    const req = makeCommentRequest({ cid: '9999', text: 'Hello', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(404);
  });

  it('returns 403 when comments are closed on content', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { allowComment: '0' });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Hi', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('returns 403 when content is password-protected', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { password: randomPassword() });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Hi', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('returns 400 when author is missing for anonymous user', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Hello' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 when mail is required but missing', async () => {
    await seedOptions(testDb, { commentsRequireMail: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Hello', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 302 redirect on successful comment', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Great post!',
      author: 'Alice',
      mail: 'alice@example.com',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/#comment-\d+$/);
  });

  it('returns structured JSON when requested by an API client', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Submitted without a page reload',
      author: 'Alice',
    }, { accept: 'application/json' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toMatchObject({ success: true, status: 'approved' });
    expect(body.location).toMatch(/#comment-\d+$/);
  });

  it('remembers anonymous commenter fields with secure 30-day cookies', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid), text: 'Remember me', author: 'Alice', mail: 'alice@example.com', url: 'https://alice.example.com', remember: '1',
    });
    const res = await POST({ request: req, locals: {} } as any);
    const cookies = res.headers.get('set-cookie') || '';

    expect(res.status).toBe(302);
    expect(cookies).toContain('__typecho_remember_author=Alice;');
    expect(cookies).toContain('__typecho_remember_mail=alice%40example.com;');
    expect(cookies).toContain('__typecho_remember_url=https%3A%2F%2Falice.example.com%2F;');
    expect(cookies).toContain('Max-Age=2592000');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
    expect(cookies).toContain('SameSite=Lax');
  });

  it('clears anonymous commenter cookies when remembering is unchecked', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid), text: 'Forget me', author: 'Alice', mail: 'alice@example.com', remember: '0',
    });
    const res = await POST({ request: req, locals: {} } as any);
    const cookies = res.headers.get('set-cookie') || '';

    expect(cookies).toContain('__typecho_remember_author=;');
    expect(cookies).toContain('__typecho_remember_mail=;');
    expect(cookies).toContain('__typecho_remember_url=;');
    expect(cookies).toContain('Max-Age=0');
  });

  it('does not write anonymous commenter cookies for logged-in users', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const [user] = await testDb.insert(schema.users).values({
      name: 'member', screenName: 'Member', authCode: 'member-auth',
    }).returning();
    const cookie = await makeAuthCookie(testDb, user.uid, 'member-auth', 'test-secret');
    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'Logged in', author: 'Anonymous', remember: '1' },
      { Cookie: cookie },
    );
    const res = await POST({ request: req, locals: {} } as any);
    const cookies = res.headers.get('set-cookie') || '';

    expect(res.status).toBe(302);
    expect(cookies).not.toContain('__typecho_remember_');
  });

  it('returns a JSON error to an API client without changing HTML form errors', async () => {
    await seedOptions(testDb);
    const req = makeCommentRequest({ text: 'Missing cid' }, { accept: 'application/json' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: '评论内容不能为空' });
  });

  it('stores comment with correct IP from CF-Connecting-IP', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'From CF!', author: 'Bob' },
      { 'cf-connecting-ip': '1.2.3.4' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const comment = await testDb.query.comments.findFirst();
    expect(comment?.ip).toBe('1.2.3.4');
  });

  it('stores only first IP from X-Forwarded-For', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'Via proxy!', author: 'Carol' },
      { 'x-forwarded-for': '10.0.0.1, 172.16.0.1, 192.168.1.1' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const comment = await testDb.query.comments.findFirst();
    expect(comment?.ip).toBe('10.0.0.1');
  });

  it('returns 429 when same IP posts too quickly (commentsPostIntervalEnable)', async () => {
    await seedOptions(testDb, {
      commentsPostIntervalEnable: '1',
      commentsPostInterval: '60',  // 60 seconds
    });
    const content = await seedContent(testDb);

    // First comment from the IP succeeds; an immediate second one is rejected
    // by the in-isolate sliding window (no D1 dependency).
    const first = await POST({ request: makeCommentRequest(
      { cid: String(content.cid), text: 'First comment', author: 'Visitor' },
      { 'cf-connecting-ip': '5.5.5.5' },
    ), locals: {} } as any);
    expect(first.status).toBe(302);

    const second = await POST({ request: makeCommentRequest(
      { cid: String(content.cid), text: 'Too fast!', author: 'Visitor' },
      { 'cf-connecting-ip': '5.5.5.5' },
    ), locals: {} } as any);
    expect(second.status).toBe(429);
    await expect(second.text()).resolves.toContain('评论过于频繁');
  });

  it('rate-limits logged-in users on the same post (interval applies to everyone)', async () => {
    await seedOptions(testDb, {
      commentsPostIntervalEnable: '1',
      commentsPostInterval: '60',
    });
    const content = await seedContent(testDb);
    const [user] = await testDb.insert(schema.users).values({
      name: 'member', screenName: 'Member', authCode: 'member-auth',
    }).returning();
    const cookie = await makeAuthCookie(testDb, user.uid, 'member-auth', 'test-secret');

    const first = await POST({ request: makeCommentRequest(
      { cid: String(content.cid), text: 'Logged-in comment', author: 'x' },
      { Cookie: cookie },
    ), locals: {} } as any);
    expect(first.status).toBe(302);

    const second = await POST({ request: makeCommentRequest(
      { cid: String(content.cid), text: 'Again!', author: 'x' },
      { Cookie: cookie },
    ), locals: {} } as any);
    expect(second.status).toBe(429);
  });

  it('enforces commentsAutoClose when article is too old', async () => {
    await seedOptions(testDb, {
      commentsAutoClose: '1',
      commentsPostTimeout: '86400', // 1 day in seconds
    });
    // Content created 2 days ago
    const content = await seedContent(testDb, {
      created: Math.floor(Date.now() / 1000) - 2 * 86400,
    });
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Old post comment',
      author: 'Dave',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('文章发布时间过长');
  });

  it('does not enforce autoClose when article is recent enough', async () => {
    await seedOptions(testDb, {
      commentsAutoClose: '1',
      commentsPostTimeout: '86400', // 1 day in seconds
    });
    // Content created 1 hour ago — should still accept comments
    const content = await seedContent(testDb, {
      created: Math.floor(Date.now() / 1000) - 3600,
    });
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Fresh comment',
      author: 'Eve',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
  });

  it('enforces commentsCheckReferer when enabled', async () => {
    await seedOptions(testDb, {
      commentsCheckReferer: '1',
      siteUrl: 'https://example.com',
    });
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'Spam from external', author: 'Spammer' },
      { referer: 'https://evil.com/page' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects prefix-matched attacker domains when commentsCheckReferer is enabled', async () => {
    await seedOptions(testDb, {
      commentsCheckReferer: '1',
      siteUrl: 'https://example.com',
    });
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'Prefix bypass attempt', author: 'Spammer' },
      { referer: 'https://example.com.evil.test/page' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('marks comment as waiting when commentsRequireModeration is enabled', async () => {
    await seedOptions(testDb, { commentsRequireModeration: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Pending review',
      author: 'Frank',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const comment = await testDb.query.comments.findFirst();
    expect(comment?.status).toBe('waiting');
    expect(res.headers.get('Set-Cookie')).toContain('__typecho_unapproved_comment=');
    expect(res.headers.get('Location')).toContain(`#comment-${comment?.coid}`);
  });

  it('increments commentsNum on approved comment', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Counting!',
      author: 'Grace',
    });
    await POST({ request: req, locals: {} } as any);
    const updated = await testDb.query.contents.findFirst();
    expect(updated?.commentsNum).toBe(1);
  });

  it('does NOT increment commentsNum when comment is waiting', async () => {
    await seedOptions(testDb, { commentsRequireModeration: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Waiting...',
      author: 'Henry',
    });
    await POST({ request: req, locals: {} } as any);
    const updated = await testDb.query.contents.findFirst();
    expect(updated?.commentsNum).toBe(0);
  });

  it('uses the final plugin-filtered status for counts and notifications', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    mockApplyFilter.mockImplementation(async (_ctx: any, hook: string, data: any) => {
      if (hook === 'feedback:comment') return { ...data, status: 'spam' };
      return data;
    });

    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Filtered as spam',
      author: 'Spammer',
    });
    await POST({ request: req, locals: {} } as any);

    const comment = await testDb.query.comments.findFirst();
    const updated = await testDb.query.contents.findFirst();
    expect(comment?.status).toBe('spam');
    expect(updated?.commentsNum).toBe(0);
  });

  it('rejects a cross-origin comment even when referer checking is disabled', async () => {
    await seedOptions(testDb, {
      siteUrl: 'https://example.com',
      commentsCheckReferer: '0',
      commentsAntiSpam: '0',
    });
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'Cross-origin', author: 'Mallory' },
      { origin: 'https://evil.test', referer: 'https://evil.test/form' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  // ── New validation tests (security fixes) ──

  it('returns 400 when comment text exceeds 10000 characters', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const longText = 'x'.repeat(10001);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: longText,
      author: 'Alice',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('过长');
  });

  it('accepts comment text at exactly 10000 characters', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const exactText = 'x'.repeat(10000);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: exactText,
      author: 'Alice',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
  });

  it('returns 400 when email format is invalid for anonymous user', async () => {
    await seedOptions(testDb, { commentsRequireMail: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Hello',
      author: 'Alice',
      mail: 'not-an-email',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('邮箱格式');
  });

  it('accepts valid email format for anonymous user', async () => {
    await seedOptions(testDb, { commentsRequireMail: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Hello',
      author: 'Alice',
      mail: 'alice@example.com',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
  });

  it('rejects unsafe comment author URL protocols', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Hello',
      author: 'Alice',
      url: 'javascript:alert(1)',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('normalizes safe comment author URLs before storing', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Hello',
      author: 'Alice',
      url: 'https://example.org/about',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const comment = await testDb.query.comments.findFirst();
    expect(comment?.url).toBe('https://example.org/about');
  });

  it('rejects a cross-origin referer before redirect construction', async () => {
    await seedOptions(testDb, { siteUrl: 'https://example.com' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      {
        cid: String(content.cid),
        text: 'Hello',
        author: 'Alice',
      },
      { referer: 'https://evil.com/phishing' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects same-host referers on a different protocol', async () => {
    await seedOptions(testDb, { siteUrl: 'https://example.com' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      {
        cid: String(content.cid),
        text: 'Hello',
        author: 'Alice',
      },
      { referer: 'http://example.com/archives/1/' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('uses same-origin referer for redirect when valid', async () => {
    await seedOptions(testDb, { siteUrl: 'https://example.com' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      {
        cid: String(content.cid),
        text: 'Hello',
        author: 'Alice',
      },
      { referer: 'https://example.com/archives/1/' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') || '';
    expect(location).toContain('/archives/1/');
    expect(location).toMatch(/#comment-\d+$/);
  });

  // NEW: Per-article rate limiting test
  it('allows same IP to comment on different articles (rate limit is per-article)', async () => {
    await seedOptions(testDb, {
      commentsPostIntervalEnable: '1',
      commentsPostInterval: '60',  // 60 seconds
    });
    
    // Create two separate articles
    await testDb.insert(schema.contents).values({
      title: 'Post 1',
      slug: 'post-1',
      created: Math.floor(Date.now() / 1000) - 100,
      type: 'post',
      status: 'publish',
      allowComment: '1',
    });
    const post1 = await testDb.query.contents.findFirst({
      where: (contents, { eq }) => eq(contents.slug, 'post-1'),
    });

    await testDb.insert(schema.contents).values({
      title: 'Post 2',
      slug: 'post-2',
      created: Math.floor(Date.now() / 1000) - 100,
      type: 'post',
      status: 'publish',
      allowComment: '1',
    });
    const post2 = await testDb.query.contents.findFirst({
      where: (contents, { eq }) => eq(contents.slug, 'post-2'),
    });

    // Comment on Post 1 from IP 7.7.7.7
    const req1 = makeCommentRequest(
      { cid: String(post1!.cid), text: 'Comment on post 1', author: 'Test' },
      { 'cf-connecting-ip': '7.7.7.7' },
    );
    const res1 = await POST({ request: req1, locals: {} } as any);
    expect(res1.status).toBe(302);

    // Immediately comment on Post 2 from same IP (should succeed since it's a different article)
    const req2 = makeCommentRequest(
      { cid: String(post2!.cid), text: 'Comment on post 2', author: 'Test' },
      { 'cf-connecting-ip': '7.7.7.7' },
    );
    const res2 = await POST({ request: req2, locals: {} } as any);
    expect(res2.status).toBe(302);

    // But immediate follow-up comment on Post 1 should fail (rate limit)
    const req3 = makeCommentRequest(
      { cid: String(post1!.cid), text: 'Another comment on post 1', author: 'Test' },
      { 'cf-connecting-ip': '7.7.7.7' },
    );
    const res3 = await POST({ request: req3, locals: {} } as any);
    expect(res3.status).toBe(429);
  });

  it('rejects comment when commentsAntiSpam is enabled and token is missing', async () => {
    await seedOptions(testDb, { commentsAntiSpam: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Spam?', author: 'Bot' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects comment when commentsAntiSpam is enabled and token is wrong', async () => {
    await seedOptions(testDb, { commentsAntiSpam: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Spam?', author: 'Bot', _: 'wrong-token' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('accepts comment when commentsAntiSpam is enabled and cid-bound token is correct', async () => {
    await seedOptions(testDb, { commentsAntiSpam: '1' });
    const content = await seedContent(testDb);
    const token = await generateCommentToken('test-secret', content.cid);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Legit comment', author: 'Alice', _: token });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
  });

  it('rejects a cid-bound token replayed against another post', async () => {
    await seedOptions(testDb, { commentsAntiSpam: '1' });
    const content1 = await seedContent(testDb);
    const content2 = await seedContent(testDb, { slug: 'test-post-2' });
    // Token issued for post 1 must not be accepted on post 2.
    const token = await generateCommentToken('test-secret', content1.cid);
    const req = makeCommentRequest({ cid: String(content2.cid), text: 'Cross-post replay', author: 'Mallory', _: token });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects comments on private content', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { status: 'private' });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Nope', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects comments on draft content', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { type: 'post_draft', status: 'draft' });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Nope', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects comments on attachments', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { type: 'attachment', status: 'publish' });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Nope', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });
});
