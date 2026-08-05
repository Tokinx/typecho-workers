/**
 * Page data preparation layer
 *
 * Extracts DB queries from .astro page files into pure TypeScript functions.
 * Each function returns a standardized Props object for theme components.
 * This separation allows theme components to be purely presentational.
 */
import { eq, and, desc, asc, lt, gt, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import type { SiteOptions } from '@/lib/options';
import { loadSidebarData, loadNavPages } from '@/lib/sidebar';
import {
  buildPermalink, buildAuthorLink,
  buildCategoryLink, buildTagLink, buildSearchLink,
} from '@/lib/content';
import { renderCommentText, renderContentExcerpt, renderMarkdownFiltered } from '@/lib/markdown';
import { paginate, paginateLookahead } from '@/lib/pagination';
import { generateCommentToken, validateUnapprovedCommentToken } from '@/lib/auth';
import { buildGravatarUrl } from '@/lib/gravatar';
import { buildCommentPaginationSummary, loadCommentPage, type CommentPage } from '@/lib/comment-page';
import type { RequestContext } from '@/lib/context';
import { canViewContent, publishedPostCondition } from '@/lib/content-visibility';
import type {
  ThemeIndexProps, ThemePostProps, ThemePageProps, ThemeArchiveProps, ThemeNotFoundProps,
  PostListItem, CommentNode, CommentOptions,
} from '@/lib/theme-props';
import { getActiveTheme } from '@/lib/theme';
import { loadQueryCache } from '@/lib/query-cache';
import { sqlInChunks } from '@/lib/d1-in';

const MAX_SEARCH_PATTERN_BYTES = 50;

export function decodeSearchKeywords(value: string | undefined): { value: string; malformed: boolean } {
  try {
    return { value: decodeURIComponent(value || ''), malformed: false };
  } catch {
    return { value: '', malformed: true };
  }
}

/** Keep the complete `%keyword%` LIKE pattern within the D1 byte budget. */
export function truncateSearchKeyword(value: string, maxPatternBytes = MAX_SEARCH_PATTERN_BYTES): string {
  const maxKeywordBytes = Math.max(0, maxPatternBytes - 2);
  const encoder = new TextEncoder();
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxKeywordBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

// ─── Local row types (derived from Drizzle schema) ───────────────────────

type ContentRow = typeof schema.contents.$inferSelect;
type PublicArchivePostRow = Pick<ContentRow,
  'cid' | 'title' | 'slug' | 'type' | 'text' | 'created' | 'commentsNum' | 'authorId'>;
type CommentRow = typeof schema.comments.$inferSelect;
type MetaRow = typeof schema.metas.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;
type CategoryEntry = { name: string; slug: string; permalink: string };
type CategoryMap = Map<number, CategoryEntry[]>;
type AuthorEntry = { uid: number; name: string | null; screenName: string | null };
type AuthorMap = Map<number, AuthorEntry>;

// ─── Helpers ────────────────────────────────────────────────────────────

async function loadCommon(ctx: RequestContext, requestUrl: string) {
  const { db, options, urls, user, isLoggedIn } = ctx;
  const [sidebarData, pages] = await Promise.all([
    loadSidebarData(
      ctx,
      db,
      urls.siteUrl,
      options.permalinkPattern as string | undefined,
      options.categoryPattern as string | undefined,
      options.cacheVersion,
    ),
    loadNavPages(db, urls.siteUrl, options.pagePattern as string | undefined, options.cacheVersion),
  ]);
  const currentPath = new URL(requestUrl).pathname;
  return { options, urls, user, isLoggedIn, pages, sidebarData, currentPath, pluginCtx: ctx };
}

async function loadThemeCommentPage(
  db: Database,
  options: SiteOptions,
  cid: number,
  totalComments: number,
  requestUrl: string,
  unapprovedCommentToken?: string | null,
): Promise<CommentPage> {
  const theme = getActiveTheme(String(options.theme || 'typecho-theme-warm'));
  if (theme.manifest.commentsMode === 'api') {
    return {
      rows: [],
      pagination: buildCommentPaginationSummary(options, requestUrl, totalComments),
    };
  }
  const visibleUnapprovedCommentId = options.secret
    ? await validateUnapprovedCommentToken(unapprovedCommentToken, options.secret as string, cid)
    : null;
  return loadCommentPage(db, cid, options, requestUrl, visibleUnapprovedCommentId);
}

function getPage(locals: Record<string, unknown>, url: URL): number {
  const raw = (locals as { _page?: number })._page ?? url.searchParams.get('page');
  return raw ? (typeof raw === 'number' ? raw : parseInt(raw, 10) || 1) : 1;
}

export function buildCommentTree(allComments: CommentRow[], options: SiteOptions): CommentNode[] {
  const map = new Map<number, CommentNode>();
  const roots: CommentNode[] = [];

  for (const c of allComments) {
    map.set(c.coid, {
      coid: c.coid,
      author: c.author || '匿名',
      mail: c.mail || '',
      url: c.url || '',
      status: c.status === 'waiting' || c.status === 'spam' ? c.status : 'approved',
      text: renderCommentText(c.text || '', {
        markdown: !!options.commentsMarkdown,
        htmlTagAllowed: options.commentsHTMLTagAllowed,
      }),
      created: c.created || 0,
      children: [],
    });
  }

  if (!options.commentsThreaded) {
    return allComments.map(comment => map.get(comment.coid)!);
  }

  for (const c of allComments) {
    const node = map.get(c.coid)!;
    if (c.parent && map.has(c.parent)) {
      map.get(c.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export async function buildGravatarMap(allComments: CommentRow[], avatarRating: string): Promise<Record<number, string>> {
  const urlsByEmail = new Map<string, Promise<string>>();
  const entries = await Promise.all(
    allComments.map(async (c) => {
      const email = (c.mail || '').trim().toLowerCase();
      let pending = urlsByEmail.get(email);
      if (!pending) {
        pending = buildGravatarUrl(email, {
          defaultImage: 'identicon',
          size: 40,
          rating: avatarRating,
        });
        urlsByEmail.set(email, pending);
      }
      return [c.coid, await pending] as const;
    })
  );
  return Object.fromEntries(entries);
}

export function buildCommentOptions(options: SiteOptions, securityToken: string): CommentOptions {
  return {
    allowComment: true,
    requireMail: !!options.commentsRequireMail,
    requireUrl: !!options.commentsRequireURL,
    showUrl: !!options.commentsShowUrl,
    showAvatar: !!options.commentsAvatar,
    avatarRating: options.commentsAvatarRating || 'G',
    order: options.commentsOrder === 'DESC' ? 'DESC' : 'ASC',
    dateFormat: options.commentDateFormat || 'Y-m-d H:i',
    timezone: options.timezone || 28800,
    securityToken,
    showCommentOnly: !!options.commentsShowCommentOnly,
    markdown: !!options.commentsMarkdown,
    urlNofollow: !!options.commentsUrlNofollow,
    threaded: !!options.commentsThreaded,
    maxNestingLevels: Number(options.commentsMaxNestingLevels) || 2,
    pageBreak: !!options.commentsPageBreak,
    pageSize: Number(options.commentsPageSize) || 20,
    pageDisplay: (options.commentsPageDisplay === 'first' ? 'first' : 'last') as 'first' | 'last',
    htmlTagAllowed: options.commentsHTMLTagAllowed || '',
  };
}

async function fetchAuthors(db: Database, authorIds: number[]): Promise<AuthorMap> {
  if (authorIds.length === 0) return new Map();
  const authors = await db
    .select({
      uid: schema.users.uid,
      name: schema.users.name,
      screenName: schema.users.screenName,
    })
    .from(schema.users)
    .where(sqlInChunks(schema.users.uid, authorIds));
  return new Map(authors.map(a => [a.uid, a]));
}

function mapPostCategories(
  rows: Array<{ cid: number; mid: number; name: string | null; slug: string | null }>,
  siteUrl: string,
  categoryPattern?: string | null,
): CategoryMap {
  const map: CategoryMap = new Map();
  for (const row of rows) {
    const cid = Number(row.cid);
    if (!Number.isSafeInteger(cid)) continue;
    if (!map.has(cid)) map.set(cid, []);
    map.get(cid)!.push({
      name: row.name || '',
      slug: row.slug || '',
      permalink: buildCategoryLink(row.slug || '', siteUrl, categoryPattern),
    });
  }
  return map;
}

function toPostListItem(
  post: PublicArchivePostRow,
  authorMap: AuthorMap,
  categoryMap: CategoryMap,
  siteUrl: string,
  permalinkPattern?: string | null,
): PostListItem {
  const author = authorMap.get(post.authorId || 0);
  const cid = Number(post.cid);
  const categories = categoryMap.get(cid) || [];
  const permalink = buildPermalink(
    { cid: post.cid, slug: post.slug, type: post.type, created: post.created, category: categories[0]?.slug },
    siteUrl,
    permalinkPattern,
  );
  return {
    cid: post.cid,
    title: post.title || '无标题',
    permalink,
    excerpt: renderContentExcerpt(post.text || '', '- 阅读剩余部分 -', permalink),
    created: post.created || 0,
    commentsNum: post.commentsNum || 0,
    author: author ? { uid: author.uid, name: author.name || '', screenName: author.screenName || author.name || '' } : null,
    categories,
  };
}

// ─── Shared archive query ───────────────────────────────────────────────
// All five list pages (index, category, tag, author, search) share this
// pattern: pageSize + 1 query → batch fetch authors+categories → map.
// Public archives deliberately do not count every matching row just to
// produce numeric page links.

interface ArchiveParams {
  archiveTitle: string;
  archiveType: 'index' | 'category' | 'tag' | 'author' | 'search';
  baseUrl: string;
  /** Additional WHERE conditions beyond type='post' + status='publish' */
  extraWhere?: ReturnType<typeof sql>;
  /** If set, INNER JOIN relationships and filter on this meta ID */
  joinMid?: number;
  authorOverride?: AuthorMap;
  /** A theme-owned stream will decide whether an empty page is out of range. */
  allowEmptyPage?: boolean;
}

async function prepareArchiveData(
  ctx: RequestContext,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  params: ArchiveParams,
): Promise<ThemeArchiveProps | Response> {
  const { db, options, urls } = ctx;
  const commonPromise = loadCommon(ctx, requestUrl);
  const page = getPage(locals, url);
  const pageSize = Math.max(1, Math.floor(Number(options.pageSize) || 5));

  // G7-5: every archive (index, category, tag, author, search) hides
  // posts whose `created` is in the future. The legacy code only
  // filtered the index page, leaking scheduled posts via category/tag
  // archives.
  const baseConditions = [
    publishedPostCondition(),
  ];
  if (params.extraWhere) baseConditions.push(params.extraWhere);

  const hasJoin = params.joinMid !== undefined;

  const countWhere = hasJoin
    ? and(eq(schema.relationships.mid, params.joinMid!), ...baseConditions)
    : and(...baseConditions);

  const publicPostColumns = {
    cid: schema.contents.cid,
    title: schema.contents.title,
    slug: schema.contents.slug,
    type: schema.contents.type,
    text: schema.contents.text,
    created: schema.contents.created,
    commentsNum: schema.contents.commentsNum,
    authorId: schema.contents.authorId,
  };
  type ArchiveListRows = PublicArchivePostRow[] | Array<{ content: PublicArchivePostRow }>;
  const makeListStatement = async (offset: number): Promise<ArchiveListRows> => {
    if (hasJoin) {
      return db.select({ content: publicPostColumns }).from(schema.contents)
        .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
        .where(countWhere)
        .orderBy(desc(schema.contents.created))
        .limit(pageSize + 1)
        .offset(offset);
    }
    return db.select(publicPostColumns).from(schema.contents)
      .where(countWhere)
      .orderBy(desc(schema.contents.created))
      .limit(pageSize + 1)
      .offset(offset);
  };

  const requestedPage = Math.max(1, Math.floor(page));
  const queryKey = {
    type: params.archiveType,
    page: requestedPage,
    pageSize,
    joinMid: params.joinMid ?? null,
    baseUrl: params.archiveType === 'author' ? params.baseUrl : undefined,
  };
  const initialPostsPromise = params.archiveType === 'search'
    ? makeListStatement((requestedPage - 1) * pageSize)
    : loadQueryCache(ctx, { domain: 'archive', key: queryKey }, () =>
      makeListStatement((requestedPage - 1) * pageSize),
    );
  const [common, initialPosts] = await Promise.all([
    commonPromise,
    initialPostsPromise,
  ]);
  const posts = initialPosts.slice(0, pageSize);

  // The first empty page keeps the normal empty-state UI. Any later empty
  // page is outside the stream and must not silently clamp to the last page.
  if (requestedPage > 1 && posts.length === 0 && !params.allowEmptyPage) {
    return new Response('Not Found', { status: 404 });
  }
  const pg = paginateLookahead(requestedPage, pageSize, params.baseUrl, initialPosts.length > pageSize);

  const rawPosts: PublicArchivePostRow[] = hasJoin
    ? (posts as { content: PublicArchivePostRow }[]).map(p => p.content)
    : (posts as PublicArchivePostRow[]);
  const authorIds = [...new Set(rawPosts.map(p => p.authorId).filter((id): id is number => Boolean(id)))];
  const postIds = rawPosts.map(p => p.cid).filter((id): id is number => id !== null);

  let authorMap = params.authorOverride;
  let categoryRows: Array<{ cid: number; mid: number; name: string | null; slug: string | null }> = [];
  if (postIds.length > 0) {
    const categoryStatement = db
      .select({
        cid: schema.relationships.cid,
        mid: schema.relationships.mid,
        name: schema.metas.name,
        slug: schema.metas.slug,
      })
      .from(schema.relationships)
      .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
      .where(
        and(
          sqlInChunks(schema.relationships.cid, postIds),
          eq(schema.metas.type, 'category')
        )
      );

    if (authorMap || authorIds.length === 0) {
      categoryRows = await categoryStatement;
    } else {
      const [authors, categories] = await db.batch([
        db
          .select({
            uid: schema.users.uid,
            name: schema.users.name,
            screenName: schema.users.screenName,
          })
          .from(schema.users)
          .where(sqlInChunks(schema.users.uid, authorIds)),
        categoryStatement,
      ]);
      authorMap = new Map(authors.map(author => [author.uid, author]));
      categoryRows = categories;
    }
  }
  authorMap ??= await fetchAuthors(db, authorIds);
  const categoryMap = mapPostCategories(
    categoryRows,
    urls.siteUrl,
    options.categoryPattern as string | undefined,
  );

  return {
    ...common,
    archiveTitle: params.archiveTitle,
    archiveType: params.archiveType,
    posts: rawPosts.map(p =>
      toPostListItem(p, authorMap, categoryMap, urls.siteUrl, options.permalinkPattern as string | undefined)
    ),
    pagination: pg,
  };
}

// ─── Index (home page) ──────────────────────────────────────────────────

export async function prepareIndexData(
  ctx: RequestContext,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  behavior: { allowEmptyPage?: boolean } = {},
): Promise<ThemeIndexProps | Response> {
  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: '',
    archiveType: 'index',
    baseUrl: ctx.urls.siteUrl + '/',
    allowEmptyPage: behavior.allowEmptyPage,
    // G7-5: future-post filter is shared by prepareArchiveData now, no
    // need to duplicate it here.
  });
}

// ─── Post detail ────────────────────────────────────────────────────────

export interface PreparePostResult {
  props: ThemePostProps;
  /** If set, the page route should return this Response instead */
  redirect?: never;
}

/**
 * Internal rendering options for authenticated admin previews. Public routes
 * must keep the default visibility checks enabled.
 */
export interface ContentDataOptions {
  previewMode?: boolean;
}

function isPublicThemeHtml(ctx: RequestContext): boolean {
  return getActiveTheme(String(ctx.options.theme || 'typecho-theme-warm')).manifest.publicHtml === true;
}

function canViewPublicThemeContent(content: ContentRow, now = Math.floor(Date.now() / 1000)): boolean {
  return (content.type === 'post' || content.type === 'page' || content.type === 'note')
    && content.status === 'publish'
    && (content.created || 0) <= now;
}

export async function preparePostData(
  ctx: RequestContext,
  cidNum: number,
  requestUrl: string,
  suppliedPassword: string | null,
  preloadedRow?: ContentRow | null,
  unapprovedCommentToken?: string | null,
  dataOptions: ContentDataOptions = {},
): Promise<ThemePostProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;

  const contentRow = preloadedRow ?? await db.query.contents.findFirst({
    where: eq(schema.contents.cid, cidNum),
  });

  if (!contentRow) return new Response('Not Found', { status: 404 });

  if (!dataOptions.previewMode && (isPublicThemeHtml(ctx)
    ? !canViewPublicThemeContent(contentRow)
    : !canViewContent(contentRow, { isLoggedIn, uid: user?.uid }))) {
    return new Response('Not Found', { status: 404 });
  }

  // Password
  const hasPassword = !!contentRow.password;
  // The admin preview route has already checked that the current user owns
  // the content or may edit it, matching Typecho's preview=1 behaviour.
  const passwordVerified = dataOptions.previewMode || (hasPassword && suppliedPassword === contentRow.password);
  // Keep all content-specific reads in one D1 round trip while the common
  // chrome data loads independently.
  const loadContentMetadata = () => db.batch([
    db
      .select({
        uid: schema.users.uid,
        name: schema.users.name,
        screenName: schema.users.screenName,
      })
      .from(schema.users)
      .where(eq(schema.users.uid, contentRow.authorId || 0))
      .limit(1),
    db
      .select({ name: schema.metas.name, slug: schema.metas.slug, type: schema.metas.type })
      .from(schema.relationships)
      .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
      .where(eq(schema.relationships.cid, cidNum)),
    db
      .select({ cid: schema.contents.cid, title: schema.contents.title, slug: schema.contents.slug, type: schema.contents.type, created: schema.contents.created })
      .from(schema.contents)
      .where(and(publishedPostCondition(), lt(schema.contents.created, contentRow.created || 0)))
      .orderBy(desc(schema.contents.created))
      .limit(1),
    db
      .select({ cid: schema.contents.cid, title: schema.contents.title, slug: schema.contents.slug, type: schema.contents.type, created: schema.contents.created })
      .from(schema.contents)
      .where(and(publishedPostCondition(), gt(schema.contents.created, contentRow.created || 0)))
      .orderBy(asc(schema.contents.created))
      .limit(1),
  ]);
  const metadataPromise = !dataOptions.previewMode
    && !hasPassword
    && !unapprovedCommentToken
    && canViewPublicThemeContent(contentRow)
    ? loadQueryCache(ctx, { domain: 'content', key: { cid: cidNum } }, loadContentMetadata)
    : loadContentMetadata();
  const [
    common,
    [
      authorRows,
      relatedMetas,
      prevPostRows,
      nextPostRows,
    ],
    commentPage,
  ] = await Promise.all([
    loadCommon(ctx, requestUrl),
    metadataPromise,
    loadThemeCommentPage(db, options, cidNum, contentRow.commentsNum || 0, requestUrl, unapprovedCommentToken),
  ]);
  const author = authorRows[0] ?? null;
  const allComments = commentPage.rows;

  type MetaEntry = { name: string | null; slug: string | null; type: string | null };
  const categories = (relatedMetas as MetaEntry[]).filter(m => m.type === 'category').map(m => ({
    name: m.name || '',
    slug: m.slug || '',
    permalink: buildCategoryLink(m.slug || '', urls.siteUrl, options.categoryPattern as string | undefined),
  }));
  const tags = (relatedMetas as MetaEntry[]).filter(m => m.type === 'tag').map(m => ({
    name: m.name || '',
    slug: m.slug || '',
    permalink: buildTagLink(m.slug || '', urls.siteUrl),
  }));

  const commentTree = buildCommentTree(allComments, options);
  const gravatarMap = options.commentsAvatar
    ? await buildGravatarMap(allComments, options.commentsAvatarRating || 'G')
    : {};

  const permalink = buildPermalink(
    { cid: contentRow.cid, slug: contentRow.slug, type: contentRow.type, created: contentRow.created, category: categories[0]?.slug },
    urls.siteUrl,
    options.permalinkPattern as string | undefined,
  );

  const allowComment = contentRow.allowComment === '1';
  const renderedContent = hasPassword && !passwordVerified
    ? '<p>此内容已加密，请输入密码访问。</p>'
    : await renderMarkdownFiltered(ctx, contentRow.text || '');

  // Generate CSRF token for comment form, bound to cid so that pages
  // visited via email/RSS without a referer still validate.
  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret as string, contentRow.cid)
    : '';

  return {
    ...common,
    post: {
      cid: contentRow.cid,
      title: contentRow.title || '无标题',
      permalink,
      content: renderedContent,
      created: contentRow.created || 0,
      modified: contentRow.modified,
      commentsNum: contentRow.commentsNum || 0,
      allowComment,
      hasPassword,
      passwordVerified,
    },
    author: author ? { uid: author.uid, name: author.name || '', screenName: author.screenName || author.name || '' } : null,
    categories,
    tags,
    comments: commentTree,
    commentPagination: commentPage.pagination,
    commentOptions: { ...buildCommentOptions(options, securityToken), allowComment },
    prevPost: prevPostRows[0] ? {
      title: prevPostRows[0].title || '无标题',
      permalink: buildPermalink(prevPostRows[0], urls.siteUrl, options.permalinkPattern as string | undefined),
    } : null,
    nextPost: nextPostRows[0] ? {
      title: nextPostRows[0].title || '无标题',
      permalink: buildPermalink(nextPostRows[0], urls.siteUrl, options.permalinkPattern as string | undefined),
    } : null,
    gravatarMap,
  };
}

// ─── Independent page ───────────────────────────────────────────────────

export async function preparePageData(
  ctx: RequestContext,
  cleanSlug: string,
  requestUrl: string,
  suppliedPassword: string | null,
  preloadedRow?: ContentRow | null,
  unapprovedCommentToken?: string | null,
  dataOptions: ContentDataOptions = {},
): Promise<ThemePageProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;

  const pageRow = preloadedRow ?? await db.query.contents.findFirst({
    where: and(eq(schema.contents.slug, cleanSlug), eq(schema.contents.type, 'page')),
  });

  if (!pageRow) return new Response('Not Found', { status: 404 });

  if (!dataOptions.previewMode && (isPublicThemeHtml(ctx)
    ? !canViewPublicThemeContent(pageRow)
    : !canViewContent(pageRow, { isLoggedIn, uid: user?.uid }))) {
    return new Response('Not Found', { status: 404 });
  }

  const permalink = buildPermalink(
    { cid: pageRow.cid, slug: pageRow.slug, type: pageRow.type, created: pageRow.created },
    urls.siteUrl,
    undefined,
    options.pagePattern as string | undefined,
  );

  const hasPassword = !!pageRow.password;
  // See the post detail equivalent above: authenticated admin previews may
  // inspect protected content without entering its public password.
  const passwordVerified = dataOptions.previewMode || (hasPassword && suppliedPassword === pageRow.password);
  const [commentPage, common] = await Promise.all([
    loadThemeCommentPage(db, options, pageRow.cid, pageRow.commentsNum || 0, requestUrl, unapprovedCommentToken),
    loadCommon(ctx, requestUrl),
  ]);
  const allComments = commentPage.rows;

  const commentTree = buildCommentTree(allComments, options);
  const gravatarMap = options.commentsAvatar
    ? await buildGravatarMap(allComments, options.commentsAvatarRating || 'G')
    : {};
  const allowComment = pageRow.allowComment === '1';

  const renderedContent = hasPassword && !passwordVerified
    ? '<p>此内容已加密，请输入密码访问。</p>'
    : await renderMarkdownFiltered(ctx, pageRow.text || '');

  // Generate CSRF token for comment form, bound to cid so that pages
  // visited via email/RSS without a referer still validate.
  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret as string, pageRow.cid)
    : '';

  return {
    ...common,
    page: {
      cid: pageRow.cid,
      title: pageRow.title || '无标题',
      slug: cleanSlug,
      permalink,
      content: renderedContent,
      created: pageRow.created || 0,
      allowComment,
      hasPassword,
      passwordVerified,
    },
    comments: commentTree,
    commentPagination: commentPage.pagination,
    commentOptions: { ...buildCommentOptions(options, securityToken), allowComment },
    gravatarMap,
  };
}

