import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';
import { generateUnapprovedCommentToken } from '@/lib/auth';
import { resetEarlyRequestProvidersForTests } from '@/lib/early-request';

let testDb: TestDatabase;
const { mockApplyFilter, mockLoadCommentPage, mockLoadPublicCommentPage } = vi.hoisted(() => ({
  mockApplyFilter: vi.fn(async (_ctx: any, _hook: string, value: any) => value),
  mockLoadCommentPage: vi.fn(),
  mockLoadPublicCommentPage: vi.fn(),
}));

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('@/lib/plugin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plugin')>('@/lib/plugin');
  return {
    ...actual,
    parseActivatedPlugins: () => [],
    setActivatedPlugins: async () => {},
    applyFilter: mockApplyFilter,
    applyFilterSafely: mockApplyFilter,
  };
});

vi.mock('@/lib/comment-page', async () => {
  const actual = await vi.importActual<typeof import('@/lib/comment-page')>('@/lib/comment-page');
  return {
    ...actual,
    loadCommentPage: async (...args: Parameters<typeof actual.loadCommentPage>) => {
      mockLoadCommentPage();
      return actual.loadCommentPage(...args);
    },
    loadPublicCommentPage: async (...args: Parameters<typeof actual.loadPublicCommentPage>) => {
      mockLoadPublicCommentPage();
      return actual.loadPublicCommentPage(...args);
    },
  };
});

import { GET } from '@/pages/api/comments';

async function seedOptions(overrides: Record<string, string> = {}) {
  const options = {
    secret: 'public-comments-secret',
    siteUrl: 'https://example.com',
    commentsAntiSpam: '1',
    commentsAvatar: '0',
    commentsThreaded: '1',
    commentsPageBreak: '0',
    ...overrides,
  };
  await testDb.insert(schema.options).values(
    Object.entries(options).map(([name, value]) => ({ name, user: 0, value })),
  );
}

async function seedPost(overrides: Partial<typeof schema.contents.$inferInsert> = {}) {
  const [post] = await testDb.insert(schema.contents).values({
    title: 'Public post',
    slug: 'public-post',
    type: 'post',
    status: 'publish',
    created: Math.floor(Date.now() / 1000) - 60,
    allowComment: '1',
    ...overrides,
  }).returning();
  return post;
}

function request(cid: string, headers: HeadersInit = {}) {
  const req = new Request(`https://example.com/api/comments?cid=${cid}`, {
    headers: { accept: 'application/json', ...headers },
  });
  return { request: req, url: new URL(req.url), locals: {} } as any;
}

function requestWithQuery(cid: string, query: string, headers: HeadersInit = {}) {
  const req = new Request(`https://example.com/api/comments?cid=${cid}&${query}`, {
    headers: { accept: 'application/json', ...headers },
  });
  return { request: req, url: new URL(req.url), locals: {} } as any;
}

