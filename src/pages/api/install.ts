import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { setOptionsBatch, deleteOption, getOption } from '@/lib/options';
import { hashPassword, generateRandomString, timeSafeEqual } from '@/lib/auth';
import { env } from 'cloudflare:workers';
import { generateCreateSQL } from '@/lib/schema-sql';
import { PASSWORD_MIN_LENGTH, SLUG_RESOLVE_MAX_SUFFIX } from '@/lib/constants';
import { eq } from 'drizzle-orm';

/**
 * Pick a slug that doesn't collide with an existing one. We append a
 * counter rather than a random suffix so the resulting URL stays
 * predictable for users who paste the install instructions verbatim.
 */
async function resolveSlug(db: ReturnType<typeof getDb>, base: string): Promise<string> {
  let candidate = base;
  let suffix = 1;
  while (suffix < SLUG_RESOLVE_MAX_SUFFIX) {
    const existing = await db.query.contents.findFirst({ where: eq(schema.contents.slug, candidate) });
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  // Fallback: timestamp suffix if we somehow hit the cap on pathological data.
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Create all tables and indexes from Drizzle schema definitions.
 * Source of truth: src/db/schema.ts (no migration files needed).
 */
async function ensureTables(d1: D1Database): Promise<void> {
  const statements = generateCreateSQL();
  // D1 batch() executes all statements in a single round-trip
  await d1.batch(statements.map(sql => d1.prepare(sql)));
}

/**
 * The install window is open from "tables don't exist" until installed=1.
 * If `INSTALL_TOKEN` is configured as a Cloudflare secret, the form must
 * present it to proceed — this closes the race where the very first
 * visitor of a freshly-deployed worker becomes admin. When unset (most
 * deployments today), we keep the legacy "first visitor wins" behaviour
 * but log a warning to nudge operators toward setting the secret.
 */
function expectedInstallToken(): string {
  const e = env as unknown as { INSTALL_TOKEN?: string };
  return typeof e.INSTALL_TOKEN === 'string' ? e.INSTALL_TOKEN : '';
}

export const POST: APIRoute = async ({ request }) => {
  const d1 = env.DB;
  const db = getDb(d1);

  // Refuse the install endpoint outright once installed=1. The 302 to /admin/
  // that used to sit further down would let an attacker at least confirm the
  // site was already provisioned; a flat 403 gives them nothing to work with.
  //
  // We probe options before touching formData so a hostile POST can't force
  // table creation to fail early and mask the check.
  try {
    const installed = await getOption(db, 'installed');
    if (installed === '1') {
      return new Response('Site already installed', { status: 403 });
    }
  } catch {
    // Tables not yet created → the install window is still open, fall through.
  }

  const formData = await request.formData();
  const siteTitle = formData.get('siteTitle')?.toString() || 'Hello World';
  const siteDescription = formData.get('siteDescription')?.toString() || '';
  const userName = formData.get('userName')?.toString()?.trim() || '';
  const userPassword = formData.get('userPassword')?.toString() || '';
  const userMail = formData.get('userMail')?.toString()?.trim() || '';
  const installToken = formData.get('installToken')?.toString() || '';

  // Gate the install window with a deploy-time secret if configured.
  const expected = expectedInstallToken();
  if (expected) {
    if (!timeSafeEqual(installToken, expected)) {
      return new Response('安装令牌无效', { status: 403 });
    }
  } else {
    console.warn('[install] INSTALL_TOKEN secret not set; the install form is open to the first caller until setup completes. Set `wrangler secret put INSTALL_TOKEN` to lock down the install window.');
  }

  if (!userName || !userPassword || !userMail) {
    return new Response('请填写完整信息', { status: 400 });
  }

  if (userPassword.length < PASSWORD_MIN_LENGTH) {
    return new Response(`密码长度至少${PASSWORD_MIN_LENGTH}位`, { status: 400 });
  }

  try {
    // Auto-create tables if they don't exist
    await ensureTables(d1);

    // Re-check after table creation in case another concurrent install races us.
    const installed = await getOption(db, 'installed');
    if (installed === '1') {
      return new Response('Site already installed', { status: 403 });
    }

    // Race-lock: try to claim an exclusive `installing` row backed by the
    // unique `typecho_options_name_user` index. If the row already
    // exists another isolate is mid-install; back off with 409 so they
    // can finish.
    const stampToken = generateRandomString(24);
    const existingLock = await db.query.options.findFirst({
      where: (t, { and, eq }) => and(eq(t.name, 'installing'), eq(t.user, 0)),
    });
    if (existingLock) {
      return new Response('Site install already in progress', { status: 409 });
    }
    try {
      await db.insert(schema.options).values({ name: 'installing', user: 0, value: stampToken });
    } catch {
      // Unique-index collision → another isolate raced us to the insert.
      return new Response('Site install already in progress', { status: 409 });
    }

    // Create admin user
    const hashedPassword = await hashPassword(userPassword);
    const authCode = generateRandomString(32);
    const now = Math.floor(Date.now() / 1000);

    const insertedAdmin = await db.insert(schema.users).values({
      name: userName,
      password: hashedPassword,
      mail: userMail,
      url: new URL(request.url).origin,
      screenName: userName,
      created: now,
      activated: now,
      logged: now,
      group: 'administrator',
      authCode,
    }).returning({ uid: schema.users.uid });
    const adminUid = insertedAdmin[0]?.uid ?? 1;

    // Create default category
    const insertedCategory = await db.insert(schema.metas).values({
      name: '默认分类',
      slug: 'default',
      type: 'category',
      description: '只是一个默认分类',
      count: 1,
      order: 1,
    }).returning({ mid: schema.metas.mid });
    const categoryMid = insertedCategory[0]?.mid ?? 1;

    // G7-8: probe slug uniqueness in case the worker reattached to an
    // already-populated D1 instance (e.g. mid-rollback). resolveSlug
    // appends a numeric suffix until no clash is found.
    const helloSlug = await resolveSlug(db, 'hello-world');
    const aboutSlug = await resolveSlug(db, 'about');

    // Create welcome post
    const insertedHello = await db.insert(schema.contents).values({
      title: '欢迎使用 Typecho',
      slug: helloSlug,
      created: now,
      modified: now,
      text: '<!--markdown-->欢迎使用 Typecho 博客系统。这是你的第一篇文章，你可以编辑或删除它，然后开始写作！\n\n## 关于 Typecho\n\nTypecho 是一个基于 **Astro + Cloudflare Workers + D1** 构建的现代博客系统。\n\n- 极速响应：基于 Cloudflare 边缘网络\n- Markdown 支持：使用 Markdown 撰写文章\n- 简洁高效：保持博客系统的简约之道',
      authorId: adminUid,
      type: 'post',
      status: 'publish',
      allowComment: '1',
      allowPing: '1',
      allowFeed: '1',
    }).returning({ cid: schema.contents.cid });
    const helloCid = insertedHello[0]?.cid ?? 1;

    // G7-2: link the welcome post to the default category by real ids.
    await db.insert(schema.relationships).values({ cid: helloCid, mid: categoryMid });

    // Create about page
    await db.insert(schema.contents).values({
      title: '关于',
      slug: aboutSlug,
      created: now,
      modified: now,
      text: '<!--markdown-->这是一个关于页面的示例。你可以在后台管理中编辑它。',
      authorId: adminUid,
      type: 'page',
      status: 'publish',
      allowComment: '1',
      allowPing: '0',
      allowFeed: '1',
      order: 0,
    });

    // Set default options
    const siteUrl = new URL(request.url).origin;
    const secret = generateRandomString(32);

    const defaultOptions: Record<string, string> = {
      theme: 'typecho-theme-warm',
      timezone: '28800',
      lang: 'zh_CN',
      charset: 'UTF-8',
      contentType: 'text/html',
      title: siteTitle,
      description: siteDescription,
      keywords: 'blog',
      siteUrl,
      frontPage: 'recent',
      frontArchive: '0',
      pageSize: '5',
      postsListSize: '10',
      commentsListSize: '10',
      postDateFormat: 'Y-m-d',
      commentDateFormat: 'Y-m-d H:i',
      defaultCategory: String(categoryMid),
      allowRegister: '0',
      allowXmlRpc: '2',
      defaultAllowComment: '1',
      defaultAllowPing: '1',
      defaultAllowFeed: '1',
      feedFullText: '1',
      markdown: '1',
      commentsRequireMail: '1',
      commentsRequireURL: '0',
      commentsRequireModeration: '0',
      commentsWhitelist: '0',
      commentsMaxNestingLevels: '5',
      commentsPostTimeout: String(24 * 3600 * 30),
      commentsUrlNofollow: '1',
      commentsShowUrl: '1',
      commentsMarkdown: '0',
      commentsPageBreak: '0',
      commentsThreaded: '1',
      commentsPageSize: '20',
      commentsPageDisplay: 'last',
      commentsOrder: 'ASC',
      commentsCheckReferer: '1',
      commentsAutoClose: '0',
      commentsPostIntervalEnable: '1',
      commentsPostInterval: '60',
      commentsShowCommentOnly: '0',
      commentsAvatar: '1',
      commentsAvatarRating: 'G',
      commentsAntiSpam: '1',
      attachmentTypes: '@image@',
      secret,
      installed: '1',
      editorSize: '350',
      autoSave: '0',
    };

    // Write all default options in one batch — a single cacheVersion
    // bump at the end instead of ~40 (once per setOption call).
    await setOptionsBatch(db, defaultOptions);

    // Release the install lock. If it's already gone (retry, manual
    // cleanup) the delete is a no-op.
    await deleteOption(db, 'installing');

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login' },
    });
  } catch (error) {
    console.error('Installation error:', error);
    // Best-effort lock release so a transient failure doesn't wedge the
    // install form permanently.
    try {
      await deleteOption(db, 'installing');
    } catch {
      // If we can't reach D1 at all, there is nothing more we can do here.
    }
    return new Response('安装失败，请检查数据库配置', {
      status: 500,
    });
  }
};
