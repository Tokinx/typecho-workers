import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import * as schema from '@/db/schema';
import {
  generateResetToken,
  hashResetToken,
  hashPassword,
  parseResetToken,
  verifyPassword,
} from '@/lib/auth';
import { resetSlidingWindow } from '@/lib/login-rate-limit';
import { env } from 'cloudflare:workers';

let testDb: TestDatabase;
const { mockSendMail } = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
}));

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => testDb, schema: actual.schema };
});

vi.mock('@/lib/mail', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mail')>('@/lib/mail');
  return { ...actual, sendMail: mockSendMail };
});

vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
}));

import { POST as forgotPassword } from '@/pages/api/users/forgot-password';
import { POST as resetPassword } from '@/pages/api/users/reset-password';

async function seedUser() {
  await testDb.insert(schema.options).values([
    { name: 'siteUrl', user: 0, value: 'https://example.com' },
    { name: 'title', user: 0, value: 'Test Blog' },
    { name: 'mailEnabled', user: 0, value: '1' },
    { name: 'mailFrom', user: 0, value: 'blog@example.com' },
  ]);
  await testDb.insert(schema.users).values({
    name: 'alice',
    mail: 'alice@example.com',
    password: await hashPassword('old-password'),
    authCode: 'existing-session-code',
    group: 'subscriber',
  });
  return (await testDb.query.users.findFirst())!;
}

function formRequest(path: string, fields: Record<string, string>) {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://example.com',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields),
  });
}

describe('password reset flow', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    mockSendMail.mockReset();
    resetSlidingWindow();
    env.PBKDF2_ITERATIONS = undefined;
    env.PASSWORD_PEPPER = undefined;
  });

  it('stores only a token hash and leaves authCode unchanged after successful delivery', async () => {
    const user = await seedUser();
    mockSendMail.mockResolvedValue({ sent: true, provider: 'test' });

    const response = await forgotPassword({
      request: formRequest('/api/users/forgot-password', { email: user.mail! }),
    } as any);

    expect(response.status).toBe(200);
    const currentUser = await testDb.query.users.findFirst();
    const pending = await testDb.query.passwordResetRequests.findFirst();
    expect(currentUser?.authCode).toBe('existing-session-code');
    expect(pending?.uid).toBe(user.uid);
    expect(pending?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const payload = mockSendMail.mock.calls[0][1];
    expect(payload.text).not.toContain(pending?.tokenHash);
  });

  it('restores the previous state when delivery fails', async () => {
    await seedUser();
    mockSendMail.mockResolvedValue({ sent: false, provider: 'none', error: 'no-adapter' });

    await forgotPassword({
      request: formRequest('/api/users/forgot-password', { email: 'alice@example.com' }),
    } as any);

    expect((await testDb.query.users.findFirst())?.authCode).toBe('existing-session-code');
    expect(await testDb.query.passwordResetRequests.findFirst()).toBeUndefined();
  });

  it('allows only one concurrent request to claim email delivery', async () => {
    await seedUser();
    let release!: () => void;
    const delivery = new Promise<void>(resolve => { release = resolve; });
    mockSendMail.mockImplementation(async () => {
      await delivery;
      return { sent: true, provider: 'test' };
    });

    const first = forgotPassword({
      request: formRequest('/api/users/forgot-password', { email: 'alice@example.com' }),
    } as any);
    await vi.waitFor(() => expect(mockSendMail).toHaveBeenCalledTimes(1));
    const second = await forgotPassword({
      request: formRequest('/api/users/forgot-password', { email: 'alice@example.com' }),
    } as any);
    release();
    await first;

    expect(second.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('parses a valid pending token and rejects it after expiry', async () => {
    const user = await seedUser();
    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.passwordResetRequests).values({
      email: user.mail!,
      lastSentAt: now,
      uid: user.uid,
      tokenHash,
      expiresAt: now + 60,
    });

    expect(await parseResetToken(token, testDb as any, now)).toMatchObject({ valid: true, uid: user.uid });
    expect(await parseResetToken(token, testDb as any, now + 61)).toMatchObject({ valid: false, error: 'expired' });
  });

  it('consumes the token once and invalidates sessions only after reset succeeds', async () => {
    const user = await seedUser();
    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.passwordResetRequests).values({
      email: user.mail!,
      lastSentAt: now,
      uid: user.uid,
      tokenHash,
      expiresAt: now + 3600,
    });

    const first = await resetPassword({
      request: formRequest('/api/users/reset-password', { token, password: 'new-password' }),
    } as any);
    expect(first.status).toBe(302);

    const updated = await testDb.query.users.findFirst();
    expect(updated?.authCode).not.toBe('existing-session-code');
    expect(await verifyPassword('new-password', updated?.password || '')).toBe(true);
    expect((await testDb.query.passwordResetRequests.findFirst())?.tokenHash).toBeNull();

    const second = await resetPassword({
      request: formRequest('/api/users/reset-password', { token, password: 'another-password' }),
    } as any);
    expect(second.status).toBe(400);
    expect(await verifyPassword('new-password', (await testDb.query.users.findFirst())?.password || '')).toBe(true);
  });

  it('recovers an account after PASSWORD_PEPPER is replaced', async () => {
    env.PBKDF2_ITERATIONS = '50000';
    env.PASSWORD_PEPPER = 'lost-old-pepper';
    const user = await seedUser();
    env.PASSWORD_PEPPER = 'replacement-pepper';
    expect(await verifyPassword('old-password', user.password || '')).toBe('wrong_password');

    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.passwordResetRequests).values({
      email: user.mail!,
      lastSentAt: now,
      uid: user.uid,
      tokenHash,
      expiresAt: now + 3600,
    });

    const response = await resetPassword({
      request: formRequest('/api/users/reset-password', { token, password: 'recovered-password' }),
    } as any);
    expect(response.status).toBe(302);
    const updated = await testDb.query.users.findFirst();
    expect(updated?.password).toMatch(/^\$PBKDF2P\$50000\$/);
    expect(await verifyPassword('recovered-password', updated?.password || '')).toBe(true);
  });
});
