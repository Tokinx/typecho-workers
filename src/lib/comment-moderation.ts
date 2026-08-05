import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { hasPermission } from '@/lib/auth';
import { doHook, type HookContext } from '@/lib/plugin';
import { invalidatePublicCache } from '@/lib/cache';
import { sqlInChunks } from '@/lib/d1-in';

export const COMMENT_ACTIONS = ['approve', 'approved', 'waiting', 'spam', 'delete'] as const;
export type CommentAction = typeof COMMENT_ACTIONS[number];

type CommentRow = typeof schema.comments.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;
const COMMENT_DATA_DOMAINS = [
  'sidebar', 'comments', 'notes', 'content', 'admin-dashboard', 'admin-content', 'admin-comments',
] as const;

export function normalizeCommentAction(action: string): CommentAction | null {
  if (action === 'approve') return 'approved';
  return COMMENT_ACTIONS.includes(action as CommentAction) ? action as CommentAction : null;
}

/**
 * Check whether `user` may moderate `comment`.
 *
 * G7-4: the legacy implementation checked `comment.ownerId === user.uid`,
 * but ownerId is set at comment creation and never re-synced when a
 * post's author changes. We now ask the live `contents.authorId` so
 * permission tracks whoever currently owns the post.
 */
export async function canModerateComment(
  db: Database,
  user: UserRow,
  comment: CommentRow,
): Promise<boolean> {
  if (hasPermission(user.group || 'visitor', 'administrator')) return true;
  if (!comment.cid) return false;
  const owner = await db.query.contents.findFirst({
    columns: { authorId: true },
    where: eq(schema.contents.cid, comment.cid),
  });
  return !!owner && owner.authorId === user.uid;
}

export async function getModeratableComment(
  db: Database,
  coid: number,
  user: UserRow,
): Promise<CommentRow | Response> {
  const comment = await db.query.comments.findFirst({
    where: eq(schema.comments.coid, coid),
  });
  if (!comment) return new Response('Not Found', { status: 404 });
  if (!(await canModerateComment(db, user, comment))) return new Response('Forbidden', { status: 403 });
  return comment;
}

/**
 * Resolve and authorize a complete moderation selection in one query.
 * Missing comments retain the legacy "skip" behaviour, while any forbidden
 * row rejects the whole selection before writes begin.
 */
export async function getModeratableComments(
  db: Database,
  coids: number[],
  user: UserRow,
): Promise<CommentRow[] | Response> {
  if (coids.length === 0) return [];
  const rows = await db
    .select({ comment: schema.comments, contentAuthorId: schema.contents.authorId })
    .from(schema.comments)
    .leftJoin(schema.contents, eq(schema.comments.cid, schema.contents.cid))
    .where(sqlInChunks(schema.comments.coid, coids));
  const byId = new Map(rows.map(row => [row.comment.coid, row]));
  const isAdmin = hasPermission(user.group || 'visitor', 'administrator');
  const comments: CommentRow[] = [];
  for (const coid of coids) {
    const row = byId.get(coid);
    if (!row) continue;
    if (!isAdmin && row.contentAuthorId !== user.uid) {
      return new Response('Forbidden', { status: 403 });
    }
    comments.push(row.comment);
  }
  return comments;
}

export async function applyCommentAction(
  ctx: HookContext,
  db: Database,
  comment: CommentRow,
  action: CommentAction,
  options?: Record<string, unknown>,
): Promise<void> {
  const oldStatus = comment.status;

  if (action === 'delete') {
    await db.delete(schema.comments).where(eq(schema.comments.coid, comment.coid));
    if (oldStatus === 'approved') {
      await decrementCommentCount(db, comment.cid || 0);
    }
    await doHook(ctx, 'comment:action', comment, { action, oldStatus, newStatus: 'deleted', options });
    await invalidatePublicCache(db, { reason: 'comment-delete', domains: [], sharedDomains: [...COMMENT_DATA_DOMAINS] });
    return;
  }

  const nextStatus = action === 'approved' ? 'approved' : action;
  await db.update(schema.comments)
    .set({ status: nextStatus })
    .where(eq(schema.comments.coid, comment.coid));

  if (oldStatus !== 'approved' && nextStatus === 'approved') {
    await incrementCommentCount(db, comment.cid || 0);
  } else if (oldStatus === 'approved' && nextStatus !== 'approved') {
    await decrementCommentCount(db, comment.cid || 0);
  }

  await doHook(ctx, 'comment:action', comment, { action, oldStatus, newStatus: nextStatus, options });
  await invalidatePublicCache(db, { reason: 'comment-status', domains: [], sharedDomains: [...COMMENT_DATA_DOMAINS] });
}

