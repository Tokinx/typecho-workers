import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { generateRandomString } from '@/lib/auth';
import {
  getCachedOptions,
  setCachedOptions,
  resetCacheVersionMemo,
} from '@/lib/cache';
import {
  advanceOptionsSnapshotGeneration,
  getOptionsSnapshotGeneration,
} from '@/lib/options-snapshot-generation';
import { notifyEarlyRequestInvalidation } from '@/lib/early-request';

export interface SiteOptions {
  theme: string;
  timezone: number;
  lang: string;
  charset: string;
  contentType: string;
  title: string;
  description: string;
  keywords: string;
  siteUrl: string;
  frontPage: string;
  frontArchive: number;
  pageSize: number;
  postsListSize: number;
  commentsListSize: number;
  postDateFormat: string;
  commentDateFormat: string;
  defaultCategory: number;
  allowRegister: number;
  allowXmlRpc: number;
  defaultAllowComment: number;
  defaultAllowPing: number;
  defaultAllowFeed: number;
  feedFullText: number;
  markdown: number;
  commentsRequireMail: number;
  commentsRequireURL: number;
  commentsRequireModeration: number;
  commentsWhitelist: number;
  commentsMaxNestingLevels: number;
  commentsPostTimeout: number;
  commentsUrlNofollow: number;
  commentsShowUrl: number;
  commentsMarkdown: number;
  commentsPageBreak: number;
  commentsThreaded: number;
  commentsPageSize: number;
  commentsPageDisplay: string;
  commentsOrder: string;
  commentsCheckReferer: number;
  commentsAutoClose: number;
  commentsPostIntervalEnable: number;
  commentsPostInterval: number;
  commentsShowCommentOnly: number;
  commentsAvatar: number;
  commentsAvatarRating: string;
  commentsAntiSpam: number;
  commentsHTMLTagAllowed: string | null;
  attachmentTypes: string;
  secret: string;
  installed: number;
  editorSize: number;
  autoSave: number;
  cacheEnabled: number;
  cacheVersion: number;
  activatedPlugins: string;
  permalinkPattern: string;
  pagePattern: string;
  categoryPattern: string;
  loginFailBanEnabled: number;
  loginFailBanWindowSeconds: number;
  loginFailBanMaxFailures: number;
  loginFailBanSeconds: number;
  feedItems: number;
  [key: string]: string | number | null | undefined;
}

const defaultOptions: Partial<SiteOptions> = {
  theme: 'typecho-theme-minimal',
  timezone: 28800,
  lang: 'zh_CN',
  charset: 'UTF-8',
  contentType: 'text/html',
  title: 'Hello World',
  description: 'Your description here.',
  keywords: 'typecho,blog',
  frontPage: 'recent',
  frontArchive: 0,
  pageSize: 5,
  postsListSize: 10,
  commentsListSize: 10,
  postDateFormat: 'Y-m-d',
  commentDateFormat: 'F jS, Y',
  defaultCategory: 1,
  allowRegister: 0,
  allowXmlRpc: 2,
  defaultAllowComment: 1,
  defaultAllowPing: 1,
  defaultAllowFeed: 1,
  feedFullText: 1,
  markdown: 1,
  commentsRequireMail: 1,
  commentsRequireURL: 0,
  commentsRequireModeration: 0,
  commentsWhitelist: 0,
  commentsMaxNestingLevels: 5,
  commentsPostTimeout: 24 * 3600 * 30,
  commentsUrlNofollow: 1,
  commentsShowUrl: 1,
  commentsMarkdown: 0,
  commentsPageBreak: 0,
  commentsThreaded: 1,
  commentsPageSize: 20,
  commentsPageDisplay: 'last',
  commentsOrder: 'ASC',
  commentsCheckReferer: 1,
  commentsAutoClose: 0,
  commentsPostIntervalEnable: 1,
  commentsPostInterval: 60,
  commentsShowCommentOnly: 0,
  commentsAvatar: 1,
  commentsAvatarRating: 'G',
  commentsAntiSpam: 1,
  commentsHTMLTagAllowed: null,
  attachmentTypes: '@image@',
  cacheEnabled: 1,
  cacheVersion: 0,
  installed: 0,
  editorSize: 350,
  autoSave: 0,
  loginFailBanEnabled: 1,
  loginFailBanWindowSeconds: 300,
  loginFailBanMaxFailures: 5,
  loginFailBanSeconds: 900,
  feedItems: 10,
};

