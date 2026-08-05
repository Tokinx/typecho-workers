import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { doHook } from '@/lib/plugin';
import { invalidatePublicCache } from '@/lib/cache';
import { canViewContent } from '@/lib/content-visibility';
import { parseBoundedIds, sqlInChunks } from '@/lib/d1-in';
import { eq, sql } from 'drizzle-orm';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const pluginCtx = auth.pluginCtx;

  const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
  const isEditor = hasPermission(auth.user.group || 'visitor', 'editor');

  const action = url.searchParams.get('do') || '';
  const markStatusInput = url.searchParams.get('status') || '';
  const VALID_STATUSES = ['publish', 'draft', 'hidden', 'private', 'waiting'];
  const markStatus = VALID_STATUSES.includes(markStatusInput) ? markStatusInput : '';
  const type = url.searchParams.get('type') || 'post';
  const isPageSort = action === 'sort' && type === 'page';
  if (action !== 'delete' && !(action === 'mark' && markStatus) && !isPageSort) {
    return new Response('Invalid action', { status: 400 });
  }

  const formData = await request.formData();
  const rawCids = formData.getAll('cid[]').map(value => value.toString());
  const parsedCids = parseBoundedIds(rawCids);
  if (parsedCids === null) return new Response('内容 ID 数据无效或超过 200 项', { status: 400 });
  const cids = parsedCids;
  if (isPageSort) {
    // The order must be an exact, unique list of page IDs. This keeps a
    // drag operation scoped to the rows currently visible in the list.
    if (
      cids.length !== rawCids.length
      || rawCids.some(value => !/^[1-9]\d*$/.test(value))
      || new Set(cids).size !== cids.length
    ) {
      return new Response('Invalid page order', { status: 400 });
    }
  }

  // Typecho uses JS to collect checkboxes and submit — redirect back if no cids
  if (cids.length === 0) {
    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  if (isPageSort) {
    if (!isEditor) {
      return new Response('Forbidden', { status: 403 });
    }

    const rawParent = formData.get('parent')?.toString() || '';
    if (!/^\d+$/.test(rawParent)) {
      return new Response('Invalid page parent', { status: 400 });
    }
    const parent = Number(rawParent);
    if (!Number.isSafeInteger(parent) || parent < 0) {
      return new Response('Invalid page parent', { status: 400 });
    }

    const pages = await auth.db.select({
      cid: schema.contents.cid,
      type: schema.contents.type,
      parent: schema.contents.parent,
      status: schema.contents.status,
      created: schema.contents.created,
      authorId: schema.contents.authorId,
    }).from(schema.contents)
      .where(sqlInChunks(schema.contents.cid, cids));
    if (
      pages.length !== cids.length
      || pages.some(page => (
        (page.type !== 'page' && page.type !== 'page_draft')
        || (Number(page.parent) || 0) !== parent
      ))
    ) {
      return new Response('Invalid page order', { status: 400 });
    }

    const statements = cids.map((cid, index) => auth.db.update(schema.contents)
      .set({ order: index + 1 })
      .where(sql`${schema.contents.cid} = ${cid} AND ${schema.contents.type} IN ('page', 'page_draft') AND coalesce(${schema.contents.parent}, 0) = ${parent}`));
    const batchFn = (auth.db as any).batch;
    if (typeof batchFn === 'function') {
      await batchFn.call(auth.db, statements as any);
    } else {
      for (const statement of statements) await statement;
    }

    await invalidatePublicCache(auth.db, {
      reason: 'page-sort',
      domains: pages.some(page => canViewContent(page, {})) ? ['all'] : [],
      sharedDomains: ['navigation', 'archive', 'content', 'admin-dashboard', 'admin-content'],
    });
    return new Response(JSON.stringify({ success: 1, message: '页面排序已经完成' }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  let affectsPublicCache = false;
  if (action === 'delete') {
    // G4-2: fetch all targeted contents in one query rather than per-cid
    // findFirst, then trigger plugin hooks and emit one big delete batch.
    const contents = await auth.db.select().from(schema.contents)
      .where(sqlInChunks(schema.contents.cid, cids));

    const allowedContents = contents.filter(c => isAdmin || c.authorId === auth.uid);
    if (allowedContents.length === 0) {
      return new Response(null, { status: 302, headers: {
        Location: type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts',
      } });
    }

    const allowedCids = allowedContents.map(c => c.cid);
    affectsPublicCache = allowedContents.some(content => canViewContent(content, {}));

    // Pre-delete hooks (must run sequentially: plugins may rely on
    // ordering and on the row still being present).
    for (const content of allowedContents) {
      const isPage = content.type?.startsWith('page');
      await doHook(pluginCtx, isPage ? 'page:delete' : 'post:delete', content);
    }

    // Decrement meta counts in one pass: collect all (cid -> [mid]) and
    // run a single relationship lookup, then update each meta once with
    // the actual decrement count.
    const rels = await auth.db.select({ cid: schema.relationships.cid, mid: schema.relationships.mid })
      .from(schema.relationships)
      .where(sqlInChunks(schema.relationships.cid, allowedCids));
    const decrementByMid = new Map<number, number>();
    for (const rel of rels) {
      decrementByMid.set(rel.mid, (decrementByMid.get(rel.mid) || 0) + 1);
    }

    // Now stream the writes through D1 batch — atomic and single-round-trip.
    const decrementStmts = Array.from(decrementByMid.entries()).map(([mid, n]) =>
      auth.db.update(schema.metas)
        .set({ count: sql`MAX(0, ${schema.metas.count} - ${n})` })
        .where(eq(schema.metas.mid, mid))
    );
    const deleteStmts = [
      auth.db.delete(schema.relationships).where(sqlInChunks(schema.relationships.cid, allowedCids)),
      auth.db.delete(schema.comments).where(sqlInChunks(schema.comments.cid, allowedCids)),
      auth.db.delete(schema.fields).where(sqlInChunks(schema.fields.cid, allowedCids)),
      auth.db.delete(schema.contents).where(sqlInChunks(schema.contents.cid, allowedCids)),
    ];
    const all = [...decrementStmts, ...deleteStmts];
    if (all.length > 0) {
      // drizzle-orm/d1 exposes `batch()` — fall back to sequential
      // execution for environments (libsql tests) that don't.
      const batchFn = (auth.db as any).batch;
      if (typeof batchFn === 'function') {
        await batchFn.call(auth.db, all as any);
      } else {
        for (const stmt of all) await stmt;
      }
    }

    // Post-delete hooks
    for (const content of allowedContents) {
      const isPage = content.type?.startsWith('page');
      await doHook(pluginCtx, isPage ? 'page:finishDelete' : 'post:finishDelete', content);
    }
  } else if (action === 'mark' && markStatus) {
    if (!isEditor) {
      return new Response('Forbidden', { status: 403 });
    }

    const contents = await auth.db.select().from(schema.contents)
      .where(sqlInChunks(schema.contents.cid, cids));
    const allowedContents = contents.filter(c => isAdmin || c.authorId === auth.uid);
    const allowedCids = allowedContents.map(c => c.cid);
    affectsPublicCache = allowedContents.some(content => (
      canViewContent(content, {})
      || canViewContent({ ...content, status: markStatus }, {})
    ));
    if (allowedCids.length > 0) {
      await auth.db.update(schema.contents)
        .set({ status: markStatus })
        .where(sqlInChunks(schema.contents.cid, allowedCids));
    }
  }

  if (action === 'delete' || (action === 'mark' && markStatus)) {
    await invalidatePublicCache(auth.db, {
      reason: 'content-batch',
      domains: affectsPublicCache ? ['all'] : [],
      sharedDomains: [
        'navigation', 'sidebar', 'metas', 'comments', 'notes', 'archive', 'content',
        'admin-dashboard', 'admin-content', 'admin-comments', 'admin-metas', 'admin-media', 'admin-users',
      ],
    });
  }

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
