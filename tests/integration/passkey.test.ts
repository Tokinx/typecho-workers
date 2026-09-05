/**
 * Passkey / WebAuthn API integration tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb, disposeTestDb, seedAdmin, makeAuthCookie, type TestDatabase } from '../helpers';
import { generateSecurityToken } from '@/lib/auth';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('cloudflare:workers', () => ({
  get env() {
    return {
      DB: { batch: async () => [], prepare: () => ({ first: async () => null }) },
      BUCKET: null,
    };
  },
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async () => ({
    challenge: 'reg-challenge',
    rp: { name: 'Blog', id: 'example.com' },
    user: { id: 'MQ', name: 'admin', displayName: 'admin' },
    pubKeyCredParams: [],
  })),
  verifyRegistrationResponse: vi.fn(async () => ({
    verified: true,
    registrationInfo: {
      fmt: 'none',
      aaguid: '00000000-0000-0000-0000-000000000000',
      credential: {
        id: 'cred-id-1',
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ['internal'],
      },
      credentialType: 'public-key',
      attestationObject: new Uint8Array([1]),
      userVerified: true,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      origin: 'https://example.com',
      rpID: 'example.com',
    },
  })),
  generateAuthenticationOptions: vi.fn(async () => ({
    challenge: 'auth-challenge',
    rpId: 'example.com',
    allowCredentials: [],
  })),
  verifyAuthenticationResponse: vi.fn(async () => ({
    verified: true,
    authenticationInfo: {
      credentialID: 'cred-id-1',
      newCounter: 1,
      userVerified: true,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      origin: 'https://example.com',
      rpID: 'example.com',
    },
  })),
}));

const SITE = 'https://example.com';
const SECRET = 'passkey-test-secret';
const AUTH = 'passkey-auth-code';

async function setUp() {
  testDb = await createTestDb();
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE });
  await testDb.insert(schema.options).values({ name: 'title', user: 0, value: 'Test Blog' });
  return await seedAdmin(testDb, { secret: SECRET, authCode: AUTH });
}

async function adminHeaders(extra: HeadersInit = {}) {
  const user = await testDb.query.users.findFirst();
  const cookie = await makeAuthCookie(testDb, user!.uid, AUTH, SECRET);
  const csrf = await generateSecurityToken(SECRET, AUTH, user!.uid);
  return {
    cookie,
    origin: SITE,
    'X-CSRF-Token': csrf,
    ...extra,
  };
}

beforeEach(async () => {
  await setUp();
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('passkey admin APIs', () => {
  it('rejects unauthenticated register-options', async () => {
    const { POST } = await import('@/pages/api/admin/passkey/register-options');
    const res = await POST({
      request: new Request(`${SITE}/api/admin/passkey/register-options`, {
        method: 'POST',
        headers: { origin: SITE },
      }),
    } as any);
    expect(res.status).toBe(401);
  });

  it('rejects CSRF-less register', async () => {
    const { POST } = await import('@/pages/api/admin/passkey/register');
    const user = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, user!.uid, AUTH, SECRET);
    const res = await POST({
      request: new Request(`${SITE}/api/admin/passkey/register`, {
        method: 'POST',
        headers: {
          cookie,
          origin: SITE,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          challengeToken: 'x',
          response: { id: 'cred-id-1' },
        }),
      }),
    } as any);
    expect(res.status).toBe(403);
  });

  it('issues registration options and stores a verified credential', async () => {
    const { POST: optionsPost } = await import('@/pages/api/admin/passkey/register-options');
    const optRes = await optionsPost({
      request: new Request(`${SITE}/api/admin/passkey/register-options`, {
        method: 'POST',
        headers: await adminHeaders({ 'Content-Type': 'application/json' }),
        body: '{}',
      }),
    } as any);
    expect(optRes.status).toBe(200);
    const optBody = await optRes.json() as { challengeToken: string; options: { challenge: string } };
    expect(optBody.options.challenge).toBe('reg-challenge');
    expect(optBody.challengeToken).toContain('.');

    const { POST: registerPost } = await import('@/pages/api/admin/passkey/register');
    const regRes = await registerPost({
      request: new Request(`${SITE}/api/admin/passkey/register`, {
        method: 'POST',
        headers: await adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          challengeToken: optBody.challengeToken,
          response: {
            id: 'cred-id-1',
            rawId: 'cred-id-1',
            type: 'public-key',
            clientExtensionResults: {},
            response: {
              clientDataJSON: 'e30',
              attestationObject: 'e30',
            },
          },
          name: 'MacBook',
        }),
      }),
    } as any);
    expect(regRes.status).toBe(200);

    const { GET } = await import('@/pages/api/admin/passkey/index');
    const listRes = await GET({
      request: new Request(`${SITE}/api/admin/passkey`, {
        headers: await adminHeaders(),
      }),
    } as any);
    const list = await listRes.json() as { credentials: Array<{ name: string }> };
    expect(list.credentials).toHaveLength(1);
    expect(list.credentials[0].name).toBe('MacBook');
  });
});

describe('passkey login APIs', () => {
  it('rejects cross-origin login-options', async () => {
    const { POST } = await import('@/pages/api/users/passkey/login-options');
    const res = await POST({
      request: new Request(`${SITE}/api/users/passkey/login-options`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: '{}',
      }),
      locals: {},
    } as any);
    expect(res.status).toBe(403);
  });

  it('logs in with a registered passkey and sets auth cookies', async () => {
    const {
      buildRegistrationOptions,
      verifyAndStoreRegistration,
      resolveRelyingParty,
    } = await import('@/lib/webauthn');
    const rp = resolveRelyingParty(SITE, 'Test Blog')!;
    const { challengeToken } = await buildRegistrationOptions({
      db: testDb as any,
      secret: SECRET,
      rp,
      uid: 1,
      userName: 'admin',
      userDisplayName: 'admin',
    });
    await verifyAndStoreRegistration({
      db: testDb as any,
      secret: SECRET,
      rp,
      uid: 1,
      challengeToken,
      response: {
        id: 'cred-id-1',
        rawId: 'cred-id-1',
        type: 'public-key',
        clientExtensionResults: {},
        response: { clientDataJSON: 'e30', attestationObject: 'e30' },
      },
      name: 'Test Key',
    });

    const { POST: loginOptions } = await import('@/pages/api/users/passkey/login-options');
    const optRes = await loginOptions({
      request: new Request(`${SITE}/api/users/passkey/login-options`, {
        method: 'POST',
        headers: { origin: SITE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'admin' }),
      }),
      locals: {},
    } as any);
    expect(optRes.status).toBe(200);
    const optBody = await optRes.json() as { challengeToken: string };

    const { POST: login } = await import('@/pages/api/users/passkey/login');
    const loginRes = await login({
      request: new Request(`${SITE}/api/users/passkey/login`, {
        method: 'POST',
        headers: { origin: SITE, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeToken: optBody.challengeToken,
          response: {
            id: 'cred-id-1',
            rawId: 'cred-id-1',
            type: 'public-key',
            clientExtensionResults: {},
            response: {
              clientDataJSON: 'e30',
              authenticatorData: 'e30',
              signature: 'e30',
            },
          },
          remember: true,
          referer: '/admin/',
        }),
      }),
      locals: {},
    } as any);
    expect(loginRes.status).toBe(200);
    const setCookie = typeof loginRes.headers.getSetCookie === 'function'
      ? loginRes.headers.getSetCookie()
      : [];
    const cookieJoined = setCookie.join(';') || String(loginRes.headers.get('set-cookie') || '');
    expect(cookieJoined).toContain('__typecho_uid=');
    expect(cookieJoined).toContain('__typecho_authCode=');
    const body = await loginRes.json() as { redirect: string };
    expect(body.redirect).toContain('/admin');
  });
});