/** Apply a validated selection in one D1 batch and fire hooks in input order. */
export async function applyCommentActions(
  ctx: HookContext,
  db: Database,
  comments: CommentRow[],
  action: CommentAction,
  options?: Record<string, unknown>,
): Promise<void> {
  if (comments.length === 0) return;
  const statements: any[] = [];
  const countDeltaByCid = new Map<number, number>();

  for (const comment of comments) {
    const oldStatus = comment.status;
    if (action === 'delete') {
      statements.push(db.delete(schema.comments).where(eq(schema.comments.coid, comment.coid)));
      if (oldStatus === 'approved' && comment.cid) {
        countDeltaByCid.set(comment.cid, (countDeltaByCid.get(comment.cid) || 0) - 1);
      }
      continue;
    }

    const nextStatus = action === 'approved' ? 'approved' : action;
    statements.push(
      db.update(schema.comments)
        .set({ status: nextStatus })
        .where(eq(schema.comments.coid, comment.coid)),
    );
    if (comment.cid && oldStatus !== nextStatus) {
      if (oldStatus !== 'approved' && nextStatus === 'approved') {
        countDeltaByCid.set(comment.cid, (countDeltaByCid.get(comment.cid) || 0) + 1);
      } else if (oldStatus === 'approved' && nextStatus !== 'approved') {
        countDeltaByCid.set(comment.cid, (countDeltaByCid.get(comment.cid) || 0) - 1);
      }
    }
  }

  for (const [cid, delta] of countDeltaByCid) {
    if (delta === 0) continue;
    statements.push(
      db.update(schema.contents)
        .set({
          commentsNum: delta > 0
            ? sql`${schema.contents.commentsNum} + ${delta}`
            : sql`MAX(0, ${schema.contents.commentsNum} + ${delta})`,
        })
        .where(eq(schema.contents.cid, cid)),
    );
  }
  await db.batch(statements as [any, ...any[]]);

  for (const comment of comments) {
    const oldStatus = comment.status;
    const newStatus = action === 'delete' ? 'deleted' : action === 'approved' ? 'approved' : action;
    await doHook(ctx, 'comment:action', comment, { action, oldStatus, newStatus, options });
  }
  await invalidatePublicCache(db, { reason: 'comment-batch', domains: [], sharedDomains: [...COMMENT_DATA_DOMAINS] });
}

export async function deleteSpamCommentsForUser(
  db: Database,
  user: UserRow,
): Promise<number> {
  const isAdmin = hasPermission(user.group || 'visitor', 'administrator');
  if (isAdmin) {
    const before = await db
      .select({ coid: schema.comments.coid })
      .from(schema.comments)
      .where(eq(schema.comments.status, 'spam'));
    if (before.length === 0) return 0;
    await db.delete(schema.comments).where(eq(schema.comments.status, 'spam'));
    return before.length;
  }

  // Non-admin: clear spam attached to posts the user currently owns.
  // G7-4: use the live contents.authorId rather than the historical
  // comment.ownerId.
  const ownedContent = sql`EXISTS (
    SELECT 1 FROM ${schema.contents}
    WHERE ${schema.contents.cid} = ${schema.comments.cid}
      AND ${schema.contents.authorId} = ${user.uid}
  )`;
  const before = await db
    .select({ coid: schema.comments.coid })
    .from(schema.comments)
    .where(and(
      eq(schema.comments.status, 'spam'),
      ownedContent,
    ));
  if (before.length === 0) return 0;
  await db.delete(schema.comments).where(and(
    eq(schema.comments.status, 'spam'),
    ownedContent,
  ));
  return before.length;
}

async function incrementCommentCount(db: Database, cid: number): Promise<void> {
  if (!cid) return;
  await db.update(schema.contents)
    .set({ commentsNum: sql`${schema.contents.commentsNum} + 1` })
    .where(eq(schema.contents.cid, cid));
}

async function decrementCommentCount(db: Database, cid: number): Promise<void> {
  if (!cid) return;
  await db.update(schema.contents)
    .set({ commentsNum: sql`MAX(0, ${schema.contents.commentsNum} - 1)` })
    .where(eq(schema.contents.cid, cid));
}
