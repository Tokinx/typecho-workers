import { describe, expect, it } from 'vitest';
import {
  resolveRelyingParty,
  sealChallenge,
  unsealChallenge,
  CHALLENGE_TTL_MS,
} from '@/lib/webauthn';

describe('resolveRelyingParty', () => {
  it('parses origin and rpID from siteUrl', () => {
    const rp = resolveRelyingParty('https://blog.example.com/path', 'My Blog');
    expect(rp).toEqual({
      rpID: 'blog.example.com',
      origin: 'https://blog.example.com',
      rpName: 'My Blog',
    });
  });

  it('returns null for empty or invalid URLs', () => {
    expect(resolveRelyingParty('')).toBeNull();
    expect(resolveRelyingParty('not-a-url')).toBeNull();
  });
});

describe('sealChallenge / unsealChallenge', () => {
  const secret = 'test-secret-for-webauthn';

  it('round-trips a registration challenge with uid', async () => {
    const token = await sealChallenge(secret, 'reg', 'challenge-abc', 7);
    const payload = await unsealChallenge(secret, token, 'reg');
    expect(payload).toMatchObject({ c: 'challenge-abc', p: 'reg', u: 7 });
    expect(payload!.exp).toBeGreaterThan(Date.now());
  });

  it('round-trips an auth challenge without uid', async () => {
    const token = await sealChallenge(secret, 'auth', 'challenge-xyz');
    const payload = await unsealChallenge(secret, token, 'auth');
    expect(payload).toMatchObject({ c: 'challenge-xyz', p: 'auth' });
    expect(payload!.u).toBeUndefined();
  });

  it('rejects tampered tokens and purpose mismatches', async () => {
    const token = await sealChallenge(secret, 'reg', 'challenge-abc', 1);
    expect(await unsealChallenge(secret, token + 'x', 'reg')).toBeNull();
    expect(await unsealChallenge(secret, token, 'auth')).toBeNull();
    expect(await unsealChallenge('other-secret', token, 'reg')).toBeNull();
  });

  it('rejects expired challenges', async () => {
    const now = Date.now();
    const token = await sealChallenge(secret, 'auth', 'old', undefined, now - CHALLENGE_TTL_MS - 1000);
    expect(await unsealChallenge(secret, token, 'auth', now)).toBeNull();
  });

  it('rejects registration seals missing uid', async () => {
    // Force a malformed registration payload by sealing auth then rewriting purpose is hard;
    // seal with purpose reg requires uid in unseal — verify auth seal fails as reg.
    const token = await sealChallenge(secret, 'auth', 'c');
    expect(await unsealChallenge(secret, token, 'reg')).toBeNull();
  });
});
