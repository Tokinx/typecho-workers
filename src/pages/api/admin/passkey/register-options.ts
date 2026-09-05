import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/http';
import {
  buildRegistrationOptions,
  resolveRelyingParty,
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

  try {
    const { options, challengeToken } = await buildRegistrationOptions({
      db: ctx.db,
      secret: ctx.options.secret,
      rp,
      uid: ctx.uid,
      userName: ctx.user.name || `user-${ctx.uid}`,
      userDisplayName: ctx.user.screenName || ctx.user.name || `user-${ctx.uid}`,
    });
    return jsonOk({ options, challengeToken });
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : '无法开始通行密钥注册');
  }
};