// ─── Archive (category / tag / author / search) ─────────────────────────

export async function prepareCategoryData(
  ctx: RequestContext,
  slug: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  preloadedCategory?: Pick<MetaRow, 'mid' | 'name'> | null,
): Promise<ThemeArchiveProps | Response> {
  const category = preloadedCategory === undefined
    ? await ctx.db.query.metas.findFirst({
        where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'category')),
      })
    : preloadedCategory;
  if (!category) return new Response('Not Found', { status: 404 });

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `分类 ${category.name} 下的文章`,
    archiveType: 'category',
    baseUrl: buildCategoryLink(slug, ctx.urls.siteUrl, ctx.options.categoryPattern as string | undefined),
    joinMid: category.mid,
  });
}

export async function prepareTagData(
  ctx: RequestContext,
  slug: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  preloadedTag?: Pick<MetaRow, 'mid' | 'name'> | null,
): Promise<ThemeArchiveProps | Response> {
  const tag = preloadedTag === undefined
    ? await ctx.db.query.metas.findFirst({
        where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'tag')),
      })
    : preloadedTag;
  if (!tag) return new Response('Not Found', { status: 404 });

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `标签 ${tag.name} 下的文章`,
    archiveType: 'tag',
    baseUrl: buildTagLink(slug, ctx.urls.siteUrl),
    joinMid: tag.mid,
  });
}

