import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { type SiteOptions } from '@/lib/options';
import { canManageResource } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { buildPermalink, generateSlug } from '@/lib/content';
import { applyFilter, doHook } from '@/lib/plugin';
import { invalidatePublicCache, type PublicCacheDomain } from '@/lib/cache';
import { jsonError, jsonOk } from '@/lib/http';
import { createAdminNoticeRedirectHeaders } from '@/lib/flash';
import { canViewContent } from '@/lib/content-visibility';
import { parseTrackbackUrls, sendTrackbacks, TrackbackInputError } from '@/lib/trackback';
import { eq, and, sql } from 'drizzle-orm';
import { parseBoundedIds, sqlInChunks } from '@/lib/d1-in';
import { SLUG_RESOLVE_MAX_SUFFIX } from '@/lib/constants';

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

/** Parse the Typecho editor's YYYY-MM-DD HH:mm value in the configured site timezone. */
export function parseEditorDate(value: string, timezoneOffsetSeconds: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const localTime = new Date(Date.UTC(year, month - 1, day, hour, minute));

  if (
    localTime.getUTCFullYear() !== year ||
    localTime.getUTCMonth() !== month - 1 ||
    localTime.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }

  const timestamp = Math.floor(localTime.getTime() / 1000) - timezoneOffsetSeconds;
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

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

function trackbackExcerpt(text: string): string {
  return text
    .replace(/^<!--markdown-->/, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
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

/**
 * Claim a unique slug for a content row with a compare-and-swap UPDATE.
 * The statement only takes effect while no OTHER row holds the candidate
 * (single atomic statement), so concurrent publishes of the same title
 * resolve to different slugs instead of tripping the unique index and
 * surfacing a 500. The CAS itself is the source of truth — callers must
 * not pre-check with a SELECT.
 *
 * Suffix convention mirrors the old SELECT-then-UPDATE loop: first
 * conflict appends `-{cid}`, later ones `-{cid}-{n}`.
 */
async function claimUniqueSlug(db: any, cid: number, base: string): Promise<string> {
  let candidate = base;
  let suffix = 0;
  while (suffix < SLUG_RESOLVE_MAX_SUFFIX) {
    const claimed = await db.update(schema.contents)
      .set({ slug: candidate })
      .where(and(
        eq(schema.contents.cid, cid),
        sql`NOT EXISTS (SELECT 1 FROM typecho_contents WHERE slug = ${candidate} AND cid != ${cid})`,
      ))
      .returning({ cid: schema.contents.cid });
    if (claimed.length > 0) return candidate;
    suffix += 1;
    candidate = suffix === 1 ? `${base}-${cid}` : `${base}-${cid}-${suffix}`;
  }
  // Pathological cap (same convention as install.ts): timestamp suffix.
  return `${base}-${Date.now().toString(36)}`;
}

type PageParentValidation = { parent: number } | { error: string };

/** Ensure a page parent exists and cannot make the page hierarchy cyclic. */
async function validatePageParent(db: any, rawValue: string, currentCid: number): Promise<PageParentValidation> {
  if (!/^\d+$/.test(rawValue)) return { error: '父级页面无效' };

  const parent = Number(rawValue);
  if (!Number.isSafeInteger(parent) || parent < 0) return { error: '父级页面无效' };
  if (parent === 0) return { parent: 0 };
  if (currentCid > 0 && parent === currentCid) return { error: '页面不能设为自己的父级页面' };

  const pages = await db.select({
    cid: schema.contents.cid,
    parent: schema.contents.parent,
  }).from(schema.contents).where(eq(schema.contents.type, 'page'));
  const pagesByCid = new Map<number, { cid: number; parent: number | null }>(
    pages.map((page: { cid: number; parent: number | null }) => [page.cid, page] as const),
  );

  if (!pagesByCid.has(parent)) return { error: '父级页面不存在' };

  let ancestor = parent;
  const visited = new Set<number>();
  while (ancestor > 0) {
    if (!visited.add(ancestor)) return { error: '父级页面层级无效' };
    if (currentCid > 0 && ancestor === currentCid) return { error: '父级页面不能是当前页面的子页面' };

    const page = pagesByCid.get(ancestor);
    if (!page) return { error: '父级页面层级无效' };
    const nextParent = Number(page.parent) || 0;
    if (!Number.isSafeInteger(nextParent) || nextParent < 0) return { error: '父级页面层级无效' };
    ancestor = nextParent;
  }

  return { parent };
}

/** Page-cache domain that renders this content type's detail pages. */
function detailDomainFor(type: string | null | undefined): PublicCacheDomain {
  return type?.startsWith('page') ? 'page' : 'post';
}

async function purgeContentAndRelatedCache(
  db: any,
  _options: SiteOptions,
  _cid: number,
  fallbackContent?: typeof schema.contents.$inferSelect,
  /**
   * Cache-relevant state of the content BEFORE this change. `wasPublic`
   * marks URLs that may already sit in public caches, so the detail domain
   * must be invalidated; `wasType` disambiguates the detail domain when the
   * content type changed.
   */
  extra?: { categoryUrls?: string[]; tagUrls?: string[]; wasPublic?: boolean; wasType?: string | null },
) {
  const content = fallbackContent;

  // Skip cache work for drafts — they never appear on public pages, so
  // purging index/feed/category URLs is pure waste.
  const isPublic = !!content && canViewContent(content, {});
  const wasPublic = !!extra?.wasPublic;
  // Publishing only moves the home/archive lists (and the feed/sitemap in
  // `other`); unrelated detail pages stay cached. Only content that WAS
  // public before can have a cached detail page, so its detail domain is
  // bumped just for updates and deletes — a first publish renders a brand
  // new URL with no cache entry to invalidate.
  const domains: PublicCacheDomain[] = [];
  if (isPublic || wasPublic) {
    domains.push('home', 'archive', 'other');
  }
  if (wasPublic) {
    for (const type of [extra?.wasType ?? content?.type, isPublic ? content?.type : null]) {
      const domain = detailDomainFor(type);
      if (!domains.includes(domain)) domains.push(domain);
    }
  }
  await invalidatePublicCache(db, {
    reason: 'content',
    domains,
    sharedDomains: [
      'navigation', 'sidebar', 'metas', 'comments', 'notes', 'archive', 'content',
      'admin-dashboard', 'admin-content', 'admin-comments', 'admin-metas', 'admin-media', 'admin-users',
    ],
  });
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
  const autosaveDraftId = parseInt(formData.get('autosaveDraftId')?.toString() || '0', 10);
  const title = formData.get('title')?.toString()?.trim() || '';
  const isMarkdown = formData.get('markdown') === '1';
  let text = formData.get('text')?.toString() || '';
  // Follow Typecho convention: prepend <!--markdown--> prefix based on editor type
  if (isMarkdown && !text.startsWith('<!--markdown-->')) {
    text = '<!--markdown-->' + text;
  }
  // The editor only sends a slug when the active content URL pattern exposes it.
  const permalinkPattern = type === 'page'
    ? options.pagePattern || '/{slug}.html'
    : options.permalinkPattern || '';
  const canEditSlug = permalinkPattern.includes('{slug}');
  const hasSubmittedSlug = formData.has('slug');
  const slugInput = formData.get('slug')?.toString()?.trim() || '';
  const submitAction = formData.get('status')?.toString() || 'publish'; // 'draft' or 'publish' from submit button
  const isDraft = submitAction === 'draft';
  const contentLabel = type === 'page' ? '页面' : '文章';
  const noticeTitle = title || '未命名文档';
  const successMessage = isDraft
    ? `草稿 "${noticeTitle}" 已经被保存`
    : `${contentLabel} "${noticeTitle}" 已经发布`;
  const status = VISIBILITY_TO_STATUS[formData.get('visibility')?.toString() || ''] || 'publish';
  const password = formData.get('password')?.toString()?.trim() || null;
  const allowComment = formData.get('allowComment') ? '1' : '0';
  const allowFeed = formData.get('allowFeed') ? '1' : '0';
  const tags = formData.get('tags')?.toString()?.trim() || '';
  const parsedCategoryIds = parseBoundedIds(formData.getAll('category[]'));
  if (parsedCategoryIds === null) return new Response('分类 ID 数据无效或超过 200 项', { status: 400 });
  const categoryIds = parsedCategoryIds;
  const template = formData.get('template')?.toString()?.trim() || null;
  const order = parseInt(formData.get('order')?.toString() || '0', 10) || 0;
  let submittedPageParent: number | undefined;
  if (type === 'page' && formData.has('parent') && (action === 'create' || action === 'update')) {
    const parentResult = await validatePageParent(
      db,
      formData.get('parent')?.toString()?.trim() || '',
      cid,
    );
    if ('error' in parentResult) return new Response(parentResult.error, { status: 400 });
    submittedPageParent = parentResult.parent;
  }

  const now = Math.floor(Date.now() / 1000);

  const customFieldError = validateCustomFields(formData);
  if (customFieldError) return new Response(customFieldError, { status: 400 });

  // ── Schedule: accept optional datetime from the editor ──
  const scheduleDate = formData.get('date')?.toString()?.trim();
  let created = now;
  if (scheduleDate) {
    const parsed = parseEditorDate(scheduleDate, Number(options.timezone) || 0);
    if (parsed !== null) created = parsed;
  }

  let trackbackUrls: string[];
  try {
    trackbackUrls = parseTrackbackUrls(formData.get('trackback')?.toString() || '');
  } catch (error) {
    const message = error instanceof TrackbackInputError ? error.message : '引用通告地址无效';
    return new Response(message, { status: 400 });
  }

  const sendSubmittedTrackbacks = async (publishedCid: number, publishedSlug: string) => {
    if (!options.siteUrl || type !== 'post' || isDraft || status !== 'publish' || created > now || trackbackUrls.length === 0) {
      return;
    }

    await sendTrackbacks(trackbackUrls, {
      blogName: `${options.title || 'Typecho'} » ${title}`,
      permalink: buildPermalink({
        cid: publishedCid,
        slug: publishedSlug,
        type: 'post',
        created,
      }, options.siteUrl, options.permalinkPattern),
      excerpt: trackbackExcerpt(text),
    });
  };

  // ── Autosave ──
  const isAutosave = formData.get('autosave') === '1';
  const contentType = isDraft ? `${type}_draft` : type;

  if (isAutosave) {
    if (cid) {
      const existing = await db.query.contents.findFirst({ where: eq(schema.contents.cid, cid) });
      if (!existing) return new Response('not-found', { status: 404 });
      if (!canManageResource(auth.user, existing)) return new Response('Forbidden', { status: 403 });

      // Published content must never be altered by a background save. Mirror
      // Typecho's draft behaviour by keeping a private, linked autosave row.
      if (existing.status === 'publish') {
        const draftType = `${type}_draft`;
        let draft = autosaveDraftId > 0
          ? await db.query.contents.findFirst({
            where: and(
              eq(schema.contents.cid, autosaveDraftId),
              eq(schema.contents.authorId, auth.uid),
              eq(schema.contents.parent, cid),
              eq(schema.contents.type, draftType),
            ),
          })
          : undefined;
        if (!draft) {
          draft = await db.query.contents.findFirst({
            where: and(
              eq(schema.contents.authorId, auth.uid),
              eq(schema.contents.parent, cid),
              eq(schema.contents.type, draftType),
              eq(schema.contents.status, 'draft'),
            ),
          });
        }
        if (draft) {
          await db.update(schema.contents).set({ title, text, modified: now })
            .where(eq(schema.contents.cid, draft.cid));
          return jsonOk({ cid, draftId: draft.cid, autosaved: true });
        }

        const inserted = await db.insert(schema.contents).values({
          title,
          slug: `autosave-${Date.now()}`,
          created: now,
          modified: now,
          text,
          order: 0,
          authorId: auth.uid,
          type: draftType,
          status: 'draft',
          parent: cid,
        } satisfies Record<string, unknown>).returning({ cid: schema.contents.cid });
        const draftId = inserted[0]?.cid;
        if (!draftId) return new Response('创建失败', { status: 500 });
        return jsonOk({ cid, draftId, autosaved: true });
      }

      await db.update(schema.contents).set({
        title,
        text,
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
    // cid for titles that have no URL-safe characters. The row is inserted
    // with a throwaway random slug; the real one is claimed atomically below
    // so two concurrent publishes of the same title cannot race on the
    // unique index (G: P1-4).
    let contentData: Record<string, unknown> = {
      title,
      slug: `temp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
      allowFeed,
      ...(type === 'page' ? { parent: submittedPageParent ?? 0 } : {}),
    };

    // Apply post:write or page:write filter
    const hookName = type === 'page' ? 'page:write' : 'post:write';
    contentData = await applyFilter(pluginCtx, hookName, contentData);

    const result = await db.insert(schema.contents).values(contentData as any).returning({ cid: schema.contents.cid });

    const newCid = result[0]?.cid;
    if (!newCid) return new Response('创建失败', { status: 500 });

    const finalSlug = await claimUniqueSlug(
      db,
      newCid,
      canEditSlug && hasSubmittedSlug && slugInput ? slugInput : generateSlug(title) || String(newCid),
    );
    // Finish hooks and the flash notice must see the claimed slug, not the
    // throwaway temp value used for the insert.
    contentData.slug = finalSlug;

    const createStatements: any[] = [
      ...buildCustomFieldStatements(db, newCid, formData),
    ];
    if (categoryIds.length > 0) {
      createStatements.push(
        db.insert(schema.relationships).values(
          categoryIds.map((mid) => ({ cid: newCid, mid })),
        ),
        db.update(schema.metas)
        .set({ count: sql`${schema.metas.count} + 1` })
        .where(sqlInChunks(schema.metas.mid, categoryIds)),
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

    await sendSubmittedTrackbacks(newCid, finalSlug);

    await purgeContentAndRelatedCache(db, options, newCid, finishData as typeof schema.contents.$inferSelect);

    const editUrl = type === 'page' ? `/admin/write-page?cid=${newCid}` : `/admin/write-post?cid=${newCid}`;
    const redirectUrl = isDraft
      ? editUrl
      : type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts';
    const noticeLink = isDraft ? undefined : {
      text: noticeTitle,
      href: buildPermalink(
        { cid: newCid, slug: finalSlug, type: contentType, created },
        options.siteUrl,
        options.permalinkPattern,
        options.pagePattern,
      ),
    };
    return new Response(null, {
      status: 302,
      headers: createAdminNoticeRedirectHeaders(redirectUrl, successMessage, 'success', '/', request, noticeLink),
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

    // Slug is claimed via compare-and-swap AFTER the field batch (below) —
    // a concurrent publish resolving the same slug retries with a -cid
    // suffix instead of violating the unique index (G: P1-4).
    const desiredSlug = canEditSlug && hasSubmittedSlug
      ? (slugInput || String(cid))
      : (existing.slug || String(cid));

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
        created,
        modified: now,
        text,
        order,
        template,
        type: contentType,
        status,
        password,
        allowComment,
        allowFeed,
        ...(type === 'page' ? { parent: submittedPageParent ?? existing.parent ?? 0 } : {}),
      }).where(eq(schema.contents.cid, cid)),
      ...buildCustomFieldStatements(db, cid, formData),
      db.delete(schema.relationships).where(eq(schema.relationships.cid, cid)),
    ];

    if (oldMids.length > 0) {
      updateStatements.push(db.update(schema.metas)
        .set({ count: sql`MAX(0, ${schema.metas.count} - 1)` })
        .where(and(
          sqlInChunks(schema.metas.mid, oldMids),
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
        .where(sqlInChunks(schema.metas.mid, categoryIds)),
      );
    }
    if (autosaveDraftId > 0 && autosaveDraftId !== cid) {
      updateStatements.push(db.delete(schema.contents).where(and(
        eq(schema.contents.cid, autosaveDraftId),
        eq(schema.contents.authorId, auth.uid),
        eq(schema.contents.parent, cid),
        eq(schema.contents.type, `${type}_draft`),
      )));
    }
    await db.batch(updateStatements as [any, ...any[]]);

    // Claim the slug atomically (see desiredSlug above) — may retry with a
    // -cid suffix when a concurrent publish won the race.
    const finalSlug = await claimUniqueSlug(db, cid, desiredSlug);

    // Add tags
    if (tags) {
      await attachTags(db, cid, tags);
    }

    await sendSubmittedTrackbacks(cid, finalSlug);

    await purgeContentAndRelatedCache(db, options, cid, {
      ...existing,
      type: contentType,
      status,
    }, { wasPublic: canViewContent(existing, {}), wasType: existing.type });

    const editUrl = type === 'page' ? `/admin/write-page?cid=${cid}` : `/admin/write-post?cid=${cid}`;
    const redirectUrl = isDraft
      ? editUrl
      : type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts';
    const noticeLink = isDraft ? undefined : {
      text: noticeTitle,
      href: buildPermalink(
        { cid, slug: finalSlug, type: contentType, created },
        options.siteUrl,
        options.permalinkPattern,
        options.pagePattern,
      ),
    };
    return new Response(null, {
      status: 302,
      headers: createAdminNoticeRedirectHeaders(redirectUrl, successMessage, 'success', '/', request, noticeLink),
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
          sqlInChunks(schema.metas.mid, mids),
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
    await purgeContentAndRelatedCache(db, options, cid, existing, {
      wasPublic: canViewContent(existing, {}),
    });

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
