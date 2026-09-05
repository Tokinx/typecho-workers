/**
 * WebAuthn / Passkey helpers for Cloudflare Workers.
 *
 * Challenges are HMAC-sealed into opaque tokens so Workers do not need
 * sticky session storage between options and verification.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { timeSafeEqual } from '@/lib/auth';

type AuthenticatorTransport = string;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS_PER_USER = 10;

export type ChallengePurpose = 'reg' | 'auth';

interface SealedChallenge {
  c: string;
  p: ChallengePurpose;
  u?: number;
  exp: number;
}

export interface RelyingParty {
  rpID: string;
  origin: string;
  rpName: string;
}

export function resolveRelyingParty(siteUrl: string, fallbackTitle = 'Typecho'): RelyingParty | null {
  if (!siteUrl.trim()) return null;
  try {
    const url = new URL(siteUrl);
    if (!url.hostname) return null;
    return {
      rpID: url.hostname,
      origin: url.origin,
      rpName: fallbackTitle || url.hostname,
    };
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sealChallenge(
  secret: string,
  purpose: ChallengePurpose,
  challenge: string,
  uid?: number,
  now = Date.now(),
): Promise<string> {
  const payload: SealedChallenge = {
    c: challenge,
    p: purpose,
    exp: now + CHALLENGE_TTL_MS,
    ...(uid !== undefined ? { u: uid } : {}),
  };
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await hmacHex(secret, body);
  return `${body}.${mac}`;
}

export async function unsealChallenge(
  secret: string,
  token: string,
  purpose: ChallengePurpose,
  now = Date.now(),
): Promise<SealedChallenge | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!body || !mac) return null;
  const expected = await hmacHex(secret, body);
  if (!timeSafeEqual(mac, expected)) return null;
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(body));
    const payload = JSON.parse(json) as SealedChallenge;
    if (payload.p !== purpose || typeof payload.c !== 'string' || typeof payload.exp !== 'number') {
      return null;
    }
    if (payload.exp < now) return null;
    if (purpose === 'reg' && (typeof payload.u !== 'number' || !Number.isFinite(payload.u))) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function parseTransports(raw: string | null | undefined): AuthenticatorTransport[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((t): t is AuthenticatorTransport => typeof t === 'string');
  } catch {
    return undefined;
  }
}

export async function listCredentialsForUser(db: Database, uid: number) {
  return db
    .select()
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.uid, uid))
    .orderBy(desc(schema.webauthnCredentials.createdAt));
}

export async function countCredentialsForUser(db: Database, uid: number): Promise<number> {
  const rows = await listCredentialsForUser(db, uid);
  return rows.length;
}

export async function buildRegistrationOptions(opts: {
  db: Database;
  secret: string;
  rp: RelyingParty;
  uid: number;
  userName: string;
  userDisplayName: string;
}): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }> {
  const existing = await listCredentialsForUser(opts.db, opts.uid);
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw new Error(`最多可注册 ${MAX_PASSKEYS_PER_USER} 把通行密钥`);
  }

  const userID = new TextEncoder().encode(String(opts.uid));
  const options = await generateRegistrationOptions({
    rpName: opts.rp.rpName,
    rpID: opts.rp.rpID,
    userName: opts.userName,
    userDisplayName: opts.userDisplayName,
    userID,
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: parseTransports(row.transports),
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
      requireResidentKey: false,
    },
  });

  const challengeToken = await sealChallenge(opts.secret, 'reg', options.challenge, opts.uid);
  return { options, challengeToken };
}

export async function verifyAndStoreRegistration(opts: {
  db: Database;
  secret: string;
  rp: RelyingParty;
  uid: number;
  challengeToken: string;
  response: RegistrationResponseJSON;
  name?: string;
}): Promise<{ id: number }> {
  const sealed = await unsealChallenge(opts.secret, opts.challengeToken, 'reg');
  if (!sealed || sealed.u !== opts.uid) {
    throw new Error('通行密钥挑战无效或已过期，请重试');
  }

  const verification = await verifyRegistrationResponse({
    response: opts.response,
    expectedChallenge: sealed.c,
    expectedOrigin: opts.rp.origin,
    expectedRPID: opts.rp.rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('通行密钥注册验证失败');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const existing = await opts.db.query.webauthnCredentials.findFirst({
    where: eq(schema.webauthnCredentials.credentialId, credential.id),
  });
  if (existing) {
    throw new Error('此通行密钥已注册');
  }

  const now = Math.floor(Date.now() / 1000);
  const inserted = await opts.db.insert(schema.webauthnCredentials).values({
    uid: opts.uid,
    credentialId: credential.id,
    publicKey: bytesToBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ? JSON.stringify(credential.transports) : null,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp ? 1 : 0,
    name: (opts.name || '').trim().slice(0, 64) || '通行密钥',
    createdAt: now,
    lastUsedAt: now,
  }).returning({ id: schema.webauthnCredentials.id });

  const id = inserted[0]?.id;
  if (!id) throw new Error('保存通行密钥失败');
  return { id };
}

export async function buildAuthenticationOptions(opts: {
  db: Database;
  secret: string;
  rp: RelyingParty;
  /** When set, restrict to that user's credentials; otherwise discoverable. */
  uid?: number;
}): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string }> {
  let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] | undefined;
  if (opts.uid !== undefined) {
    const rows = await listCredentialsForUser(opts.db, opts.uid);
    if (rows.length === 0) {
      throw new Error('该账户尚未注册通行密钥');
    }
    allowCredentials = rows.map((row) => ({
      id: row.credentialId,
      transports: parseTransports(row.transports),
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID: opts.rp.rpID,
    userVerification: 'required',
    allowCredentials,
  });

  const challengeToken = await sealChallenge(
    opts.secret,
    'auth',
    options.challenge,
    opts.uid,
  );
  return { options, challengeToken };
}

export async function verifyAuthentication(opts: {
  db: Database;
  secret: string;
  rp: RelyingParty;
  challengeToken: string;
  response: AuthenticationResponseJSON;
}): Promise<{ uid: number; credentialRowId: number }> {
  const sealed = await unsealChallenge(opts.secret, opts.challengeToken, 'auth');
  if (!sealed) {
    throw new Error('通行密钥挑战无效或已过期，请重试');
  }

  const credentialId = opts.response.id;
  const row = await opts.db.query.webauthnCredentials.findFirst({
    where: eq(schema.webauthnCredentials.credentialId, credentialId),
  });
  if (!row) {
    throw new Error('未找到匹配的通行密钥');
  }
  if (sealed.u !== undefined && sealed.u !== row.uid) {
    throw new Error('通行密钥与用户不匹配');
  }

  const verification = await verifyAuthenticationResponse({
    response: opts.response,
    expectedChallenge: sealed.c,
    expectedOrigin: opts.rp.origin,
    expectedRPID: opts.rp.rpID,
    requireUserVerification: true,
    credential: {
      id: row.credentialId,
      publicKey: new Uint8Array(base64UrlToBytes(row.publicKey)),
      counter: row.counter,
      transports: parseTransports(row.transports),
    },
  });

  if (!verification.verified) {
    throw new Error('通行密钥验证失败');
  }

  const now = Math.floor(Date.now() / 1000);
  await opts.db.update(schema.webauthnCredentials).set({
    counter: verification.authenticationInfo.newCounter,
    lastUsedAt: now,
    backedUp: verification.authenticationInfo.credentialBackedUp ? 1 : 0,
    deviceType: verification.authenticationInfo.credentialDeviceType,
  }).where(eq(schema.webauthnCredentials.id, row.id));

  return { uid: row.uid, credentialRowId: row.id };
}

export async function deleteCredentialForUser(
  db: Database,
  uid: number,
  credentialRowId: number,
): Promise<boolean> {
  const row = await db.query.webauthnCredentials.findFirst({
    where: eq(schema.webauthnCredentials.id, credentialRowId),
  });
  if (!row || row.uid !== uid) return false;
  await db.delete(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.id, credentialRowId));
  return true;
}

export { MAX_PASSKEYS_PER_USER, CHALLENGE_TTL_MS };
