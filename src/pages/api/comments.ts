import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getCookieValue, generateCommentToken, validateUnapprovedCommentToken } from '@/lib/auth';
import { getRequestCoreContextFromLocals } from '@/lib/context';
import {
  applyFilter,
  applyFilterSafely,
  parseActivatedPlugins,
  setActivatedPlugins,
  type HookContext,
} from '@/lib/plugin';
import { loadCommentPage } from '@/lib/comment-page';
import { buildCommentOptions, buildCommentTree, buildGravatarMap } from '@/lib/page-data';
import { jsonError, jsonOk } from '@/lib/http';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
};

export const GET: APIRoute = async ({ request, locals, url }) => {
  const cid = Number.parseInt(url.searchParams.get('cid') || '0', 10);
  if (!Number.isSafeInteger(cid) || cid <= 0) {
    return jsonError(400, 'cid 参数无效', PRIVATE_HEADERS);
  }

  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  const pluginCtx: HookContext = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) {
    await setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins));
  }

  const content = await db.query.contents.findFirst({ where: eq(schema.contents.cid, cid) });
  if (!content) return jsonError(404, '内容不存在', PRIVATE_HEADERS);

  const now = Math.floor(Date.now() / 1000);
  const corePublicContent =
    (content.type === 'post' || content.type === 'page') &&
    (content.status === 'publish' || content.status === 'hidden') &&
    (content.created || 0) <= now;
  let isPublicContent = false;
  try {
    isPublicContent = !!await applyFilter(pluginCtx, 'comment:allowContent', corePublicContent, {
      content,
      request,
      db,
      options,
      isLoggedIn: false,
      readOnly: true,
    });
  } catch (error) {
    console.error('[comments] comment:allowContent filter threw:', error);
    return jsonError(503, '评论暂时无法加载', PRIVATE_HEADERS);
  }
  if (!isPublicContent) return jsonError(404, '内容不存在', PRIVATE_HEADERS);

  const unapprovedToken = getCookieValue(
    request.headers.get('cookie'),
    '__typecho_unapproved_comment',
  );
  const visibleUnapprovedCommentId = options.secret
    ? await validateUnapprovedCommentToken(unapprovedToken, options.secret, cid)
    : null;
  const commentPage = await loadCommentPage(db, cid, options, request.url, visibleUnapprovedCommentId);
  const comments = redactCommentMail(buildCommentTree(commentPage.rows, options));
  const gravatarMap = options.commentsAvatar
    ? await buildGravatarMap(commentPage.rows, options.commentsAvatarRating || 'G')
    : {};
  const filteredAvatarMap = await applyFilterSafely(pluginCtx, 'comment:avatarMap', gravatarMap, {
    request,
    options,
  });
  const publicAvatarMap = filteredAvatarMap && typeof filteredAvatarMap === 'object'
    ? filteredAvatarMap as Record<number, string>
    : gravatarMap;
  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret, cid)
    : '';
  const allowComment = content.allowComment === '1';

  return jsonOk({
    comments,
    gravatarMap: publicAvatarMap,
    pagination: commentPage.pagination,
    options: { ...buildCommentOptions(options, securityToken), allowComment },
  }, PRIVATE_HEADERS);
};

function redactCommentMail<T extends { mail: string; children: T[] }>(comments: T[]): Array<Omit<T, 'mail' | 'children'> & { children: ReturnType<typeof redactCommentMail<T>> }> {
  return comments.map(({ mail: _mail, children, ...comment }) => ({
    ...comment,
    children: redactCommentMail(children),
  }));
}
