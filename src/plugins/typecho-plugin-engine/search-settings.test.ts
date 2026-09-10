import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../../../tests/helpers';
import { generateSecurityToken } from '@/lib/auth';
import init from '@/plugins/typecho-plugin-engine';
import { CONFIG_API_ROUTE } from '@/plugins/typecho-plugin-engine/admin-page';
import { SETTINGS_DEFAULTS } from '@/plugins/typecho-plugin-engine/config';
import { HookPoints, type PluginRouteResult } from '@/lib/plugin';
import { eq } from 'drizzle-orm';
import { schema } from '@/db';

const SITE = 'https://example.com';
const secret = 'search-settings-test-secret';
const authCode = 'search-settings-auth-code';
let db: TestDatabase;
let cookie: string;
let token: string;
let route: (...args: any[]) => any;

beforeEach(async () => {
  db = await createTestDb();
  const user = await seedAdmin(db, { secret, authCode });
  cookie = await makeAuthCookie(db, user.uid, authCode, secret);
  token = await generateSecurityToken(secret, authCode, user.uid);
  init({ HookPoints, pluginId: 'typecho-plugin-engine', addHook(point, _id, handler) {
    if (point === 'route:request') route = handler;
  } });
});

async function save(provider: string, overrides: { origin?: string; csrf?: string; cookie?: string; method?: string } = {}) {
  const method = overrides.method || 'POST';
  const request = new Request(SITE + CONFIG_API_ROUTE, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: overrides.origin ?? SITE,
      Cookie: overrides.cookie ?? cookie,
      'X-CSRF-Token': overrides.csrf ?? token,
    },
    ...(method === 'POST' ? { body: JSON.stringify({ settings: { ...SETTINGS_DEFAULTS, searchProvider: provider } }) } : {}),
  });
  const result: PluginRouteResult = await route({ handled: false }, {
    path: CONFIG_API_ROUTE, request, db, options: { siteUrl: SITE, secret },
  });
  return result.response!;
}

describe('Engine search settings save', () => {
  it.each(['default', 'bing', 'google'])('persists %s without an AI key and advances cache version', async provider => {
    const response = await save(provider);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, settings: { searchProvider: provider, apiKey: '' } });
    const stored = await db.query.options.findFirst({ where: eq(schema.options.name, 'plugin:typecho-plugin-engine') });
    expect(JSON.parse(stored!.value!)).toMatchObject({ searchProvider: provider });
    const version = await db.query.options.findFirst({ where: eq(schema.options.name, 'cacheVersion') });
    expect(Number(version!.value)).toBeGreaterThan(0);
  });

  it.each([
    { origin: 'https://evil.test' },
    { origin: 'http://example.com' },
    { origin: 'https://example.com.evil.test' },
    { csrf: 'invalid' },
    { cookie: '' },
    { method: 'GET' },
  ])('rejects unauthorized state changes: %j', async overrides => {
    const response = await save('google', overrides);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await db.query.options.findFirst({ where: eq(schema.options.name, 'plugin:typecho-plugin-engine') })).toBeUndefined();
  });
});
