import type { APIRoute } from 'astro';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { generateAuthToken, generateRandomString, setAuthCookieHeaders } from '@/lib/auth';
import { isSameOriginRequest, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { getClientIp, getRequestCoreContextFromLocals } from '@/lib/context';
import { jsonError, jsonOk } from '@/lib/http';
import {
  clearLoginFailures,
  loginLockedUntil,
  readLoginRateLimitConfig,
  recordLoginFailure,
} from '@/lib/login-rate-limit';
import {
  resolveRelyingParty,
  verifyAuthentication,
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

  let body: {
    challengeToken?: string;
    response?: AuthenticationResponseJSON;
    remember?: boolean;
    referer?: string;
  };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, '无效的请求体');
  }

  if (!body.challengeToken || !body.response) {
    return jsonError(400, '缺少 challengeToken 或 response');
  }

  let verified: { uid: number };
  try {
    verified = await verifyAuthentication({
      db,
      secret: options.secret,
      rp,
      challengeToken: body.challengeToken,
      response: body.response,
    });
  } catch (error) {
    await recordLoginFailure(db, ip, rateConfig);
    return jsonError(401, error instanceof Error ? error.message : '通行密钥登录失败');
  }

  const user = await db.query.users.findFirst({
    where: eq(schema.users.uid, verified.uid),
  });
  if (!user) {
    await recordLoginFailure(db, ip, rateConfig);
    return jsonError(401, '用户不存在');
  }

  await clearLoginFailures(db, ip);

  const newAuthCode = generateRandomString(32);
  await db
    .update(schema.users)
    .set({
      authCode: newAuthCode,
      logged: Math.floor(Date.now() / 1000),
    })
    .where(eq(schema.users.uid, user.uid));

  const hash = await generateAuthToken(user.uid, newAuthCode, options.secret);
  const token = hash.split(':')[1];
  const cookieHeaders = setAuthCookieHeaders(
    user.uid,
    token,
    body.remember ? 30 * 24 * 3600 : 0,
    request,
  );

  const refererInput = body.referer || '/admin/';
  const refererAbsolute = (() => {
    if (!options.siteUrl) return refererInput;
    try { return new URL(refererInput, options.siteUrl).toString(); } catch { return options.siteUrl; }
  })();
  const redirect = safeAdminRedirectUrl(refererAbsolute, options.siteUrl || '', '/admin/');

  const response = jsonOk({ success: true, redirect });
  const out = new Headers(response.headers);
  for (const cookie of cookieHeaders) {
    out.append('Set-Cookie', cookie);
  }
  return new Response(response.body, { status: 200, headers: out });
};
