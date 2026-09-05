import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/http';
import {
  deleteCredentialForUser,
  listCredentialsForUser,
} from '@/lib/webauthn';

function jsonAuthError(response: Response): Response {
  return jsonError(response.status, response.status === 401 ? 'Unauthorized' : 'Forbidden');
}

export const GET: APIRoute = async ({ request }) => {
  const ctx = await requireAdminAction(request, 'visitor', { csrf: false });
  if (isAdminActionResponse(ctx)) return jsonAuthError(ctx);

  const rows = await listCredentialsForUser(ctx.db, ctx.uid);
  return jsonOk({
    credentials: rows.map((row) => ({
      id: row.id,
      name: row.name || '通行密钥',
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      deviceType: row.deviceType,
      backedUp: !!row.backedUp,
    })),
  });
};

export const DELETE: APIRoute = async ({ request, url }) => {
  const ctx = await requireAdminAction(request, 'visitor');
  if (isAdminActionResponse(ctx)) return jsonAuthError(ctx);

  const id = parseInt(url.searchParams.get('id') || '0', 10);
  if (!id) return jsonError(400, '缺少 id 参数');

  const deleted = await deleteCredentialForUser(ctx.db, ctx.uid, id);
  if (!deleted) return jsonError(404, '通行密钥不存在');
  return jsonOk({ success: true });
};
