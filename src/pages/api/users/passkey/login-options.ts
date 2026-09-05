import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { isSameOriginRequest } from '@/lib/admin-auth';
import { getClientIp, getRequestCoreContextFromLocals } from '@/lib/context';
import { jsonError, jsonOk } from '@/lib/http';
import {
  loginLockedUntil,
  readLoginRateLimitConfig,
  recordLoginFailure,
} from '@/lib/login-rate-limit';
import {
  buildAuthenticationOptions,
  resolveRelyingParty,
} from '@/lib/webauthn';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);

  if (!isSameOriginRequest(request, options.siteUrl)) {
    return jsonError(403, 'Forbidden');
  }

  const rp = resolveRelyingParty(options.siteUrl, options.title || 'Typecho');
  if (!rp || !options.secret) {
    return jsonError(500, '站点未正确配置');
  }

  const rateConfig = readLoginRateLimitConfig(options as unknown as Record<string, unknown>);
  const ip = getClientIp(request);
  const lockedUntil = await loginLockedUntil(db, ip, rateConfig);
  if (lockedUntil > 0) {
    const remaining = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
    return jsonError(429, `登录失败次数过多，请 ${remaining} 秒后再试`, {
      'Retry-After': String(remaining),
    });
  }

  let body: { name?: string } = {};
  try {
    if (request.headers.get('content-type')?.includes('application/json')) {
      body = await request.json();
    }
  } catch {
    return jsonError(400, '无效的请求体');
  }

  let uid: number | undefined;
  const name = body.name?.trim() || '';
  if (name) {
    let user = await db.query.users.findFirst({ where: eq(schema.users.name, name) });
    if (!user && name.includes('@')) {
      user = await db.query.users.findFirst({ where: eq(schema.users.mail, name) });
    }
    if (!user) {
      // Do not reveal whether the account exists; still spend a bit of work
      // and record a failure so enumeration via options is rate-limited.
      await recordLoginFailure(db, ip, rateConfig);
      return jsonError(400, '无法使用通行密钥登录');
    }
    uid = user.uid;
  }

  try {
    const { options: webauthnOptions, challengeToken } = await buildAuthenticationOptions({
      db,
      secret: options.secret,
      rp,
      uid,
    });
    return jsonOk({ options: webauthnOptions, challengeToken });
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : '无法开始通行密钥登录');
  }
};