describe('GET /api/comments', () => {
  beforeEach(async () => {
    resetEarlyRequestProvidersForTests();
    testDb = await createTestDb();
    mockApplyFilter.mockImplementation(async (_ctx: any, _hook: string, value: any) => value);
    mockLoadCommentPage.mockClear();
    mockLoadPublicCommentPage.mockClear();
  });

  afterEach(async () => {
    await disposeTestDb(testDb);
  });

  it('rejects malformed content ids', async () => {
    const response = await GET(request('../1'));
    expect(response.status).toBe(400);
  });

  it('does not expose comments for future content', async () => {
    await seedOptions();
    const post = await seedPost({ created: Math.floor(Date.now() / 1000) + 3600 });
    const response = await GET(request(String(post.cid)));
    expect(response.status).toBe(404);
  });

  it('loads only comment metadata first and fills an anonymous commenter from cookies', async () => {
    await seedOptions();
    const post = await seedPost();
    const response = await GET(requestWithQuery(String(post.cid), 'includeComments=0', {
      Cookie: '__typecho_remember_author=Reader%20Name; __typecho_remember_mail=reader%40example.com; __typecho_remember_url=https%3A%2F%2Freader.example.com%2F',
    }));
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(body.comments).toEqual([]);
    expect(body).not.toHaveProperty('pagination');
    expect(JSON.stringify(body)).not.toContain('totalComments');
    expect(body.commenter).toEqual({
      loggedIn: false,
      author: 'Reader Name',
      mail: 'reader@example.com',
      url: 'https://reader.example.com/',
    });
    expect(mockLoadCommentPage).not.toHaveBeenCalled();
    expect(mockLoadPublicCommentPage).not.toHaveBeenCalled();
  });

  it('cleans invalid remembered commenter cookies without exposing them', async () => {
    await seedOptions();
    const post = await seedPost();
    const response = await GET(requestWithQuery(String(post.cid), 'includeComments=0', {
      Cookie: '__typecho_remember_author=%00bad; __typecho_remember_mail=not-an-email; __typecho_remember_url=javascript%3Aalert(1)',
    }));
    const body = await response.json() as any;
    const setCookie = response.headers.get('set-cookie') || '';

    expect(body.commenter).toEqual({ loggedIn: false, author: '', mail: '', url: '' });
    expect(setCookie).toContain('__typecho_remember_author=;');
    expect(setCookie).toContain('__typecho_remember_mail=;');
    expect(setCookie).toContain('__typecho_remember_url=;');
    expect(JSON.stringify(body)).not.toContain('not-an-email');
  });

  it('returns the validated logged-in identity instead of anonymous remembered data', async () => {
    await seedOptions();
    const post = await seedPost();
    const [user] = await testDb.insert(schema.users).values({
      name: 'reader', screenName: '登录读者', mail: 'login@example.com', url: 'https://login.example.com', authCode: 'auth-code',
    }).returning();
    const cookie = await makeAuthCookie(testDb, user.uid, 'auth-code', 'public-comments-secret');
    const response = await GET(requestWithQuery(String(post.cid), 'includeComments=0', {
      Cookie: `${cookie}; __typecho_remember_author=Anonymous`,
    }));
    const body = await response.json() as any;

    expect(body.commenter).toEqual({
      loggedIn: true,
      author: '登录读者',
      mail: 'login@example.com',
      url: 'https://login.example.com',
    });
  });

  it('returns sanitized public comments without email addresses', async () => {
    await seedOptions({ commentDateFormat: 'Y-m-d H:i:s', timezone: '0' });
    const post = await seedPost();
    await testDb.insert(schema.comments).values([
      {
        cid: post.cid,
        author: 'Reader',
        mail: 'reader@example.com',
        url: 'https://reader.example.com',
        text: '<script>alert(1)</script><strong>有用的评论</strong>',
        type: 'comment',
        status: 'approved',
        created: 100,
        parent: 0,
      },
      {
        cid: post.cid,
        author: 'Waiting',
        mail: 'waiting@example.com',
        text: 'not public',
        type: 'comment',
        status: 'waiting',
        created: 101,
        parent: 0,
      },
    ]);

    const response = await GET(request(String(post.cid)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('X-Typecho-Comment-Cache')).toBe('MISS');
    const raw = await response.text();
    expect(raw).not.toContain('reader@example.com');
    expect(raw).not.toContain('waiting@example.com');
    expect(raw).not.toContain('<script>');
    const body = JSON.parse(raw);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].text).toContain('有用的评论');
    expect(body.comments[0].date).toBe('1970-01-01 00:01:40');
    expect(body.options.securityToken).toBeTruthy();
  });

  it('filters the public avatar map while keeping the browser response private', async () => {
    await seedOptions({ commentsAvatar: '1' });
    const post = await seedPost();
    await testDb.insert(schema.comments).values({
      cid: post.cid,
      author: 'Reader',
      mail: 'reader@example.com',
      text: 'avatar',
      type: 'comment',
      status: 'approved',
      created: 100,
      parent: 0,
    });
    mockApplyFilter.mockImplementation(async (_ctx: any, hook: string, value: any) => (
      hook === 'comment:avatarMap'
        ? Object.fromEntries(Object.keys(value).map(coid => [coid, `https://avatar.example.com/avatar/${coid}`]))
        : value
    ));

    const response = await GET(request(String(post.cid)));
    const body = await response.json() as any;

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Object.values(body.gravatarMap)).toEqual([
      expect.stringMatching(/^https:\/\/avatar\.example\.com\/avatar\/\d+$/),
    ]);
    expect(mockApplyFilter).toHaveBeenCalledWith(
      expect.anything(),
      'comment:avatarMap',
      expect.any(Object),
      expect.objectContaining({ request: expect.any(Request), options: expect.any(Object) }),
    );
  });

  it('reuses a cached anonymous result without reloading comment rows', async () => {
    await seedOptions();
    const post = await seedPost();
    await testDb.insert(schema.comments).values({
      cid: post.cid,
      author: 'Reader',
      mail: 'reader@example.com',
      text: 'public',
      status: 'approved',
      created: 100,
      parent: 0,
    });

    const first = await GET(request(String(post.cid)));
    const second = await GET(request(String(post.cid)));

    expect(first.headers.get('X-Typecho-Comment-Cache')).toBe('MISS');
    expect(second.headers.get('X-Typecho-Comment-Cache')).toBe('HIT');
    expect(mockLoadPublicCommentPage).toHaveBeenCalledOnce();
    expect(await second.text()).not.toContain('reader@example.com');
  });

  it('reports the query-cache source on every comments response', async () => {
    await seedOptions();
    const post = await seedPost();
    await testDb.insert(schema.comments).values({
      cid: post.cid,
      author: 'Reader',
      text: 'public',
      status: 'approved',
      created: 100,
      parent: 0,
    });

    const first = await GET(request(String(post.cid)));
    expect(first.headers.get('X-Typecho-Comment-Cache')).toBe('MISS');
    expect(first.headers.get('X-Typecho-Query-Cache')).toBe('comments=MISS');

    const second = await GET(request(String(post.cid)));
    expect(second.headers.get('X-Typecho-Comment-Cache')).toBe('HIT');
    expect(second.headers.get('X-Typecho-Query-Cache')).toBe('comments=L0');
  });

  it('uses lookahead pagination for anonymous public comment pages', async () => {
    await seedOptions({ commentsPageBreak: '1', commentsPageSize: '2', commentsThreaded: '0' });
    const post = await seedPost();
    await testDb.insert(schema.comments).values([1, 2, 3].map(created => ({
      cid: post.cid,
      author: `Reader ${created}`,
      text: `public ${created}`,
      status: 'approved' as const,
      created,
      parent: 0,
    })));

    const response = await GET(request(String(post.cid)));
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.comments).toHaveLength(2);
    expect(body.pagination).toMatchObject({
      totalsExact: false,
      totalComments: null,
      totalPages: null,
      hasNext: true,
    });
    expect(mockLoadPublicCommentPage).toHaveBeenCalledOnce();
    expect(mockLoadCommentPage).not.toHaveBeenCalled();
  });

  it('bypasses the anonymous cache for cookies, authorization, and explicit refreshes', async () => {
    await seedOptions();
    const post = await seedPost();
    await testDb.insert(schema.comments).values({
      cid: post.cid,
      author: 'Reader',
      text: 'public',
      status: 'approved',
      created: 100,
      parent: 0,
    });
    await GET(request(String(post.cid)));

    const bypassHeaders: HeadersInit[] = [
      { Cookie: 'theme=dark' },
      { Authorization: 'Bearer token' },
      { 'Cache-Control': 'no-cache' },
    ];
    for (const headers of bypassHeaders) {
      const response = await GET(request(String(post.cid), headers));
      expect(response.headers.get('X-Typecho-Comment-Cache')).toBe('BYPASS');
    }
    expect(mockLoadPublicCommentPage).toHaveBeenCalledTimes(4);
    expect(mockLoadCommentPage).not.toHaveBeenCalled();
  });

  it('reports BYPASS for a request that carries a cookie', async () => {
    await seedOptions();
    const post = await seedPost();
    await testDb.insert(schema.comments).values({
      cid: post.cid,
      author: 'Reader',
      text: 'public',
      status: 'approved',
      created: 100,
      parent: 0,
    });

    const response = await GET(request(String(post.cid), {
      Cookie: 'theme=dark',
    }));
    expect(response.headers.get('X-Typecho-Comment-Cache')).toBe('BYPASS');
    expect(response.headers.get('X-Typecho-Query-Cache')).toBe('comments=BYPASS');
  });

  it('uses lookahead pagination when page breaks are disabled', async () => {
    await seedOptions({ commentsThreaded: '0' });
    const post = await seedPost();
    await testDb.insert(schema.comments).values(Array.from({ length: 21 }, (_, index) => ({
      cid: post.cid,
      author: `Reader ${index}`,
      text: `public ${index}`,
      status: 'approved' as const,
      created: index,
      parent: 0,
    })));

    const response = await GET(request(String(post.cid)));
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.comments).toHaveLength(20);
    expect(body.pagination).toMatchObject({
      enabled: true,
      totalsExact: false,
      totalComments: null,
      totalPages: null,
      hasNext: true,
    });
    expect(mockLoadPublicCommentPage).toHaveBeenCalledOnce();
    expect(mockLoadCommentPage).not.toHaveBeenCalled();
  });

  it('never shares a waiting comment exposed by the submitter capability', async () => {
    await seedOptions();
    const post = await seedPost();
    const [waiting] = await testDb.insert(schema.comments).values({
      cid: post.cid,
      author: 'Waiting reader',
      mail: 'waiting@example.com',
      text: 'pending',
      status: 'waiting',
      created: 100,
      parent: 0,
    }).returning();
    const token = await generateUnapprovedCommentToken('public-comments-secret', post.cid, waiting.coid);

    const response = await GET(request(String(post.cid), {
      Cookie: `__typecho_unapproved_comment=${encodeURIComponent(token)}`,
    }));
    const body = await response.json() as any;

    expect(response.headers.get('X-Typecho-Comment-Cache')).toBe('BYPASS');
    expect(body.comments).toEqual([expect.objectContaining({ coid: waiting.coid, status: 'waiting' })]);
    expect(JSON.stringify(body)).not.toContain('waiting@example.com');
  });

  it('fails closed when a content visibility plugin throws', async () => {
    await seedOptions();
    const post = await seedPost();
    mockApplyFilter.mockRejectedValueOnce(new Error('plugin failed'));
    const response = await GET(request(String(post.cid)));
    expect(response.status).toBe(503);
  });
});