export async function prepareAuthorData(
  ctx: RequestContext,
  uidNum: number,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  preloadedAuthor?: UserRow | null,
): Promise<ThemeArchiveProps | Response> {
  const author = preloadedAuthor === undefined
    ? await ctx.db.query.users.findFirst({ where: eq(schema.users.uid, uidNum) })
    : preloadedAuthor;
  if (!author) return new Response('Not Found', { status: 404 });

  const authorMap: AuthorMap = new Map([[author.uid, author]]);

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `${author.screenName || author.name} 发布的文章`,
    archiveType: 'author',
    baseUrl: buildAuthorLink(uidNum, ctx.urls.siteUrl),
    extraWhere: eq(schema.contents.authorId, uidNum),
    authorOverride: authorMap,
  });
}

export async function prepareSearchData(
  ctx: RequestContext,
  keywords: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
): Promise<ThemeArchiveProps | Response> {
  // G4-5: bound keyword length both as a UX guard (single chars match
  // huge swaths of LIKE) and as a cheap rate-limit on D1 LIKE scans.
  const trimmed = truncateSearchKeyword(keywords.trim());
  const isUsefulKeyword = trimmed.length >= 2;

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `包含关键字 ${trimmed} 的文章`,
    archiveType: 'search',
    baseUrl: buildSearchLink(trimmed, ctx.urls.siteUrl),
    extraWhere: isUsefulKeyword
      ? sql`(${schema.contents.title} LIKE ${`%${trimmed}%`} OR ${schema.contents.text} LIKE ${`%${trimmed}%`})`
      : sql`1 = 0`, // empty/too-short keyword → no results, never N+1 LIKE
  });
}

// ─── 404 Not Found ──────────────────────────────────────────────────────

export async function prepareNotFoundData(
  ctx: RequestContext,
  requestUrl: string,
): Promise<ThemeNotFoundProps> {
  const common = await loadCommon(ctx, requestUrl);
  return {
    ...common,
    statusCode: 404,
    errorTitle: '404 - 页面没找到',
  };
}
