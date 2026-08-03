import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { generateSlug } from '@/lib/content';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';
import { eq, and, sql } from 'drizzle-orm';

export const POST: APIRoute = handler;

function parseMetaIds(formData: FormData): string[] {
  return formData.getAll('mid[]').map(value => value.toString());
}

type MetaIdValidation = { ids: number[] } | { error: string };

function validateMetaIds(rawIds: string[], message = '分类数据无效'): MetaIdValidation {
  if (rawIds.length === 0) return { error: message };

  const ids: number[] = [];
  for (const rawId of rawIds) {
    if (!/^\d+$/.test(rawId)) return { error: message };
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) return { error: message };
    ids.push(id);
  }

  if (new Set(ids).size !== ids.length) return { error: message };
  return { ids };
}

async function runBatch(db: any, statements: any[]): Promise<void> {
  if (statements.length === 0) return;
  const batchFn = db.batch;
  if (typeof batchFn === 'function') {
    await batchFn.call(db, statements as any);
    return;
  }
  for (const statement of statements) await statement;
}

type CategoryParentValidation = { parent: number } | { error: string };

/** Validate category hierarchy and prevent self/descendant parent cycles. */
async function validateCategoryParent(db: any, rawValue: string, currentMid: number): Promise<CategoryParentValidation> {
  if (!/^\d+$/.test(rawValue)) return { error: '父级分类无效' };

  const parent = Number(rawValue);
  if (!Number.isSafeInteger(parent) || parent < 0) return { error: '父级分类无效' };
  if (parent === 0) return { parent: 0 };
  if (currentMid > 0 && parent === currentMid) return { error: '分类不能设为自己的父级分类' };

  const categories = await db.select({ mid: schema.metas.mid, parent: schema.metas.parent })
    .from(schema.metas)
    .where(eq(schema.metas.type, 'category'));
  const byMid = new Map<number, { mid: number; parent: number | null }>(
    categories.map((category: { mid: number; parent: number | null }) => [category.mid, category] as const),
  );
  if (!byMid.has(parent)) return { error: '父级分类不存在' };

  let ancestor = parent;
  const visited = new Set<number>();
  while (ancestor > 0) {
    if (!visited.add(ancestor)) return { error: '父级分类层级无效' };
    if (currentMid > 0 && ancestor === currentMid) return { error: '父级分类不能是当前分类的子分类' };
    const category = byMid.get(ancestor);
    if (!category) return { error: '父级分类层级无效' };
    ancestor = Number(category.parent) || 0;
  }

  return { parent };
}

