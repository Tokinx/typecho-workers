import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;
const { mockApplyFilter } = vi.hoisted(() => ({
  mockApplyFilter: vi.fn(async (_ctx: any, _hook: string, value: any) => value),
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

function request(cid: string) {
  const req = new Request(`https://example.com/api/comments?cid=${cid}`, {
    headers: { accept: 'application/json' },
  });
  return { request: req, url: new URL(req.url), locals: {} } as any;
}

describe('GET /api/comments', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    mockApplyFilter.mockImplementation(async (_ctx: any, _hook: string, value: any) => value);
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

  it('returns sanitized public comments without email addresses', async () => {
    await seedOptions();
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
    const raw = await response.text();
    expect(raw).not.toContain('reader@example.com');
    expect(raw).not.toContain('waiting@example.com');
    expect(raw).not.toContain('<script>');
    const body = JSON.parse(raw);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].text).toContain('有用的评论');
    expect(body.options.securityToken).toBeTruthy();
  });

  it('filters the public avatar map without making the API cacheable', async () => {
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

  it('fails closed when a content visibility plugin throws', async () => {
    await seedOptions();
    const post = await seedPost();
    mockApplyFilter.mockRejectedValueOnce(new Error('plugin failed'));
    const response = await GET(request(String(post.cid)));
    expect(response.status).toBe(503);
  });
});
