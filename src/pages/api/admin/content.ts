import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { type SiteOptions } from '@/lib/options';
import { canManageResource } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { generateSlug } from '@/lib/content';
import { applyFilter, doHook } from '@/lib/plugin';
import { bumpCacheVersion } from '@/lib/cache';
import { jsonError, jsonOk } from '@/lib/http';
import { eq, and, sql } from 'drizzle-orm';

// Typecho convention: visibility dropdown maps to db status column.
// 'password' visibility stores the password in a separate column, status falls back to 'publish'.
const VISIBILITY_TO_STATUS: Record<string, string> = {
  publish: 'publish',
  hidden: 'hidden',
  password: 'publish',
  private: 'private',
  waiting: 'waiting',
};

const CUSTOM_FIELD_NAME_RE = /^[_a-zA-Z][_a-zA-Z0-9]*$/;
const CUSTOM_FIELD_TYPES = new Set(['str', 'int', 'float']);

function validateCustomFields(formData: FormData): string | null {
  const fieldNames = formData.getAll('fieldNames[]').map(value => value.toString().trim()).filter(Boolean);
  for (const name of fieldNames) {
    if (!CUSTOM_FIELD_NAME_RE.test(name)) return `自定义字段名 "${name}" 无效`;
    const type = formData.get(`fieldTypes[${name}]`)?.toString() || 'str';
    if (!CUSTOM_FIELD_TYPES.has(type)) return `自定义字段 "${name}" 的类型无效`;
  }
  return null;
}

/**
 * Save custom fields for a content item.
 * Handles the field[name], fieldNames[], fieldTypes[] form pattern from Typecho.
 */
function buildCustomFieldStatements(db: any, cid: number, formData: FormData): any[] {
  const statements = [db.delete(schema.fields).where(eq(schema.fields.cid, cid))];
  const fieldNames = formData.getAll('fieldNames[]').map((v: any) => v.toString().trim()).filter(Boolean);
  for (const name of fieldNames) {
    const type = formData.get(`fieldTypes[${name}]`)?.toString() || 'str';
    const rawValue = formData.get(`fieldValues[${name}]`)?.toString() || '';

    const fieldData: any = { cid, name, type, str_value: null, int_value: 0, float_value: 0 };

    if (type === 'int') {
      fieldData.int_value = parseInt(rawValue, 10) || 0;
    } else if (type === 'float') {
      fieldData.float_value = parseFloat(rawValue) || 0;
    } else {
      fieldData.str_value = rawValue;
    }

    statements.push(db.insert(schema.fields).values(fieldData).onConflictDoUpdate({
      target: [schema.fields.cid, schema.fields.name],
      set: { type: fieldData.type, str_value: fieldData.str_value, int_value: fieldData.int_value, float_value: fieldData.float_value },
    }));
  }
  return statements;
}

function parseTagNames(tags: string): string[] {
  return [...new Set(tags.split(',').map((t) => t.trim()).filter(Boolean))];
}

async function attachTags(db: any, cid: number, tags: string) {
  for (const tagName of parseTagNames(tags)) {
    const tagSlug = generateSlug(tagName) || tagName.toLowerCase().replace(/\s+/g, '-');
    let tagRow = await db.query.metas.findFirst({
      where: and(eq(schema.metas.slug, tagSlug), eq(schema.metas.type, 'tag')),
    });

    if (!tagRow) {
      const inserted = await db.insert(schema.metas).values({
        name: tagName,
        slug: tagSlug,
        type: 'tag',
        count: 0,
      }).returning({ mid: schema.metas.mid });
      tagRow = { mid: inserted[0].mid } as any;
    }

    if (!tagRow) continue;

    const existingRel = await db.query.relationships.findFirst({
      where: and(
        eq(schema.relationships.cid, cid),
        eq(schema.relationships.mid, tagRow.mid),
      ),
    });
    if (existingRel) continue;

    await db.batch([
      db.insert(schema.relationships).values({ cid, mid: tagRow.mid }),
      db.update(schema.metas)
        .set({ count: sql`${schema.metas.count} + 1` })
        .where(eq(schema.metas.mid, tagRow.mid)),
    ]);
  }
}