// Site options change rarely. Local writes invalidate this snapshot
// immediately; writes from another PoP become visible after at most one
// minute, avoiding an inter-region D1 version read every five seconds.
const OPTIONS_SNAPSHOT_TTL_MS = 60_000;
type OptionsSnapshot = { value: SiteOptions; expiresAt: number; generation: number };
type PendingOptionsLoad = { promise: Promise<SiteOptions>; generation: number };
const optionSnapshots = new WeakMap<Database, OptionsSnapshot>();
const pendingOptionLoads = new WeakMap<Database, PendingOptionsLoad>();

function invalidateOptionsSnapshot(db: Database): void {
  advanceOptionsSnapshotGeneration(db);
  optionSnapshots.delete(db);
  pendingOptionLoads.delete(db);
}

async function executeOptionBatch(db: Database, statements: any[]): Promise<void> {
  if (typeof (db as any).batch === 'function') {
    await (db as any).batch(statements);
    return;
  }
  // Lightweight plugin adapters and unit-test doubles may implement only
  // Drizzle statements. Production D1 always takes the single-round-trip path.
  for (const statement of statements) await statement;
}

function cacheVersionUpsert(db: Database) {
  return db
    .insert(schema.options)
    .values({ name: 'cacheVersion', user: 0, value: '1' })
    .onConflictDoUpdate({
      target: [schema.options.name, schema.options.user],
      set: {
        value: sql`cast(coalesce(${schema.options.value}, '0') as integer) + 1`,
      },
    });
}

/**
 * Load all global options from database (with Cache API caching).
 *
 * This is a pure loader — it never mutates the row set. Call
 * `ensureSecret()` once at install time (or during migration) to
 * bootstrap the `secret` option. A missing secret here surfaces as
 * `opts.secret === undefined` so downstream code can fail fast rather
 * than picking up a race-generated value that varies between requests.
 */
export async function loadOptions(db: Database): Promise<SiteOptions> {
  const now = Date.now();
  const generation = getOptionsSnapshotGeneration(db);
  const snapshot = optionSnapshots.get(db);
  if (
    snapshot &&
    snapshot.generation === generation &&
    snapshot.expiresAt > now
  ) {
    return { ...snapshot.value };
  }

  const existingLoad = pendingOptionLoads.get(db);
  if (existingLoad?.generation === generation) {
    return { ...await existingLoad.promise };
  }

  const pending = loadOptionsFresh(db);
  const pendingRecord = { promise: pending, generation };
  pendingOptionLoads.set(db, pendingRecord);
  try {
    const value = await pending;
    if (getOptionsSnapshotGeneration(db) === generation) {
      optionSnapshots.set(db, {
        value,
        expiresAt: Date.now() + OPTIONS_SNAPSHOT_TTL_MS,
        generation,
      });
    }
    return { ...value };
  } finally {
    if (pendingOptionLoads.get(db) === pendingRecord) {
      pendingOptionLoads.delete(db);
    }
  }
}

