import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@/db';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { getModeratableComment } from '@/lib/comment-moderation';
import { getClientIp } from '@/lib/context';
import { jsonError, jsonOk } from '@/lib/http';
import { isValidEmail } from '@/lib/mail';
import { renderCommentText, stripHtmlTags } from '@/lib/markdown';
import { doHook } from '@/lib/plugin';
import { normalizeHttpUrl } from '@/lib/url';
import { invalidatePublicCache } from '@/lib/cache';

const MAX_COMMENT_TEXT_LENGTH = 10_000;
const MAX_AUTHOR_LENGTH = 200;
const MAX_MAIL_LENGTH = 320;

function parseCoid(value: FormDataEntryValue | null): number {
  const coid = Number.parseInt(value?.toString() || '', 10);
  return Number.isSafeInteger(coid) && coid > 0 ? coid : 0;
}

function editableComment(
  comment: typeof schema.comments.$inferSelect,
  options: { commentsMarkdown: number; commentsHTMLTagAllowed: string | null },
) {
  const text = comment.text || '';
  return {
    coid: comment.coid,
    cid: comment.cid,
    author: comment.author || '',
    mail: comment.mail || '',
    url: comment.url || '',
    text,
    html: renderCommentText(text, {
      markdown: !!options.commentsMarkdown,
      htmlTagAllowed: options.commentsHTMLTagAllowed,
    }),
    type: comment.type || 'comment',
    status: comment.status || 'approved',
    parent: comment.parent || 0,
    created: comment.created || 0,
  };
}

export const GET: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, 'contributor', { csrf: false });
  if (isAdminActionResponse(auth)) return auth;

  const coid = parseCoid(new URL(request.url).searchParams.get('coid'));
  if (!coid) return jsonError(400, '评论参数无效');

  const comment = await getModeratableComment(auth.db, coid, auth.user);
  if (comment instanceof Response) return comment;

  return jsonOk({ comment: editableComment(comment, auth.options) });
};

export const POST: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await request.formData();
  const action = formData.get('action')?.toString() || '';
  const coid = parseCoid(formData.get('coid'));
  if (!coid || (action !== 'edit' && action !== 'reply')) {
    return jsonError(400, '评论操作无效');
  }

  const parentComment = await getModeratableComment(auth.db, coid, auth.user);
  if (parentComment instanceof Response) return parentComment;

  const text = formData.get('text')?.toString().trim() || '';
  if (!text) return jsonError(400, '评论内容不能为空');
  if (text.length > MAX_COMMENT_TEXT_LENGTH) return jsonError(400, '评论内容过长');

  if (action === 'edit') {
    const author = stripHtmlTags(formData.get('author')?.toString() || '');
    const mail = stripHtmlTags(formData.get('mail')?.toString() || '');
    const rawUrl = formData.get('url')?.toString() || '';
    if (author.length > MAX_AUTHOR_LENGTH) return jsonError(400, '用户名过长');
    if (mail.length > MAX_MAIL_LENGTH || (mail && !isValidEmail(mail))) {
      return jsonError(400, '邮箱格式不正确');
    }
    const url = normalizeHttpUrl(rawUrl);
    if (url === null) return jsonError(400, '网站地址格式不正确');

    await auth.db.update(schema.comments)
      .set({ author, mail, url, text })
      .where(eq(schema.comments.coid, parentComment.coid));

    const updated = await auth.db.query.comments.findFirst({
      where: eq(schema.comments.coid, parentComment.coid),
    });
    if (!updated) return jsonError(500, '更新评论失败');
    await invalidatePublicCache(auth.db, {
      reason: 'comment-edit',
      domains: [],
      sharedDomains: ['sidebar', 'comments', 'notes', 'content', 'admin-dashboard', 'admin-content', 'admin-comments'],
    });

    return jsonOk({ comment: editableComment(updated, auth.options) });
  }

  if (parentComment.status !== 'approved' || parentComment.type !== 'comment') {
    return jsonError(400, '只能回复已通过的普通评论');
  }

  const cid = Number(parentComment.cid) || 0;
  if (!cid) return jsonError(404, '文章不存在');

  const content = await auth.db.query.contents.findFirst({
    columns: {
      cid: true,
      title: true,
      slug: true,
      type: true,
      created: true,
      authorId: true,
    },
    where: eq(schema.contents.cid, cid),
  });
  if (!content) return jsonError(404, '文章不存在');

  const now = Math.floor(Date.now() / 1000);
  const reply = {
    cid,
    created: now,
    author: auth.user.screenName || auth.user.name || '',
    authorId: auth.user.uid,
    ownerId: content.authorId || 0,
    mail: auth.user.mail || '',
    url: auth.user.url || '',
    ip: getClientIp(request),
    agent: request.headers.get('user-agent') || '',
    text,
    type: 'comment',
    status: 'approved',
    parent: parentComment.coid,
  } as const;

  const [inserted] = await auth.db.batch([
    auth.db.insert(schema.comments).values(reply).returning({ coid: schema.comments.coid }),
    auth.db.update(schema.contents)
      .set({ commentsNum: sql`${schema.contents.commentsNum} + 1` })
      .where(eq(schema.contents.cid, cid)),
  ] as [any, any]);
  const replyCoid = inserted[0]?.coid;
  if (!replyCoid) return jsonError(500, '回复评论失败');

  const savedReply = { ...reply, coid: replyCoid };
  const hookExtra = {
    request,
    options: auth.options,
    db: auth.db,
    siteUrl: (auth.options.siteUrl as string) || '',
    permalinkPattern: auth.options.permalinkPattern as string | undefined,
    pagePattern: auth.options.pagePattern as string | undefined,
  };
  await doHook(auth.pluginCtx, 'feedback:reply', savedReply, parentComment, hookExtra);
  await doHook(auth.pluginCtx, 'feedback:finishComment', savedReply, hookExtra);
  await invalidatePublicCache(auth.db, {
    reason: 'comment-reply',
    domains: [],
    sharedDomains: ['sidebar', 'comments', 'notes', 'content', 'admin-dashboard', 'admin-content', 'admin-comments'],
  });
  return jsonOk({ comment: editableComment(savedReply, auth.options) });
};
