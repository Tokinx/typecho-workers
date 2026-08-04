import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import {
  applyCommentActions,
  commentActionAffectsPublicCache,
  deleteSpamCommentsForUser,
  getModeratableComments,
  normalizeCommentAction,
  purgeCommentModerationCache,
} from '@/lib/comment-moderation';

export const GET: APIRoute = async () =>
  new Response('Method Not Allowed', { status: 405 });
export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const action = url.searchParams.get('do') || '';

  // Special action: delete all spam
  if (action === 'delete-spam') {
    await deleteSpamCommentsForUser(auth.db, auth.user);

    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      '/admin/manage-comments?status=spam',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  const normalizedAction = normalizeCommentAction(action);
  if (!normalizedAction) return new Response('Invalid action', { status: 400 });

  // Get selected coids from form body
  let coids: number[] = [];
  if (request.method === 'POST') {
    const formData = await request.formData();
    coids = [...new Set(
      formData.getAll('coid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean),
    )];
  }

  if (coids.length === 0) {
    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      '/admin/manage-comments',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  const pluginCtx = auth.pluginCtx;

  const comments = await getModeratableComments(auth.db, coids, auth.user);
  if (comments instanceof Response) return comments;
  await applyCommentActions(pluginCtx, auth.db, comments, normalizedAction, auth.options);

  if (comments.some(comment => commentActionAffectsPublicCache(comment, normalizedAction))) {
    await purgeCommentModerationCache(auth.db, auth.options);
  }

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/manage-comments',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
