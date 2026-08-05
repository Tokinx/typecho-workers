import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import {
  getAuthCookies,
  getCookieValue,
  generateCommentToken,
  validateAuthToken,
  validateUnapprovedCommentToken,
} from '@/lib/auth';
import { getRequestCoreContextFromLocals } from '@/lib/context';
import {
  applyFilter,
  applyFilterSafely,
  parseActivatedPlugins,
  setActivatedPlugins,
  type HookContext,
} from '@/lib/plugin';
import { buildCommentPaginationSummary, loadCommentPage, loadPublicCommentPage } from '@/lib/comment-page';
import { buildCommentOptions, buildCommentTree, buildGravatarMap } from '@/lib/page-data';
import { jsonError, jsonOk } from '@/lib/http';
import { loadEarlyRequestSharedData } from '@/lib/early-request';
import type { CommentPagination } from '@/lib/comment-page';
import type { CommentNode } from '@/lib/theme-props';
import { appendClearedCommenterCookies, readRememberedCommenter } from '@/lib/commenter';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
};

type PublicCommentNode = Omit<CommentNode, 'mail' | 'children'> & {
  children: PublicCommentNode[];
};

interface CachedPublicCommentPage {
  comments: PublicCommentNode[];
  gravatarMap: Record<number, string>;
  pagination: CommentPagination;
}

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

  const { token } = getAuthCookies(request.headers.get('cookie'));
  const authResult = token && options.secret
    ? await validateAuthToken(token, options.secret, db)
    : null;
  const remembered = readRememberedCommenter(request.headers.get('cookie'));
  const commenter = authResult
    ? {
        loggedIn: true,
        author: authResult.user.screenName || authResult.user.name || '',
        mail: authResult.user.mail || '',
        url: authResult.user.url || '',
      }
    : {
        loggedIn: false,
        ...remembered.identity,
      };

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
      isLoggedIn: !!authResult,
      readOnly: true,
    });
  } catch (error) {
    console.error('[comments] comment:allowContent filter threw:', error);
    return jsonError(503, '评论暂时无法加载', PRIVATE_HEADERS);
  }
  if (!isPublicContent) return jsonError(404, '内容不存在', PRIVATE_HEADERS);

  const includeComments = url.searchParams.get('includeComments') !== '0';
  const loadPublicPage = async (): Promise<CachedPublicCommentPage> => {
    const commentPage = options.commentsPageBreak
      ? await loadPublicCommentPage(db, cid, options, request.url)
      : await loadCommentPage(db, cid, options, request.url);
    return {
      comments: redactCommentMail(buildCommentTree(commentPage.rows, options)),
      gravatarMap: options.commentsAvatar
        ? await buildGravatarMap(commentPage.rows, options.commentsAvatarRating || 'G')
        : {},
      pagination: commentPage.pagination,
    };
  };

  const cacheable = includeComments && isAnonymousCacheable(request);
  let cacheStatus: 'HIT' | 'MISS' | 'BYPASS' = 'BYPASS';
  let commentData: CachedPublicCommentPage;
  if (!includeComments) {
    commentData = {
      comments: [],
      gravatarMap: {},
      pagination: buildCommentPaginationSummary(options, request.url, content.commentsNum || 0),
    };
  } else if (cacheable) {
    let cacheMiss = false;
    commentData = await loadEarlyRequestSharedData(
      'comments',
      publicCommentCacheKey(cid, url),
      async () => {
        cacheMiss = true;
        return loadPublicPage();
      },
    );
    cacheStatus = cacheMiss ? 'MISS' : 'HIT';
  } else {
    const unapprovedToken = getCookieValue(
      request.headers.get('cookie'),
      '__typecho_unapproved_comment',
    );
    const visibleUnapprovedCommentId = options.secret
      ? await validateUnapprovedCommentToken(unapprovedToken, options.secret, cid)
      : null;
    const commentPage = visibleUnapprovedCommentId
      ? await loadCommentPage(db, cid, options, request.url, visibleUnapprovedCommentId)
      : options.commentsPageBreak
        ? await loadPublicCommentPage(db, cid, options, request.url)
        : await loadCommentPage(db, cid, options, request.url);
    commentData = {
      comments: redactCommentMail(buildCommentTree(commentPage.rows, options)),
      gravatarMap: options.commentsAvatar
        ? await buildGravatarMap(commentPage.rows, options.commentsAvatarRating || 'G')
        : {},
      pagination: commentPage.pagination,
    };
  }

  const filteredAvatarMap = await applyFilterSafely(pluginCtx, 'comment:avatarMap', commentData.gravatarMap, {
    request,
    options,
  });
  const publicAvatarMap = filteredAvatarMap && typeof filteredAvatarMap === 'object'
    ? filteredAvatarMap as Record<number, string>
    : commentData.gravatarMap;
  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret, cid)
    : '';
  const allowComment = content.allowComment === '1';

  const response = jsonOk({
    comments: commentData.comments,
    gravatarMap: publicAvatarMap,
    pagination: commentData.pagination,
    options: { ...buildCommentOptions(options, securityToken), allowComment },
    commenter,
  }, { ...PRIVATE_HEADERS, 'X-Typecho-Comment-Cache': includeComments ? cacheStatus : 'BYPASS' });
  if (remembered.invalidNames.length > 0) {
    appendClearedCommenterCookies(response.headers, request, remembered.invalidNames);
  }
  return response;
};

function redactCommentMail(comments: CommentNode[]): PublicCommentNode[] {
  return comments.map(({ mail: _mail, children, ...comment }) => ({
    ...comment,
    children: redactCommentMail(children),
  }));
}

function isAnonymousCacheable(request: Request): boolean {
  if (request.headers.get('authorization')) return false;
  if (request.headers.get('cookie')?.trim()) return false;
  const cacheControl = request.headers.get('cache-control')?.toLowerCase() || '';
  return !cacheControl.includes('no-cache') && !cacheControl.includes('no-store');
}

function publicCommentCacheKey(cid: number, url: URL): string {
  const rawPage = url.searchParams.get('commentPage');
  const commentPage = rawPage && /^\d{1,6}$/.test(rawPage) ? rawPage : null;
  return JSON.stringify([cid, commentPage]);
}
