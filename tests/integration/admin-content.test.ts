/**
 * Integration tests for POST /api/admin/content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, makeAuthCookie, type TestDatabase } from '../helpers';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
  applyFilter: async (_ctx: any, _hook: string, data: any) => data,
  doHook: async () => {},
}));

import { POST } from '@/pages/api/admin/content';

const TEST_SECRET = 'content-secret';
const TEST_AUTH_CODE = 'content-auth-code';

async function makeContentRequest(fields: Record<string, string>, cookie: string) {
  const body = new URLSearchParams(fields);
  return new Request('https://example.com/api/admin/content', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      // G2-1: requireAdminAction enforces same-origin via Origin/Referer.
      origin: 'https://example.com',
    },
    body: body.toString(),
  });
}

describe('POST /api/admin/content', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
  });

  it('counts duplicate tag names once when creating content', async () => {
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create',
      type: 'post',
      title: 'Tagged post',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
      tags: 'astro, astro, Astro',
      allowFeed: '1',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const tags = await testDb.select().from(schema.metas).where(eq(schema.metas.type, 'tag'));
    const rels = await testDb.select().from(schema.relationships);
    expect(tags).toHaveLength(1);
    expect(tags[0].count).toBe(1);
    expect(rels).toHaveLength(1);
  });

  it('derives an initial slug from the title when none is supplied', async () => {
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create',
      type: 'post',
      title: 'A Readable Post Title',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const content = await testDb.query.contents.findFirst({ where: eq(schema.contents.title, 'A Readable Post Title') });
    expect(content?.slug).toBe('a-readable-post-title');
  });

  it('rejects invalid custom field names before changing content', async () => {
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create',
      type: 'post',
      title: 'Invalid custom field',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
      'fieldNames[]': 'not valid',
      'fieldTypes[not valid]': 'str',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    expect(await testDb.query.contents.findFirst({ where: eq(schema.contents.title, 'Invalid custom field') })).toBeUndefined();
  });

  it('sends each valid manual Trackback after publishing a post', async () => {
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const fetchSpy = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const req = await makeContentRequest({
        do: 'create',
        type: 'post',
        title: 'Trackback post',
        text: 'Body text',
        status: 'publish',
        visibility: 'publish',
        trackback: 'https://remote.example/trackback',
      }, cookie);
      const res = await POST({ request: req, locals: {} } as any);

      expect(res.status).toBe(302);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://remote.example/trackback',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects unsafe manual Trackback targets before creating content', async () => {
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create',
      type: 'post',
      title: 'Unsafe Trackback',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
      trackback: 'javascript:alert(1)',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    expect(await testDb.query.contents.findFirst({ where: eq(schema.contents.title, 'Unsafe Trackback') })).toBeUndefined();
  });

  it('deduplicates slug when updating to another content slug', async () => {
    await testDb.insert(schema.options).values({
      name: 'permalinkPattern',
      user: 0,
      value: '/archives/{slug}.html',
    });
    await testDb.insert(schema.contents).values({
      title: 'First',
      slug: 'shared-slug',
      type: 'post',
      status: 'publish',
      authorId: 1,
    });
    await testDb.insert(schema.contents).values({
      title: 'Second',
      slug: 'second',
      type: 'post',
      status: 'publish',
      authorId: 1,
    });
    const second = await testDb.query.contents.findFirst({
      where: eq(schema.contents.slug, 'second'),
    });

    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'update',
      cid: String(second!.cid),
      type: 'post',
      title: 'Second updated',
      slug: 'shared-slug',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const updated = await testDb.query.contents.findFirst({
      where: eq(schema.contents.cid, second!.cid),
    });
    expect(updated?.slug).toBe(`shared-slug-${second!.cid}`);
  });

  it('preserves a post slug when its permalink format does not expose a slug input', async () => {
    await testDb.insert(schema.contents).values({
      title: 'Existing post',
      slug: 'keep-this-slug',
      type: 'post',
      status: 'publish',
      authorId: 1,
    });
    const existing = await testDb.query.contents.findFirst({
      where: eq(schema.contents.slug, 'keep-this-slug'),
    });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'update',
      cid: String(existing!.cid),
      type: 'post',
      title: 'Updated without a slug field',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const updated = await testDb.query.contents.findFirst({
      where: eq(schema.contents.cid, existing!.cid),
    });
    expect(updated?.slug).toBe('keep-this-slug');
  });

  it('preserves a page slug and parent when its page URL format does not expose a slug input', async () => {
    await testDb.insert(schema.options).values({
      name: 'pagePattern',
      user: 0,
      value: '/pages/{cid}.html',
    });
    const [parent] = await testDb.insert(schema.contents).values({
      title: 'Parent page',
      slug: 'parent-page',
      type: 'page',
      status: 'publish',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });
    const [existing] = await testDb.insert(schema.contents).values({
      title: 'Existing page',
      slug: 'keep-this-page-slug',
      parent: parent.cid,
      type: 'page',
      status: 'publish',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });

    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'update',
      cid: String(existing.cid),
      type: 'page',
      title: 'Updated without a slug or parent field',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const updated = await testDb.query.contents.findFirst({
      where: eq(schema.contents.cid, existing.cid),
    });
    expect(updated?.slug).toBe('keep-this-page-slug');
    expect(updated?.parent).toBe(parent.cid);
  });

  it('creates a page beneath a valid parent page', async () => {
    const [parent] = await testDb.insert(schema.contents).values({
      title: 'Parent page',
      slug: 'parent-page',
      type: 'page',
      status: 'publish',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create',
      type: 'page',
      title: 'Child page',
      text: 'Body',
      parent: String(parent.cid),
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const child = await testDb.query.contents.findFirst({
      where: eq(schema.contents.title, 'Child page'),
    });
    expect(child?.parent).toBe(parent.cid);
  });

  it('rejects nonexistent and cyclic page parents', async () => {
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const invalidParentReq = await makeContentRequest({
      do: 'create',
      type: 'page',
      title: 'Invalid parent page',
      text: 'Body',
      parent: '999999',
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const invalidParentRes = await POST({ request: invalidParentReq, locals: {} } as any);
    expect(invalidParentRes.status).toBe(400);
    expect(await testDb.query.contents.findFirst({
      where: eq(schema.contents.title, 'Invalid parent page'),
    })).toBeUndefined();

    const [first] = await testDb.insert(schema.contents).values({
      title: 'First page',
      slug: 'first-page',
      type: 'page',
      status: 'publish',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });
    const [second] = await testDb.insert(schema.contents).values({
      title: 'Second page',
      slug: 'second-page',
      parent: first.cid,
      type: 'page',
      status: 'publish',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });
    const cyclicParentReq = await makeContentRequest({
      do: 'update',
      cid: String(first.cid),
      type: 'page',
      title: 'First page',
      text: 'Body',
      parent: String(second.cid),
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const cyclicParentRes = await POST({ request: cyclicParentReq, locals: {} } as any);
    expect(cyclicParentRes.status).toBe(400);
    const unchanged = await testDb.query.contents.findFirst({
      where: eq(schema.contents.cid, first.cid),
    });
    expect(unchanged?.parent).toBe(0);
  });

  it('parses the Typecho date picker value in the configured site timezone', async () => {
    await testDb.insert(schema.options).values({ name: 'timezone', user: 0, value: '28800' });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create',
      type: 'post',
      title: 'Scheduled post',
      text: 'Body',
      date: '2026-08-02 09:30',
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const scheduled = await testDb.query.contents.findFirst({
      where: eq(schema.contents.title, 'Scheduled post'),
    });
    expect(scheduled?.created).toBe(Math.floor(Date.UTC(2026, 7, 2, 1, 30) / 1000));
  });
});
