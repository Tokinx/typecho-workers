import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import type { SiteOptions } from '@/lib/options';

export type CommentRow = typeof schema.comments.$inferSelect;

export interface CommentPagination {
  enabled: boolean;
  currentPage: number;
  totalPages: number;
  totalComments: number;
  pageSize: number;
  pages: number[];
  pageUrls: Record<number, string>;
  prevUrl: string | null;
  nextUrl: string | null;
}

export interface CommentPage {
  rows: CommentRow[];
  pagination: CommentPagination;
}

const COMMENT_PAGE_SIZE_MAX = 100;
const COMMENT_UNPAGED_MAX = 200;

function pageUrl(requestUrl: string, page: number): string {
  const url = new URL(requestUrl);
  url.hash = 'comments';
  if (page <= 1) url.searchParams.delete('commentPage');
  else url.searchParams.set('commentPage', String(page));
  return url.toString();
}

function visiblePages(currentPage: number, totalPages: number): number[] {
  let start = Math.max(1, currentPage - 4);
  const end = Math.min(totalPages, start + 9);
  start = Math.max(1, end - 9);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function buildPagination(
  requestUrl: string,
  enabled: boolean,
  requestedPage: number | null,
  defaultDisplay: 'first' | 'last',
  pageSize: number,
  totalPageItems: number,
  totalComments: number,
): CommentPagination {
  const totalPages = enabled ? Math.max(1, Math.ceil(totalPageItems / pageSize)) : 1;
  const defaultPage = defaultDisplay === 'last' ? totalPages : 1;
  const currentPage = enabled
    ? Math.min(Math.max(1, requestedPage ?? defaultPage), totalPages)
    : 1;
  const pages = visiblePages(currentPage, totalPages);
  return {
    enabled,
    currentPage,
    totalPages,
    totalComments,
    pageSize,
    pages,
    pageUrls: Object.fromEntries(pages.map(page => [page, pageUrl(requestUrl, page)])),
    prevUrl: currentPage > 1 ? pageUrl(requestUrl, currentPage - 1) : null,
    nextUrl: currentPage < totalPages ? pageUrl(requestUrl, currentPage + 1) : null,
  };
}

/** Build the lightweight pagination shell used by API-backed comment themes. */
export function buildCommentPaginationSummary(
  options: SiteOptions,
  requestUrl: string,
  totalComments: number,
): CommentPagination {
  const pageSize = Math.min(
    COMMENT_PAGE_SIZE_MAX,
    Math.max(1, Number(options.commentsPageSize) || 20),
  );
  const rawPage = new URL(requestUrl).searchParams.get('commentPage');
  const parsedPage = rawPage ? Number.parseInt(rawPage, 10) : Number.NaN;
  const requestedPage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : null;
  return buildPagination(
    requestUrl,
    !!options.commentsPageBreak,
    requestedPage,
    options.commentsPageDisplay === 'first' ? 'first' : 'last',
    pageSize,
    Math.max(0, totalComments),
    Math.max(0, totalComments),
  );
}

/**
 * Load one bounded comment thread page. Threaded mode paginates root comments
 * and uses a recursive CTE to keep every selected root's descendants together.
 */
export async function loadCommentPage(
  db: Database,
  cid: number,
  options: SiteOptions,
  requestUrl: string,
  visibleUnapprovedCommentId?: number | null,
): Promise<CommentPage> {
  let enabled = !!options.commentsPageBreak;
  const threaded = !!options.commentsThreaded;
  const pageSize = Math.min(
    COMMENT_PAGE_SIZE_MAX,
    Math.max(1, Number(options.commentsPageSize) || 20),
  );
  const order = options.commentsOrder === 'DESC' ? 'DESC' : 'ASC';
  const orderExpression = order === 'DESC'
    ? desc(schema.comments.created)
    : asc(schema.comments.created);
  const rawPage = new URL(requestUrl).searchParams.get('commentPage');
  const parsedPage = rawPage ? Number.parseInt(rawPage, 10) : Number.NaN;
  const requestedPage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : null;
  const display = options.commentsPageDisplay === 'first' ? 'first' : 'last';
  const unapprovedCommentId = Number.isSafeInteger(visibleUnapprovedCommentId) && (visibleUnapprovedCommentId || 0) > 0
    ? visibleUnapprovedCommentId
    : null;
  const visibleForContent = and(
    eq(schema.comments.cid, cid),
    unapprovedCommentId
      ? or(
          eq(schema.comments.status, 'approved'),
          eq(schema.comments.coid, unapprovedCommentId),
        )
      : eq(schema.comments.status, 'approved'),
  );
  const visibleParentStatus = unapprovedCommentId
    ? sql`(parent_comment.status = 'approved' OR parent_comment.coid = ${unapprovedCommentId})`
    : sql`parent_comment.status = 'approved'`;
  const visibleRootForContent = and(
    visibleForContent,
    sql`(
      ${schema.comments.parent} = 0
      OR NOT EXISTS (
        SELECT 1
        FROM ${schema.comments} AS parent_comment
        WHERE parent_comment.coid = ${schema.comments.parent}
          AND parent_comment.cid = ${cid}
          AND ${visibleParentStatus}
      )
    )`,
  );

  if (!enabled) {
    // Probe the total with the same round trip as the bounded row fetch. Small
    // unpaged comment sets retain the legacy response shape; larger sets are
    // transparently promoted to paged mode instead of materialising everything.
    const [countResult, rows] = await db.batch([
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.comments)
        .where(visibleForContent),
      db
        .select()
        .from(schema.comments)
        .where(visibleForContent)
        .orderBy(orderExpression)
        .limit(COMMENT_UNPAGED_MAX),
    ]);
    const totalComments = Number(countResult[0]?.count || 0);
    if (totalComments <= COMMENT_UNPAGED_MAX) {
      return {
        rows,
        pagination: buildPagination(
          requestUrl,
          false,
          null,
          display,
          pageSize,
          totalComments,
          totalComments,
        ),
      };
    }
    enabled = true;
  }

  const countStatements = [
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.comments)
      .where(visibleForContent),
  ];
  if (threaded) {
    countStatements.push(
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.comments)
        .where(visibleRootForContent),
    );
  }
  const countResults = await db.batch(countStatements as [any, ...any[]]);
  const totalComments = Number(countResults[0][0]?.count || 0);
  const totalPageItems = threaded
    ? Number(countResults[1][0]?.count || 0)
    : totalComments;
  const pagination = buildPagination(
    requestUrl,
    true,
    requestedPage,
    display,
    pageSize,
    totalPageItems,
    totalComments,
  );
  const offset = (pagination.currentPage - 1) * pageSize;

  if (!threaded) {
    const rows = await db
      .select()
      .from(schema.comments)
      .where(visibleForContent)
      .orderBy(orderExpression)
      .limit(pageSize)
      .offset(offset);
    return { rows, pagination };
  }

  const orderSql = order === 'DESC' ? sql`DESC` : sql`ASC`;
  const candidateStatus = unapprovedCommentId
    ? sql`(candidate.status = 'approved' OR candidate.coid = ${unapprovedCommentId})`
    : sql`candidate.status = 'approved'`;
  const childStatus = unapprovedCommentId
    ? sql`(child.status = 'approved' OR child.coid = ${unapprovedCommentId})`
    : sql`child.status = 'approved'`;
  const rows = await db.all<CommentRow>(sql`
    WITH RECURSIVE selected_roots(coid) AS (
      SELECT candidate.coid
      FROM ${schema.comments} AS candidate
      WHERE candidate.cid = ${cid}
        AND ${candidateStatus}
        AND (
          candidate.parent = 0
          OR NOT EXISTS (
            SELECT 1
            FROM ${schema.comments} AS parent_comment
            WHERE parent_comment.coid = candidate.parent
              AND parent_comment.cid = ${cid}
              AND ${visibleParentStatus}
          )
        )
      ORDER BY candidate.created ${orderSql}
      LIMIT ${pageSize} OFFSET ${offset}
    ),
    thread AS (
      SELECT comment.*
      FROM ${schema.comments} AS comment
      INNER JOIN selected_roots AS root ON root.coid = comment.coid
      UNION ALL
      SELECT child.*
      FROM ${schema.comments} AS child
      INNER JOIN thread AS parent_comment ON child.parent = parent_comment.coid
      WHERE child.cid = ${cid}
        AND ${childStatus}
    )
    SELECT *
    FROM thread
    ORDER BY created ${orderSql}
  `);
  return { rows, pagination };
}
