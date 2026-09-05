/**
 * Engine searchScope modes for prepareSearchData.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { prepareSearchData } from '@/lib/page-data';
import type { RequestContext } from '@/lib/context';
import { schema } from '@/db';
import { ENGINE_SUMMARY_FIELD } from '@/lib/search-scope';

async function buildCtx(searchScope: string, engineActive = true): Promise<RequestContext> {
  const options: Record<string, unknown> = {
    title: 'Test',
    siteUrl: 'https://example.com',
    pageSize: '10',
    timezone: '0',
    permalinkPattern: '/archives/{cid}/',
    categoryPattern: '/category/{slug}/',
    activatedPlugins: engineActive
      ? JSON.stringify(['typecho-plugin-engine'])
      : JSON.stringify([]),
  };
  if (engineActive) {
    options['plugin:typecho-plugin-engine'] = JSON.stringify({
      searchScope,
      endpoint: 'https://example.com/v1/',
      apiKey: 'k',
      model: 'm',
    });
  }

  return {
    db: testDb as any,
    options: options as any,
    urls: { siteUrl: 'https://example.com' } as any,
    user: null,
    isLoggedIn: false,
    csrfToken: null,
    activatedPlugins: new Set(engineActive ? ['typecho-plugin-engine'] : []),
  };
}

describe('engine searchScope', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    const now = Math.floor(Date.now() / 1000);
    const [onlyBody] = await testDb.insert(schema.contents).values({
      title: 'Alpha title',
      slug: 'alpha',
      type: 'post',
      status: 'publish',
      created: now,
      modified: now,
      text: 'unique-body-keyword appears only here',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });
    const [withSummary] = await testDb.insert(schema.contents).values({
      title: 'Beta title',
      slug: 'beta',
      type: 'post',
      status: 'publish',
      created: now - 1,
      modified: now - 1,
      text: 'unrelated body',
      authorId: 1,
    }).returning({ cid: schema.contents.cid });
    await testDb.insert(schema.fields).values({
      cid: withSummary.cid!,
      name: ENGINE_SUMMARY_FIELD,
      type: 'str',
      str_value: 'mentions unique-summary-keyword for search',
    });
    void onlyBody;
  });

  it('default scope matches body text', async () => {
    const props = await prepareSearchData(
      await buildCtx('default'),
      'unique-body-keyword',
      'https://example.com/search/unique-body-keyword/',
      {},
      new URL('https://example.com/search/unique-body-keyword/'),
    );
    if (props instanceof Response) throw new Error('expected props');
    expect(props.posts.map((p) => p.title)).toEqual(['Alpha title']);
  });

  it('title scope ignores body matches', async () => {
    const props = await prepareSearchData(
      await buildCtx('title'),
      'unique-body-keyword',
      'https://example.com/search/unique-body-keyword/',
      {},
      new URL('https://example.com/search/unique-body-keyword/'),
    );
    if (props instanceof Response) throw new Error('expected props');
    expect(props.posts).toHaveLength(0);
  });

  it('title_summary matches engine_summary without scanning body', async () => {
    const bySummary = await prepareSearchData(
      await buildCtx('title_summary'),
      'unique-summary-keyword',
      'https://example.com/search/unique-summary-keyword/',
      {},
      new URL('https://example.com/search/unique-summary-keyword/'),
    );
    if (bySummary instanceof Response) throw new Error('expected props');
    expect(bySummary.posts.map((p) => p.title)).toEqual(['Beta title']);

    const byBody = await prepareSearchData(
      await buildCtx('title_summary'),
      'unique-body-keyword',
      'https://example.com/search/unique-body-keyword/',
      {},
      new URL('https://example.com/search/unique-body-keyword/'),
    );
    if (byBody instanceof Response) throw new Error('expected props');
    expect(byBody.posts).toHaveLength(0);
  });

  it('inactive engine falls back to default body search', async () => {
    const props = await prepareSearchData(
      await buildCtx('title', false),
      'unique-body-keyword',
      'https://example.com/search/unique-body-keyword/',
      {},
      new URL('https://example.com/search/unique-body-keyword/'),
    );
    if (props instanceof Response) throw new Error('expected props');
    expect(props.posts.map((p) => p.title)).toEqual(['Alpha title']);
  });
});