async function loadOptionsFresh(db: Database): Promise<SiteOptions> {
  // Try cache first — key is versioned by cacheVersion so cross-PoP
  // writes automatically bust the entry (one D1 read is much cheaper
  // than reloading all rows).
  const cached = await getCachedOptions(db);
  if (cached) {
    return cached as unknown as SiteOptions;
  }

  const rows = await db
    .select()
    .from(schema.options)
    .where(eq(schema.options.user, 0));

  const opts: Record<string, string | number | null | undefined> = { ...defaultOptions };
  for (const row of rows) {
    opts[row.name] = row.value;
  }

  // Parse numeric values
  const numericKeys = [
    'timezone', 'frontArchive', 'pageSize', 'postsListSize',
    'commentsListSize', 'defaultCategory', 'allowRegister', 'allowXmlRpc', 'defaultAllowComment',
    'defaultAllowPing', 'defaultAllowFeed', 'feedFullText', 'markdown',
    'commentsRequireMail', 'commentsRequireURL', 'commentsRequireModeration',
    'commentsWhitelist', 'commentsMaxNestingLevels', 'commentsPostTimeout',
    'commentsUrlNofollow', 'commentsShowUrl', 'commentsMarkdown',
    'commentsPageBreak', 'commentsThreaded', 'commentsPageSize',
    'commentsCheckReferer', 'commentsAutoClose', 'commentsPostIntervalEnable',
    'commentsPostInterval', 'commentsShowCommentOnly', 'commentsAvatar',
    'commentsAntiSpam', 'installed', 'editorSize', 'autoSave',
    'gzip', 'cacheEnabled', 'cacheVersion',
    'loginFailBanEnabled', 'loginFailBanWindowSeconds',
    'loginFailBanMaxFailures', 'loginFailBanSeconds',
    'feedItems',
  ];

  for (const key of numericKeys) {
    if (typeof opts[key] === 'string') {
      opts[key] = parseInt(opts[key] as string, 10) || 0;
    }
  }

  // Write to cache for subsequent requests, keyed by the version stamp
  // present at read time.
  await setCachedOptions(opts, opts.cacheVersion ?? 0);

  return opts as unknown as SiteOptions;
}

/**
 * Ensure the site has a `secret` option, generating one if missing. Kept
 * out of loadOptions() so the read path stays free of writes — otherwise
 * the very first request on a legacy PHP-Typecho migration would race
 * multiple isolates each generating a different secret.
 *
 * Callers: install flow (on fresh setup) and a one-shot migration path
 * for imported PHP databases where the secret used to live in
 * config.inc.php.
 */
export async function ensureSecret(db: Database): Promise<string> {
  const existing = await getOption(db, 'secret');
  if (existing) return existing;
  const secret = generateRandomString(32);
  await setOption(db, 'secret', secret);
  return secret;
}

/**
 * Get a single option value
 */
export async function getOption(db: Database, name: string, userId = 0): Promise<string | null> {
  const row = await db.query.options.findFirst({
    where: and(eq(schema.options.name, name), eq(schema.options.user, userId)),
  });
  return row?.value ?? null;
}

/**
 * Set an option value. Bumps the shared cacheVersion so every PoP's
 * options-cache read on the next request misses (via the versioned
 * cache key in cache.ts) — this is the only cross-PoP-safe invalidation
 * primitive we have.
 *
 * The bump happens BEFORE the write to close a race where a concurrent
 * read could still hit the pre-bump cache key: readers on the next
 * request see the new cacheVersion, miss the cache, and reload from D1.
 */
export async function setOption(db: Database, name: string, value: string, userId = 0): Promise<void> {
  const write = db
    .insert(schema.options)
    .values({ name, user: userId, value })
    .onConflictDoUpdate({
      target: [schema.options.name, schema.options.user],
      set: { value },
    });
  if (name === 'cacheVersion') {
    await write;
  } else {
    await executeOptionBatch(db, [
      write,
      cacheVersionUpsert(db),
    ]);
    resetCacheVersionMemo();
  }
  invalidateOptionsSnapshot(db);
  if (name !== 'cacheVersion') {
    await notifyEarlyRequestInvalidation({
      reason: 'option-set',
      domains: ['all'],
      ...(userId === 0 ? { options: { [name]: value } } : {}),
    });
  }
}

