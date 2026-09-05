import type { APIRoute } from 'astro';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/http';
import {
  resolveRelyingParty,
  verifyAndStoreRegistration,
} from '@/lib/webauthn';

function jsonAuthError(response: Response): Response {
  return jsonError(response.status, response.status === 401 ? 'Unauthorized' : 'Forbidden');
}

export const POST: APIRoute = async ({ request }) => {
  const ctx = await requireAdminAction(request, 'visitor');
  if (isAdminActionResponse(ctx)) return jsonAuthError(ctx);

  const rp = resolveRelyingParty(ctx.options.siteUrl, ctx.options.title || 'Typecho');
  if (!rp) {
    return jsonError(500, '站点 URL 未配置，无法使用通行密钥');
  }

  let body: { challengeToken?: string; response?: RegistrationResponseJSON; name?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, '无效的请求体');
  }

  if (!body.challengeToken || !body.response) {
    return jsonError(400, '缺少 challengeToken 或 response');
  }

  try {
    const result = await verifyAndStoreRegistration({
      db: ctx.db,
      secret: ctx.options.secret,
      rp,
      uid: ctx.uid,
      challengeToken: body.challengeToken,
      response: body.response,
      name: body.name,
    });
    return jsonOk({ id: result.id, success: true });
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : '通行密钥注册失败');
  }
};