// GET only for reading (JSON list for autocomplete), never for state changes
export const GET: APIRoute = async ({ request, locals, url }) => {
  const auth = await requireAdminAction(request, 'editor', { csrf: false });
  if (isAdminActionResponse(auth)) return auth;

  const type = url.searchParams.get('type') || 'category';

  // Return JSON list of metas (used for tag autocomplete)
  const metas = await auth.db.select({ mid: schema.metas.mid, name: schema.metas.name, slug: schema.metas.slug, count: schema.metas.count })
    .from(schema.metas)
    .where(eq(schema.metas.type, type))
    .orderBy(schema.metas.name);
  return new Response(JSON.stringify(metas), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'editor');
  if (isAdminActionResponse(auth)) return auth;
  const db = auth.db;
  const options = auth.options;

  const formData = await request.formData();
  const action = formData.get('action')?.toString() || url.searchParams.get('action') || '';
  const type = formData.get('type')?.toString() || url.searchParams.get('type') || 'category';
  const rawMid = formData.get('mid')?.toString() || url.searchParams.get('mid') || '';
  const mid = /^\d+$/.test(rawMid) && Number.isSafeInteger(Number(rawMid))
    ? Number(rawMid)
    : 0;
  const name = formData.get('name')?.toString()?.trim() || '';
  const slug = formData.get('slug')?.toString()?.trim() || '';
  const description = formData.get('description')?.toString()?.trim() || '';
  const rawMids = parseMetaIds(formData);

  if (type !== 'category' && type !== 'tag') {
    return new Response('Invalid meta type', { status: 400 });
  }

  const redirectTo = type === 'tag' ? '/admin/manage-tags' : '/admin/manage-categories';
  const categoryRedirect = (parent: number) => parent > 0
    ? `/admin/manage-categories?parent=${parent}`
    : '/admin/manage-categories';
  let categoryParent = 0;
  if (type === 'category' && (action === 'create' || action === 'update')) {
    const parentResult = await validateCategoryParent(
      db,
      formData.has('parent') ? formData.get('parent')?.toString()?.trim() || '' : '0',
      action === 'update' ? mid : 0,
    );
    if ('error' in parentResult) return new Response(parentResult.error, { status: 400 });
    categoryParent = parentResult.parent;
  }

  if (action === 'create') {
    if (!name) return new Response('名称不能为空', { status: 400 });
    const finalSlug = slug || generateSlug(name) || name.toLowerCase().replace(/\s+/g, '-');
    const orderRows = type === 'category'
      ? await db.select({ maxOrder: sql<number>`max(${schema.metas.order})` })
        .from(schema.metas)
        .where(and(eq(schema.metas.type, 'category'), sql`coalesce(${schema.metas.parent}, 0) = ${categoryParent}`))
      : [];
    const order = type === 'category' ? (Number(orderRows[0]?.maxOrder) || 0) + 1 : 0;

    await db.insert(schema.metas).values({
      name,
      slug: finalSlug,
      type,
      description: description || null,
      count: 0,
      order,
      ...(type === 'category' ? { parent: categoryParent } : {}),
    });

    await bumpCacheVersion(db);
    await purgeSiteCache(options.siteUrl || '');
    return new Response(null, { status: 302, headers: { Location: type === 'category' ? categoryRedirect(categoryParent) : redirectTo } });
  }

  if (action === 'update' && mid) {
    if (!name) return new Response('名称不能为空', { status: 400 });
    const finalSlug = slug || generateSlug(name) || name.toLowerCase().replace(/\s+/g, '-');
    const existing = await db.query.metas.findFirst({
      where: and(eq(schema.metas.mid, mid), eq(schema.metas.type, type)),
    });
    if (!existing) return new Response(type === 'category' ? '分类不存在' : '标签不存在', { status: 404 });

    const updateData: Record<string, unknown> = {
      name,
      slug: finalSlug,
      description: description || null,
    };
    if (type === 'category') {
      updateData.parent = categoryParent;
      if ((Number(existing.parent) || 0) !== categoryParent) {
        const orderRows = await db.select({ maxOrder: sql<number>`max(${schema.metas.order})` })
          .from(schema.metas)
          .where(and(eq(schema.metas.type, 'category'), sql`coalesce(${schema.metas.parent}, 0) = ${categoryParent}`));
        updateData.order = (Number(orderRows[0]?.maxOrder) || 0) + 1;
      }
    }

    await db.update(schema.metas).set(updateData).where(and(eq(schema.metas.mid, mid), eq(schema.metas.type, type)));

    await bumpCacheVersion(db);
    await purgeSiteCache(options.siteUrl || '');
    return new Response(null, { status: 302, headers: { Location: type === 'category' ? categoryRedirect(categoryParent) : redirectTo } });
  }

  if (action === 'sort' && type === 'category') {
    const sortedIds = validateMetaIds(rawMids, '分类排序数据无效');
    if ('error' in sortedIds) return new Response(sortedIds.error, { status: 400 });

    const rawParent = formData.get('parent')?.toString() || '0';
    if (!/^\d+$/.test(rawParent) || !Number.isSafeInteger(Number(rawParent))) {
      return new Response('父级分类无效', { status: 400 });
    }
    const parent = Number(rawParent);
    const categories = await db.select({ mid: schema.metas.mid, parent: schema.metas.parent })
      .from(schema.metas)
      .where(and(
        eq(schema.metas.type, 'category'),
        sql`${schema.metas.mid} IN (${sql.join(sortedIds.ids.map(id => sql`${id}`), sql`, `)})`,
      ));
    if (categories.length !== sortedIds.ids.length
      || categories.some((category: { parent: number | null }) => (Number(category.parent) || 0) !== parent)) {
      return new Response('分类排序数据无效', { status: 400 });
    }

    await runBatch(db, sortedIds.ids.map((id, index) => db.update(schema.metas)
      .set({ order: index + 1 })
      .where(and(eq(schema.metas.mid, id), eq(schema.metas.type, 'category')))));

    await bumpCacheVersion(db);
    await purgeSiteCache(options.siteUrl || '');
    return new Response(JSON.stringify({ success: 1, message: '分类排序已经完成' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (action === 'merge' && type === 'category') {
    const sourceIds = validateMetaIds(rawMids, '请选择要合并的分类');
    if ('error' in sourceIds) return new Response(sourceIds.error, { status: 400 });

    const rawTarget = formData.get('merge')?.toString() || '';
    const targetResult = validateMetaIds([rawTarget], '合并目标分类无效');
    if ('error' in targetResult) return new Response(targetResult.error, { status: 400 });
    const targetId = targetResult.ids[0];
    if (sourceIds.ids.includes(targetId)) {
      return new Response('合并目标不能是已选择的分类', { status: 400 });
    }

    const categories = await db.select({
      mid: schema.metas.mid,
      parent: schema.metas.parent,
    }).from(schema.metas).where(eq(schema.metas.type, 'category'));
    const categoryByMid = new Map<number, { mid: number; parent: number | null }>(
      categories.map((category: { mid: number; parent: number | null }) => [category.mid, category] as const),
    );
    if (!categoryByMid.has(targetId) || sourceIds.ids.some(id => !categoryByMid.has(id))) {
      return new Response('分类不存在', { status: 404 });
    }

    const defaultMid = Number(options.defaultCategory || 0);
    if (sourceIds.ids.includes(defaultMid)) {
      return new Response('不能合并默认分类，请先指定其他分类为默认', { status: 400 });
    }

    // A source cannot be merged into its own descendant, otherwise its
    // remaining children would be attached into a hierarchy cycle.
    const sourceSet = new Set(sourceIds.ids);
    let ancestor = targetId;
    const visited = new Set<number>();
    while (ancestor > 0) {
      if (!visited.add(ancestor)) return new Response('分类层级无效', { status: 400 });
      if (sourceSet.has(ancestor)) return new Response('合并目标不能是所选分类的子分类', { status: 400 });
      const category = categoryByMid.get(ancestor);
      if (!category) return new Response('分类层级无效', { status: 400 });
      ancestor = Number(category.parent) || 0;
    }

    const sourceRelationships = await db.select({ cid: schema.relationships.cid })
      .from(schema.relationships)
      .where(sql`${schema.relationships.mid} IN (${sql.join(sourceIds.ids.map(id => sql`${id}`), sql`, `)})`);
    const targetRelationships = await db.select({ cid: schema.relationships.cid })
      .from(schema.relationships)
      .where(eq(schema.relationships.mid, targetId));
    const targetCids = new Set(targetRelationships.map(row => row.cid));
    const relationshipInserts: any[] = [];
    for (const relationship of sourceRelationships) {
      if (targetCids.has(relationship.cid)) continue;
      targetCids.add(relationship.cid);
      relationshipInserts.push(db.insert(schema.relationships).values({ cid: relationship.cid, mid: targetId }));
    }

    const childUpdates = categories
      .filter((category: { mid: number; parent: number | null }) =>
        !sourceSet.has(category.mid) && sourceSet.has(Number(category.parent) || 0))
      .map((category: { mid: number }) => db.update(schema.metas)
        .set({ parent: targetId })
        .where(and(eq(schema.metas.mid, category.mid), eq(schema.metas.type, 'category'))));
    const sourceIdSql = sql.join(sourceIds.ids.map(id => sql`${id}`), sql`, `);
    await runBatch(db, [
      ...relationshipInserts,
      ...childUpdates,
      db.delete(schema.relationships).where(sql`${schema.relationships.mid} IN (${sourceIdSql})`),
      db.delete(schema.metas).where(and(
        eq(schema.metas.type, 'category'),
        sql`${schema.metas.mid} IN (${sourceIdSql})`,
      )),
    ]);

    const [{ count }] = await db.select({ count: sql<number>`count(*)` })
      .from(schema.relationships)
      .where(eq(schema.relationships.mid, targetId));
    await db.update(schema.metas).set({ count: Number(count) || 0 })
      .where(and(eq(schema.metas.mid, targetId), eq(schema.metas.type, 'category')));

    await bumpCacheVersion(db);
    await purgeSiteCache(options.siteUrl || '');
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'delete') {
    // Support batch delete (mid[] from form) or single delete (mid from query)
    let deleteIds: number[] = [];
    if (rawMids.length > 0) {
      const parsed = validateMetaIds(rawMids, '分类数据无效');
      if ('error' in parsed) return new Response(parsed.error, { status: 400 });
      deleteIds = parsed.ids;
    } else if (mid > 0) {
      deleteIds = [mid];
    }
    if (deleteIds.length === 0) {
      return new Response(null, { status: 302, headers: { Location: redirectTo } });
    }

    const deleteIdSql = sql.join(deleteIds.map(id => sql`${id}`), sql`, `);
    const selectedMetas = await db.select({
      mid: schema.metas.mid,
      parent: schema.metas.parent,
    }).from(schema.metas).where(and(
      eq(schema.metas.type, type),
      sql`${schema.metas.mid} IN (${deleteIdSql})`,
    ));
    if (selectedMetas.length !== deleteIds.length) {
      return new Response(type === 'category' ? '分类不存在' : '标签不存在', { status: 404 });
    }

    // G7-1: refuse to delete the default category or any category that
    // still has posts attached. Tags are unrestricted (no defaultTag,
    // and dropping a tag merely orphans relationships).
    if (type === 'category') {
      const defaultMid = parseInt(String(options.defaultCategory ?? '0'), 10);
      for (const id of deleteIds) {
        if (id === defaultMid) {
          return new Response('不能删除默认分类，请先指定其他分类为默认', { status: 400 });
        }
      }
      const used = await db.select({ mid: schema.relationships.mid })
        .from(schema.relationships)
        .where(sql`${schema.relationships.mid} IN (${deleteIdSql})`);
      if (used.length > 0) {
        const inUseSet = new Set(used.map(r => r.mid));
        const targets = deleteIds.filter(id => inUseSet.has(id));
        return new Response(`分类 #${targets.join(', #')} 下仍有文章，请先迁移内容`, { status: 400 });
      }
    }

    const deleteStatements: any[] = [];
    if (type === 'category') {
      const categories = await db.select({ mid: schema.metas.mid, parent: schema.metas.parent })
        .from(schema.metas)
        .where(eq(schema.metas.type, 'category'));
      const categoryByMid = new Map<number, { mid: number; parent: number | null }>(
        categories.map((category: { mid: number; parent: number | null }) => [category.mid, category] as const),
      );
      const deleting = new Set(deleteIds);
      const survivingParentFor = (parent: number): number => {
        let current = parent;
        const visited = new Set<number>();
        while (current > 0 && deleting.has(current)) {
          if (!visited.add(current)) return 0;
          current = Number(categoryByMid.get(current)?.parent) || 0;
        }
        return current;
      };
      for (const category of categories) {
        const currentParent = Number(category.parent) || 0;
        if (!deleting.has(category.mid) && deleting.has(currentParent)) {
          deleteStatements.push(db.update(schema.metas)
            .set({ parent: survivingParentFor(currentParent) })
            .where(and(eq(schema.metas.mid, category.mid), eq(schema.metas.type, 'category'))));
        }
      }
    }
    deleteStatements.push(
      db.delete(schema.relationships).where(sql`${schema.relationships.mid} IN (${deleteIdSql})`),
      db.delete(schema.metas).where(and(
        eq(schema.metas.type, type),
        sql`${schema.metas.mid} IN (${deleteIdSql})`,
      )),
    );
    await runBatch(db, deleteStatements);

    await bumpCacheVersion(db);
    await purgeSiteCache(options.siteUrl || '');
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'default' && mid && type === 'category') {
    const category = await db.query.metas.findFirst({
      where: and(eq(schema.metas.mid, mid), eq(schema.metas.type, 'category')),
    });
    if (!category) return new Response('分类不存在', { status: 404 });

    // Set as default category (save to options)
    const { setOption } = await import('@/lib/options');
    await setOption(db, 'defaultCategory', String(mid));
    await bumpCacheVersion(db);
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'refresh') {
    // G4-2: refresh meta counts using GROUP BY relationships in one query
    // rather than N+1 SELECT count(*) calls per meta row.
    let metas;
    let refreshIds: number[] = [];
    if (rawMids.length > 0) {
      const parsed = validateMetaIds(rawMids, '分类数据无效');
      if ('error' in parsed) return new Response(parsed.error, { status: 400 });
      refreshIds = parsed.ids;
    }
    if (refreshIds.length > 0) {
      metas = await db.select().from(schema.metas)
        .where(and(
          eq(schema.metas.type, type),
          sql`${schema.metas.mid} IN (${sql.join(refreshIds.map(id => sql`${id}`), sql`, `)})`,
        ));
    } else if (type) {
      metas = await db.select().from(schema.metas).where(eq(schema.metas.type, type));
    } else {
      metas = await db.select().from(schema.metas);
    }

    if (metas.length > 0) {
      const midList = sql.join(metas.map(m => sql`${m.mid}`), sql`, `);
      const counts = await db
        .select({ mid: schema.relationships.mid, count: sql<number>`count(*)` })
        .from(schema.relationships)
        .where(sql`${schema.relationships.mid} IN (${midList})`)
        .groupBy(schema.relationships.mid);

      const countMap = new Map<number, number>();
      for (const row of counts) countMap.set(row.mid, row.count);

      await runBatch(db, metas.map(meta => {
        const realCount = countMap.get(meta.mid) || 0;
        return db.update(schema.metas)
          .set({ count: realCount })
          .where(eq(schema.metas.mid, meta.mid));
      }));
    }

    await bumpCacheVersion(db);
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  return new Response('Invalid action', { status: 400 });
}