async function resolveUniqueContentSlug(db: any, desiredSlug: string, cid: number): Promise<string> {
  const base = desiredSlug || String(cid);
  let candidate = base;
  let suffix = 0;

  while (true) {
    const existing = await db.query.contents.findFirst({
      where: and(eq(schema.contents.slug, candidate), sql`${schema.contents.cid} != ${cid}`),
    });
    if (!existing) return candidate;
    suffix += 1;
    candidate = suffix === 1 ? `${base}-${cid}` : `${base}-${cid}-${suffix}`;
  }
}

async function purgeContentAndRelatedCache(
  db: any,
  _options: SiteOptions,
  _cid: number,
  fallbackContent?: typeof schema.contents.$inferSelect,
  /**
   * Extra category/tag URLs to purge — used when a piece of content is
   * being reassigned so the OLD categories/tags see their post lists
   * refresh alongside the new ones.
   */
  _extraUrls?: { categoryUrls?: string[]; tagUrls?: string[] },
) {
  const content = fallbackContent;

  // Skip cache work for drafts — they never appear on public pages, so
  // purging index/feed/category URLs is pure waste.
  const isDraft = content?.type?.endsWith('_draft') || content?.status === 'draft';
  if (isDraft) {
    return;
  }

  // Every public cache key embeds cacheVersion. A single version bump replaces
  // URL-by-URL purges and avoids loading relationships solely to build keys
  // that the Cache API no longer stores.
  await bumpCacheVersion(db);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const admin = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(admin)) return admin;
  const db = admin.db;
  const options = admin.options;
  const auth = { uid: admin.uid, user: admin.user };
  const pluginCtx = admin.pluginCtx;

  const formData = await request.formData();
  const action = formData.get('do')?.toString() || 'create';
  const typeInput = formData.get('type')?.toString() || 'post';
  const VALID_TYPES = ['post', 'page'];
  const type = VALID_TYPES.includes(typeInput) ? typeInput : 'post';
  const cid = parseInt(formData.get('cid')?.toString() || '0', 10);
  const title = formData.get('title')?.toString()?.trim() || '';
  const isMarkdown = formData.get('markdown') === '1';
  let text = formData.get('text')?.toString() || '';
  // Follow Typecho convention: prepend <!--markdown--> prefix based on editor type
  if (isMarkdown && !text.startsWith('<!--markdown-->')) {
    text = '<!--markdown-->' + text;
  }
  // Slug: use provided value, otherwise leave empty and fill with cid after insert (Typecho convention)
  const slugInput = formData.get('slug')?.toString()?.trim() || '';
  const submitAction = formData.get('status')?.toString() || 'publish'; // 'draft' or 'publish' from submit button
  const isDraft = submitAction === 'draft';
  const status = VISIBILITY_TO_STATUS[formData.get('visibility')?.toString() || ''] || 'publish';
  const password = formData.get('password')?.toString()?.trim() || null;
  const allowComment = formData.get('allowComment') ? '1' : '0';
  const allowPing = formData.get('allowPing') ? '1' : '0';
  const allowFeed = formData.get('allowFeed') ? '1' : '0';
  const tags = formData.get('tags')?.toString()?.trim() || '';
  const categoryIds = [...new Set(formData.getAll('category[]').map((v) => parseInt(v.toString(), 10)).filter(Boolean))];
  const template = formData.get('template')?.toString()?.trim() || null;
  const order = parseInt(formData.get('order')?.toString() || '0', 10) || 0;

  const now = Math.floor(Date.now() / 1000);

  const customFieldError = validateCustomFields(formData);
  if (customFieldError) return new Response(customFieldError, { status: 400 });

  // ── Schedule: accept optional datetime from the editor ──
  const scheduleDate = formData.get('date')?.toString()?.trim();
  let created = now;
  if (scheduleDate) {
    const parsed = Math.floor(new Date(scheduleDate).getTime() / 1000);
    if (Number.isFinite(parsed) && parsed > 0) created = Math.max(parsed, 1);
  }

  // ── Autosave: only allowed for draft-mode content ──
  const isAutosave = formData.get('autosave') === '1';
  const contentType = isDraft ? `${type}_draft` : type;

  if (isAutosave) {
    // Autosave rejection: cannot autosave published content
    if (cid) {
      const existing = await db.query.contents.findFirst({ where: eq(schema.contents.cid, cid) });
      if (!existing) return new Response('not-found', { status: 404 });
      if (existing.status === 'publish') return jsonError(400, 'autosave-not-allowed-for-published');
      if (!canManageResource(auth.user, existing)) return new Response('Forbidden', { status: 403 });
      await db.update(schema.contents).set({
        title: title || existing.title,
        text: text || existing.text,
        modified: now,
      } satisfies Record<string, unknown>).where(eq(schema.contents.cid, cid));
      return jsonOk({ cid, autosaved: true });
    }
    // New draft: create a post_draft row
    const inserted = await db.insert(schema.contents).values({
      title,
      slug: `autosave-${Date.now()}`,
      created,
      modified: now,
      text,
      order: 0,
      authorId: auth.uid,
      type: type === 'page' ? 'page_draft' : 'post_draft',
      status: 'draft',
    } satisfies Record<string, unknown>).returning({ cid: schema.contents.cid });
    if (!inserted.length) return new Response('创建失败', { status: 500 });
    const newCid = inserted[0].cid;
    return jsonOk({ cid: newCid, autosaved: true });
  }

  if (action === 'create') {
    // Typecho 1.3 derives an initial slug from the title, then falls back to
    // cid for titles that have no URL-safe characters.
    let contentData: Record<string, unknown> = {
      title,
      slug: slugInput || `temp-${Date.now().toString(36)}`,
      created,
      modified: now,
      text,
      order,
      authorId: auth.uid,
      template,
      type: contentType,
      status,
      password,
      allowComment,
      allowPing,
      allowFeed,
    };

    // Apply post:write or page:write filter
    const hookName = type === 'page' ? 'page:write' : 'post:write';
    contentData = await applyFilter(pluginCtx, hookName, contentData);

    const result = await db.insert(schema.contents).values(contentData as any).returning({ cid: schema.contents.cid });

    const newCid = result[0]?.cid;
    if (!newCid) return new Response('创建失败', { status: 500 });

    const finalSlug = await resolveUniqueContentSlug(db, slugInput || generateSlug(title) || String(newCid), newCid);
    const createStatements: any[] = [
      db.update(schema.contents).set({ slug: finalSlug }).where(eq(schema.contents.cid, newCid)),
      ...buildCustomFieldStatements(db, newCid, formData),
    ];
    if (categoryIds.length > 0) {
      createStatements.push(
        db.insert(schema.relationships).values(
          categoryIds.map((mid) => ({ cid: newCid, mid })),
        ),
        db.update(schema.metas)
        .set({ count: sql`${schema.metas.count} + 1` })
        .where(sql`${schema.metas.mid} IN (${sql.join(categoryIds.map(id => sql`${id}`), sql`, `)})`),
      );
    }
    await db.batch(createStatements as [any, ...any[]]);

    // Add tags
    if (tags) {
      await attachTags(db, newCid, tags);
    }

    // Trigger post/page finish hooks
    const finishData = { ...contentData, cid: newCid };
    if (!isDraft) {
      await doHook(pluginCtx, type === 'page' ? 'page:finishPublish' : 'post:finishPublish', finishData);
    }
    await doHook(pluginCtx, type === 'page' ? 'page:finishSave' : 'post:finishSave', finishData);

    await purgeContentAndRelatedCache(db, options, newCid, finishData as typeof schema.contents.$inferSelect);

    const editUrl = type === 'page' ? `/admin/write-page?cid=${newCid}` : `/admin/write-post?cid=${newCid}`;
    return new Response(null, {
      status: 302,
      headers: { Location: editUrl },
    });
  }

  if (action === 'update' && cid) {
    // Check ownership
    const existing = await db.query.contents.findFirst({
      where: eq(schema.contents.cid, cid),
    });
    if (!existing) return new Response('Not Found', { status: 404 });

    if (!canManageResource(auth.user, existing)) {
      return new Response('Forbidden', { status: 403 });
    }

    const finalSlug = await resolveUniqueContentSlug(db, slugInput || String(cid), cid);

    // Update categories: remove old, add new. Snapshot old category/tag
    // slugs first so we can purge their archive pages after the writes —
    // otherwise a re-categorised post keeps showing up on its previous
    // category page until the cacheVersion bumps invalidate everything.
    const oldRelMetas = await db.select({
      mid: schema.relationships.mid,
    })
      .from(schema.relationships)
      .where(eq(schema.relationships.cid, cid));
    const oldMids = oldRelMetas.map((r: any) => r.mid);

    const updateStatements: any[] = [
      db.update(schema.contents).set({
        title,
        slug: finalSlug,
        created,
        modified: now,
        text,
        order,
        template,
        type: contentType,
        status,
        password,
        allowComment,
        allowPing,
        allowFeed,
      }).where(eq(schema.contents.cid, cid)),
      ...buildCustomFieldStatements(db, cid, formData),
      db.delete(schema.relationships).where(eq(schema.relationships.cid, cid)),
    ];

    if (oldMids.length > 0) {
      updateStatements.push(db.update(schema.metas)
        .set({ count: sql`MAX(0, ${schema.metas.count} - 1)` })
        .where(and(
          sql`${schema.metas.mid} IN (${sql.join(oldMids.map(id => sql`${id}`), sql`, `)})`,
          sql`${schema.metas.type} IN ('category', 'tag')`,
        )));
    }

    if (categoryIds.length > 0) {
      updateStatements.push(
        db.insert(schema.relationships).values(
          categoryIds.map((mid) => ({ cid, mid })),
        ),
        db.update(schema.metas)
        .set({ count: sql`${schema.metas.count} + 1` })
        .where(sql`${schema.metas.mid} IN (${sql.join(categoryIds.map(id => sql`${id}`), sql`, `)})`),
      );
    }
    await db.batch(updateStatements as [any, ...any[]]);

    // Add tags
    if (tags) {
      await attachTags(db, cid, tags);
    }

    await purgeContentAndRelatedCache(db, options, cid, {
      ...existing,
      type: contentType,
      status,
    });

    const editUrl = type === 'page' ? `/admin/write-page?cid=${cid}` : `/admin/write-post?cid=${cid}`;
    return new Response(null, {
      status: 302,
      headers: { Location: editUrl },
    });
  }

  if (action === 'delete' && cid) {
    const existing = await db.query.contents.findFirst({
      where: eq(schema.contents.cid, cid),
    });
    if (!existing) return new Response('Not Found', { status: 404 });

    if (!canManageResource(auth.user, existing)) {
      return new Response('Forbidden', { status: 403 });
    }

    // Trigger pre-delete hook
    const isPage = existing.type?.startsWith('page');
    await doHook(pluginCtx, isPage ? 'page:delete' : 'post:delete', existing);

    // Decrement meta counts before deleting relationships (single UPDATE
    // over all mids linked to this content, restricted to category/tag
    // metas since those are the only rows whose count column is meaningful).
    const rels = await db.select({ mid: schema.relationships.mid })
      .from(schema.relationships)
      .where(eq(schema.relationships.cid, cid));
    const deleteStatements: any[] = [];
    if (rels.length > 0) {
      const mids = rels.map(r => r.mid);
      deleteStatements.push(db.update(schema.metas)
        .set({ count: sql`MAX(0, ${schema.metas.count} - 1)` })
        .where(and(
          sql`${schema.metas.mid} IN (${sql.join(mids.map(id => sql`${id}`), sql`, `)})`,
          sql`${schema.metas.type} IN ('category', 'tag')`,
        )));
    }
    deleteStatements.push(
      db.delete(schema.relationships).where(eq(schema.relationships.cid, cid)),
      db.delete(schema.comments).where(eq(schema.comments.cid, cid)),
      db.delete(schema.fields).where(eq(schema.fields.cid, cid)),
      db.delete(schema.contents).where(eq(schema.contents.cid, cid)),
    );
    await db.batch(deleteStatements as [any, ...any[]]);

    // Purge cache AFTER the row is gone. If we bump cacheVersion before
    // the delete, a concurrent public GET between bump and delete would
    // re-read the still-present row from D1 and cache it under the
    // fresh version — that cached corpse would then serve forever.
    await purgeContentAndRelatedCache(db, options, cid, existing);

    // Trigger post-delete hook
    await doHook(pluginCtx, isPage ? 'page:finishDelete' : 'post:finishDelete', existing);

    const redirectTo = isPage ? '/admin/manage-pages' : '/admin/manage-posts';
    return new Response(null, {
      status: 302,
      headers: { Location: redirectTo },
    });
  }

  return new Response('Invalid action', { status: 400 });
};
