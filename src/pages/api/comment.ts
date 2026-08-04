import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import {
  generateUnapprovedCommentToken,
  getAuthCookies,
  shouldUseSecureCookie,
  timeSafeEqual,
  validateAuthToken,
  validateCommentToken,
} from '@/lib/auth';
import { setActivatedPlugins, parseActivatedPlugins, applyFilter, doHook, type HookContext } from '@/lib/plugin';
import { getClientIp, getRequestCoreContextFromLocals } from '@/lib/context';
import { normalizeHttpUrl } from '@/lib/url';
import { isSameOriginRequest } from '@/lib/admin-auth';
import { eq, and, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { jsonError } from '@/lib/http';
import { invalidatePublicCache } from '@/lib/cache';

export const POST: APIRoute = async ({ request, locals }) => {
  const wantsJson = request.headers.get('accept')?.includes('application/json') ?? false;
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);

  if (!isSameOriginRequest(request, options.siteUrl || '')) {
    return commentError(wantsJson, 403, 'Forbidden');
  }
  const requestReferer = request.headers.get('referer');
  if (requestReferer && !isTrustedCommentReferer(requestReferer, options.siteUrl || '')) {
    return commentError(wantsJson, 403, '评论来源页 URL 不合法');
  }

  // Load activated plugins
  const pluginCtx: HookContext = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) {
    const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
    await setActivatedPlugins(pluginCtx, activatedIds);
  }

  const formData = await request.formData();
  const cid = parseInt(formData.get('cid')?.toString() || '0', 10);
  const parent = parseInt(formData.get('parent')?.toString() || '0', 10);
  const text = formData.get('text')?.toString()?.trim() || '';
  let author = formData.get('author')?.toString()?.trim() || '';
  let mail = formData.get('mail')?.toString()?.trim() || '';
  let url = formData.get('url')?.toString()?.trim() || '';

  if (!cid || !text) {
    return commentError(wantsJson, 400, '评论内容不能为空');
  }

  // Limit comment text length
  if (text.length > 10000) {
    return commentError(wantsJson, 400, '评论内容过长');
  }

  // Content lookup and optional session validation are independent.
  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  const [content, authResult] = await Promise.all([
    db.query.contents.findFirst({ where: eq(schema.contents.cid, cid) }),
    token && options.secret
      ? validateAuthToken(token, options.secret, db)
      : Promise.resolve(null),
  ]);

  if (!content) {
    return commentError(wantsJson, 404, '文章不存在');
  }

  const corePublicContent =
    (content.type === 'post' || content.type === 'page') &&
    (content.status === 'publish' || content.status === 'hidden');
  let isPublicContent: boolean;
  try {
    isPublicContent = !!await applyFilter(pluginCtx, 'comment:allowContent', corePublicContent, {
      content,
      request,
      db,
      options,
      isLoggedIn: !!authResult,
    });
  } catch (error) {
    console.error('[comment] comment:allowContent filter threw:', error);
    return commentError(wantsJson, 503, '插件处理评论目标时出错，请稍后重试');
  }
  if (!isPublicContent) {
    return commentError(wantsJson, 403, '评论目标不可用');
  }

  if (content.allowComment !== '1') {
    return commentError(wantsJson, 403, '评论已关闭');
  }

  // Encrypted-post gate: allow commenting only when the submitter has
  // presented the correct password. The frontend post/page form injects
  // a hidden `password` field on the comment form so the same value that
  // decrypted the post authenticates the comment. Use a constant-time
  // comparator so response latency doesn't leak the stored password.
  if (content.password) {
    const suppliedPassword = formData.get('password')?.toString() || '';
    if (!timeSafeEqual(suppliedPassword, content.password)) {
      return commentError(wantsJson, 403, '评论加密文章需要正确密码');
    }
  }

  // Check if comments are auto-closed due to age
  if (options.commentsAutoClose && options.commentsPostTimeout && content.created) {
    const ageSeconds = Math.floor(Date.now() / 1000) - content.created;
    if (ageSeconds > options.commentsPostTimeout) {
      return commentError(wantsJson, 403, '评论已关闭（文章发布时间过长）');
    }
  }

  let userId = 0;
  let ownerId = content.authorId || 0;

  if (authResult) {
    userId = authResult.uid;
    author = authResult.user.screenName || authResult.user.name || author;
    mail = authResult.user.mail || mail;
    url = authResult.user.url || url;
  }

  // Validate for anonymous users
  if (!userId) {
    if (!author) {
      return commentError(wantsJson, 400, '请填写称呼');
    }
    if (options.commentsRequireMail && !mail) {
      return commentError(wantsJson, 400, '请填写邮箱');
    }
    if (options.commentsRequireURL && !url) {
      return commentError(wantsJson, 400, '请填写网站地址');
    }
    // Basic email format validation
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return commentError(wantsJson, 400, '邮箱格式不正确');
    }
  }

  if (url) {
    const normalizedUrl = normalizeHttpUrl(url);
    if (normalizedUrl === null) {
      return commentError(wantsJson, 400, '网站地址格式不正确');
    }
    url = normalizedUrl;
  }

  // Check referer URL matches the content's URL (anti-spam: ensure comment came from a real page view)
  if (options.commentsCheckReferer) {
    if (!isTrustedCommentReferer(request.headers.get('referer'), options.siteUrl || '')) {
      return commentError(wantsJson, 403, '评论来源页 URL 不合法');
    }
  }

  // Resolve client IP once — used for anti-spam rate-limit and stored with the comment
  const ip = getClientIp(request);

  // These moderation checks depend on normalized identity, but not on each
  // other. Execute only the enabled checks and share one latency wave.
  const [recentComment, approved, parentComment] = await Promise.all([
    options.commentsPostIntervalEnable && !userId
      ? db
      .select({ created: schema.comments.created })
      .from(schema.comments)
      .where(and(
        eq(schema.comments.cid, cid),
        eq(schema.comments.ip, ip)
      ))
      .orderBy(sql`${schema.comments.created} DESC`)
      .limit(1)
      : Promise.resolve([]),
    options.commentsWhitelist && !userId
      ? db.query.comments.findFirst({
          where: and(
            eq(schema.comments.mail, mail),
            eq(schema.comments.status, 'approved')
          ),
        })
      : Promise.resolve(null),
    parent > 0
      ? db.query.comments.findFirst({
          where: and(
            eq(schema.comments.coid, parent),
            eq(schema.comments.cid, cid)
          ),
        })
      : Promise.resolve(null),
  ]);

  if (options.commentsPostIntervalEnable && !userId && recentComment[0]) {
      const elapsed = Math.floor(Date.now() / 1000) - (recentComment[0].created || 0);
      if (elapsed < (options.commentsPostInterval || 60)) {
        return commentError(wantsJson, 429, `评论过于频繁，请等待 ${options.commentsPostInterval - elapsed} 秒后再试`);
      }
  }

  // Determine comment status
  let status = 'approved';
  if (options.commentsRequireModeration) {
    status = 'waiting';
  }
  if (options.commentsWhitelist && !userId) {
    if (!approved) {
      status = 'waiting';
    }
  }

  if (parent > 0 && !parentComment) {
    return commentError(wantsJson, 400, '父评论不存在');
  }

  const now = Math.floor(Date.now() / 1000);
  const agent = request.headers.get('user-agent') || '';

  // Insert comment
  let commentData: Record<string, unknown> = {
    cid,
    created: now,
    author,
    authorId: userId,
    ownerId,
    mail,
    url,
    ip,
    agent,
    text,
    type: 'comment',
    status,
    parent,
  };

  // CSRF: token must be present, cid-bound, and valid for the target
  // post — for both anonymous and logged-in commenters. The token is
  // generated per-cid at page render time, so cached HTML still works
  // as long as it belongs to the same post.
  if (options.commentsAntiSpam) {
    const submittedToken = formData.get('_')?.toString() || '';
    const valid = submittedToken
      ? await validateCommentToken(submittedToken, options.secret as string, cid)
      : false;
    if (!valid) {
      return commentError(wantsJson, 403, '评论来源验证失败');
    }
  }

  // Apply feedback:comment filter — plugins can modify/reject comment data before save.
  // G6-5: catch plugin failures and convert to a 403 reject reason
  // rather than letting them surface as a 500 to the commenter.
  try {
    commentData = await applyFilter(pluginCtx, 'feedback:comment', commentData, {
      request, formData, db, options, isLoggedIn: !!userId,
    });
  } catch (err) {
    console.error('[comment] feedback:comment filter threw:', err);
    return commentError(wantsJson, 503, '插件处理评论时出错，请稍后重试');
  }

  // Check if any plugin rejected the comment (e.g. captcha verification failed)
  if (commentData._rejected) {
    const reason = String(commentData._rejected);
    delete commentData._rejected;
    return commentError(wantsJson, 403, reason);
  }

  const finalStatus = commentData.status;
  if (finalStatus !== 'approved' && finalStatus !== 'waiting' && finalStatus !== 'spam') {
    return commentError(wantsJson, 400, '插件返回了无效的评论状态');
  }

  const writeStatements: any[] = [
    db.insert(schema.comments).values(commentData as any).returning({ coid: schema.comments.coid }),
  ];
  if (finalStatus === 'approved') {
    writeStatements.push(
      db.update(schema.contents)
        .set({ commentsNum: sql`${schema.contents.commentsNum} + 1` })
        .where(eq(schema.contents.cid, cid)),
    );
  }
  const [inserted] = await db.batch(writeStatements as [any, ...any[]]);
  if (!inserted.length) return commentError(wantsJson, 500, '评论保存失败');
  const newCoid = inserted[0].coid;
  commentData.coid = newCoid;
  if (finalStatus === 'approved') {
    await invalidatePublicCache(db, { reason: 'comment-visible', domains: [], sharedDomains: ['sidebar', 'comments', 'notes'] });
  }

  // Trigger feedback:finishComment hook — plugins can act after comment saved
  // (e.g. email notifications); fire-and-forget via waitUntil.
  const finishP = doHook(pluginCtx, 'feedback:finishComment', commentData, {
    request,
    options,
    db,
    siteUrl: (options.siteUrl as string) || '',
    permalinkPattern: options.permalinkPattern as string | undefined,
    pagePattern: options.pagePattern as string | undefined,
  });
  if (locals.cfContext?.waitUntil) {
    locals.cfContext.waitUntil(finishP);
  }

  // Redirect back to the post
  // Prevent open redirect: only use referer if it's a relative path or same-origin
  let redirectUrl = `/archives/${cid}/#comment-${newCoid}`;
  const referer = requestReferer;
  if (referer) {
    redirectUrl = safeCommentRedirectUrl(referer, options.siteUrl || '', request.url, redirectUrl, newCoid);
  }
  const headers = new Headers({ Location: redirectUrl });
  if (finalStatus !== 'approved' && options.secret) {
    const token = await generateUnapprovedCommentToken(options.secret as string, cid, newCoid);
    const secureFlag = shouldUseSecureCookie(request) ? '; Secure' : '';
    headers.append('Set-Cookie', `__typecho_unapproved_comment=${encodeURIComponent(token)}; Path=/; HttpOnly${secureFlag}; SameSite=Lax`);
  }
  if (wantsJson) {
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({
      success: true,
      coid: newCoid,
      status: finalStatus,
      location: redirectUrl,
    }), { status: 201, headers });
  }
  return new Response(null, {
    status: 302,
    headers,
  });
};

function commentError(wantsJson: boolean, status: number, message: string): Response {
  return wantsJson ? jsonError(status, message) : new Response(message, { status });
}

function isTrustedCommentReferer(referer: string | null, siteUrl: string): boolean {
  if (!referer || !siteUrl) return false;
  try {
    return new URL(referer).origin === new URL(siteUrl).origin;
  } catch {
    return false;
  }
}

function safeCommentRedirectUrl(
  referer: string,
  siteUrl: string,
  requestUrl: string,
  fallback: string,
  coid: number,
): string {
  try {
    const refUrl = new URL(referer);
    const trustedOrigins = new Set([new URL(requestUrl).origin]);
    if (siteUrl) trustedOrigins.add(new URL(siteUrl).origin);
    if (!trustedOrigins.has(refUrl.origin)) return fallback;
    return `${refUrl.pathname}${refUrl.search}#comment-${coid}`;
  } catch {
    return fallback;
  }
}