/**
 * Delete an option. Bumps cacheVersion — see setOption().
 */
export async function deleteOption(db: Database, name: string, userId = 0): Promise<void> {
  const remove = db
    .delete(schema.options)
    .where(and(eq(schema.options.name, name), eq(schema.options.user, userId)));
  if (name === 'cacheVersion') {
    await remove;
  } else {
    await executeOptionBatch(db, [
      remove,
      cacheVersionUpsert(db),
    ]);
    resetCacheVersionMemo();
  }
  invalidateOptionsSnapshot(db);
  if (name !== 'cacheVersion') {
    await notifyEarlyRequestInvalidation({
      reason: 'option-delete',
      domains: ['all'],
      ...(userId === 0 ? { options: { [name]: undefined } } : {}),
    });
  }
}

/**
 * Write many options in one batch and bump cacheVersion exactly once at
 * the end. Prefer this over a loop of `setOption()` calls whenever the
 * updates are semantically one atomic change (install, admin bulk save)
 * — it halves D1 writes because the per-key cacheVersion bumps are
 * collapsed into a single bump.
 *
 * Any entry named `cacheVersion` is applied but never triggers a
 * secondary bump (would recurse).
 */
export async function setOptionsBatch(
  db: Database,
  entries: Record<string, string>,
  userId = 0,
): Promise<void> {
  await mutateOptionsBatch(db, { set: entries }, userId);
}

export interface OptionMutations {
  set?: Record<string, string>;
  delete?: string[];
}

/** Apply option upserts/deletes and advance cacheVersion once. */
export async function mutateOptionsBatch(
  db: Database,
  mutations: OptionMutations,
  userId = 0,
): Promise<void> {
  const entries = mutations.set || {};
  const keys = Object.keys(entries);
  const deleteKeys = [...new Set(mutations.delete || [])].filter(name => !keys.includes(name));
  if (keys.length === 0 && deleteKeys.length === 0) return;
  const statements = keys.map((name) =>
    db
      .insert(schema.options)
      .values({ name, user: userId, value: entries[name] })
      .onConflictDoUpdate({
        target: [schema.options.name, schema.options.user],
        set: { value: entries[name] },
      })
  );
  for (const name of deleteKeys) {
    statements.push(db.delete(schema.options).where(and(
      eq(schema.options.name, name),
      eq(schema.options.user, userId),
    )) as any);
  }
  statements.push(cacheVersionUpsert(db));
  await executeOptionBatch(db, statements);
  // The batch wrote a new version without going through bumpCacheVersion().
  // Force the next local read to observe it instead of serving the old memo.
  resetCacheVersionMemo();
  invalidateOptionsSnapshot(db);
  await notifyEarlyRequestInvalidation({
    reason: 'options-batch',
    domains: ['all'],
    ...(userId === 0 ? {
      options: {
        ...Object.fromEntries(deleteKeys.map(name => [name, undefined])),
        ...entries,
      },
    } : {}),
  });
}

/**
 * Compute derived URLs from options
 */
export function computeUrls(opts: SiteOptions) {
  const siteUrl = opts.siteUrl?.replace(/\/$/, '') || '';
  return {
    siteUrl,
    adminUrl: `${siteUrl}/admin/`,
    loginUrl: `${siteUrl}/admin/login`,
    logoutUrl: `${siteUrl}/api/users/logout`,
    profileUrl: `${siteUrl}/admin/profile`,
    feedUrl: `${siteUrl}/feed`,
    feedRssUrl: `${siteUrl}/feed/rss`,
    feedAtomUrl: `${siteUrl}/feed/atom`,
    commentsFeedUrl: `${siteUrl}/feed/comments`,
    commentsFeedRssUrl: `${siteUrl}/feed/rss/comments`,
    commentsFeedAtomUrl: `${siteUrl}/feed/atom/comments`,
    themeUrl: (file: string) => `${siteUrl}/themes/${opts.theme}/${file}`,
  };
}
