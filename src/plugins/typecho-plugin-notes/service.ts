import { schema } from 'typecho/db';
import type { Database } from 'typecho/db';
import { buildPermalink, renderMarkdown } from 'typecho/plugin-sdk';
import { invalidatePublicCache } from '@/lib/cache';
import { getClientIp } from '@/lib/context';
import { renderCommentText } from '@/lib/markdown';
import { parseAttachmentMeta } from '@/lib/attachment';
import { jsonError, jsonOk } from '@/lib/http';
import { and, asc, count, desc, eq, gt, inArray, like, lte, min, or, sql } from 'drizzle-orm';

export const NOTE_TYPE = 'note';
export const NOTE_TOPIC_TYPE = 'note_topic';
export const NOTE_REFERENCE_PATTERN = '/note/<cid>';

type NoteStatus = 'publish' | 'private' | 'draft';
type ListMode = 'notes' | 'mixed';

export interface NotesActionContext {
  db: Database;
  uid: number;
  user?: {
    name?: string | null;
    screenName?: string | null;
    mail?: string | null;
    url?: string | null;
  };
  options?: Record<string, any>;
}

export interface ThemeNotesQuery {
  /** A Topic ID, slug, or name. */
  topic?: number | string | null;
  /** Logged-in author whose private notes may be included. */
  viewerUid?: number | null;
  page?: number;
  pageSize?: number;
}

export interface ThemeNotesOptions {
  siteUrl?: string;
  permalinkPattern?: string | null;
}

export interface NoteTopic {
  mid: number;
  name: string;
  slug: string;
  count?: number;
}

export interface NoteListItem {
  cid: number;
  type: 'note' | 'post';
  title: string;
  permalink: string;
  source: string;
  html: string;
  created: number;
  modified: number;
  status: string;
  comments: number;
  allowComment: boolean;
  topics: NoteTopic[];
  /** Kept for the first Notes admin release. Prefer `topics`. */
  topic: NoteTopic | null;
  images: Array<{ cid: number; name: string; url: string }>;
}

export interface NotesListResult {
  data: NoteListItem[];
  topics: NoteTopic[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  stats: { days: number; notes: number; posts: number };
}

export interface NotesThemeVariables {
  /** Public notes plus the current author's private notes when `viewerUid` is set. */
  notes: NoteListItem[];
  /** Public posts merged with the notes visible to the current viewer. */
  mixed: NoteListItem[];
  topics: NoteTopic[];
  pagination: {
    notes: NotesListResult['pagination'];
    mixed: NotesListResult['pagination'];
  };
}

interface NoteInput {
  content: string;
  status: NoteStatus;
  /** Legacy/manual Topic selection. Extracted Topics are always added as well. */
  topicMid: number;
}

interface ListOptions extends ThemeNotesQuery {
  admin?: boolean;
  cid?: number;
  keywords?: string | null;
  mode?: ListMode;
  siteUrl?: string;
  permalinkPattern?: string | null;
}

const HASH_TOPIC_RE = /(^|[^\p{L}\p{N}_/])#([\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}][\p{L}\p{N}_\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D-]{0,39})/gu;
const NOTE_REFERENCE_RE = /(^|[^\p{L}\p{N}_/~])\/note\/([1-9]\d*)\b/gu;

function clampInteger(value: number | string | null | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function stripMarkdownMarker(value: string): string {
  return value.startsWith('<!--markdown-->') ? value.slice('<!--markdown-->'.length) : value;
}

function noteText(value: string): string {
  return value.startsWith('<!--markdown-->') ? value : `<!--markdown-->${value}`;
}

function parseStatus(value: unknown): NoteStatus {
  return value === 'private' || value === 'draft' ? value : 'publish';
}

function topicKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

/**
 * Extract Wing-compatible hashtags while avoiding URL fragments and escaped
 * hashes. Topic names are limited so one accidental paste cannot create an
 * unbounded number of metas.
 */
export function extractTopicNames(content: string): string[] {
  const names = new Map<string, string>();
  const source = stripMarkdownMarker(content);
  for (const match of source.matchAll(HASH_TOPIC_RE)) {
    const offset = match.index || 0;
    if (match[1] === '\\' || (offset > 0 && source[offset - 1] === '\\')) continue;
    const name = (match[2] || '').normalize('NFKC').trim();
    if (!name) continue;
    const key = topicKey(name);
    if (!names.has(key)) names.set(key, name);
    if (names.size >= 12) break;
  }
  return [...names.values()];
}

export function normalizeNoteInput(value: unknown): NoteInput {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) throw new Error('笔记内容不能为空');
  if (content.length > 200_000) throw new Error('笔记内容不能超过 200000 个字符');
  const topicMid = Number.parseInt(String(body.topicMid || 0), 10);
  return {
    content,
    status: parseStatus(body.status),
    topicMid: Number.isFinite(topicMid) && topicMid > 0 ? topicMid : 0,
  };
}

export function topicSlug(name: string): string {
  const normalized = name.normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || `topic-${Date.now().toString(36)}`;
}

/** Convert reference text into an anchor after Markdown sanitation. */
export function renderNoteContent(value: string, topicBaseUrl = ''): string {
  const html = renderMarkdown(value);
  const topics = new Set(extractTopicNames(value).map(topicKey));
  const topicHref = topicBaseUrl
    ? `${topicBaseUrl.replace(/\/$/, '')}/?stream=notes&topic=`
    : '?topic=';
  let protectedDepth = 0;
  return html.split(/(<[^>]+>)/g).map(part => {
    if (part.startsWith('<')) {
      const tag = part.match(/^<\s*(\/?)\s*([a-z0-9]+)/i);
      if (tag) {
        const closing = tag[1] === '/';
        const name = tag[2].toLowerCase();
        if (closing && (name === 'a' || name === 'code' || name === 'pre')) protectedDepth = Math.max(0, protectedDepth - 1);
        if (!closing && (name === 'a' || name === 'code' || name === 'pre') && !/\/>$/.test(part)) protectedDepth += 1;
      }
      return part;
    }
    if (protectedDepth) return part;
    return part
      .replace(HASH_TOPIC_RE, (match, prefix: string, topic: string) => (
        topics.has(topicKey(topic))
          ? `${prefix}<a class="note-topic-highlight" href="${topicHref}${encodeURIComponent(topic)}" data-note-topic="${topic}">#${topic}</a>`
          : match
      ))
      .replace(NOTE_REFERENCE_RE, (_match, prefix: string, cid: string) => (
        `${prefix}<a class="note-reference" href="/note/${cid}" data-note-ref="${cid}">/note/${cid}</a>`
      ));
  }).join('');
}

async function requireTopic(db: Database, mid: number): Promise<void> {
  if (!mid) return;
  const topic = await db.query.metas.findFirst({
    where: and(eq(schema.metas.mid, mid), eq(schema.metas.type, NOTE_TOPIC_TYPE)),
    columns: { mid: true },
  });
  if (!topic) throw new Error('Topic 不存在');
}

async function findOrCreateTopics(db: Database, names: string[]): Promise<number[]> {
  const mids: number[] = [];
  for (const name of names) {
    const slug = topicSlug(name);
    const existing = await db.query.metas.findFirst({
      where: and(eq(schema.metas.type, NOTE_TOPIC_TYPE), or(eq(schema.metas.name, name), eq(schema.metas.slug, slug))),
      columns: { mid: true },
    });
    if (existing?.mid) {
      mids.push(existing.mid);
      continue;
    }
    const inserted = await db.insert(schema.metas).values({
      name,
      slug,
      type: NOTE_TOPIC_TYPE,
      description: null,
      count: 0,
      order: 0,
      parent: 0,
    }).returning({ mid: schema.metas.mid });
    if (inserted[0]?.mid) mids.push(inserted[0].mid);
  }
  return mids;
}

async function resolveInputTopics(db: Database, input: NoteInput): Promise<number[]> {
  if (input.topicMid) await requireTopic(db, input.topicMid);
  const extracted = await findOrCreateTopics(db, extractTopicNames(input.content));
  return [...new Set([input.topicMid, ...extracted].filter(mid => mid > 0))];
}

async function recountTopics(db: Database, mids: number[]): Promise<void> {
  const uniqueMids = [...new Set(mids.filter(mid => mid > 0))];
  if (!uniqueMids.length) return;
  const queries = uniqueMids.map(mid => db.update(schema.metas).set({
    count: db.$count(schema.relationships, eq(schema.relationships.mid, mid)),
  }).where(and(eq(schema.metas.mid, mid), eq(schema.metas.type, NOTE_TOPIC_TYPE))));
  await db.batch(queries as [typeof queries[number], ...typeof queries]);
}

async function synchronizeNoteTopics(db: Database, cid: number, newMids: number[]): Promise<void> {
  const oldTopics = await db.select({ mid: schema.relationships.mid }).from(schema.relationships)
    .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
    .where(and(eq(schema.relationships.cid, cid), eq(schema.metas.type, NOTE_TOPIC_TYPE)));
  const statements: any[] = [];
  if (oldTopics.length) {
    statements.push(db.delete(schema.relationships).where(and(
      eq(schema.relationships.cid, cid),
      inArray(schema.relationships.mid, oldTopics.map(topic => topic.mid)),
    )));
  }
  for (const mid of newMids) statements.push(db.insert(schema.relationships).values({ cid, mid }));
  if (statements.length) await db.batch(statements as [any, ...any[]]);
  await recountTopics(db, [...oldTopics.map(topic => topic.mid), ...newMids]);
}

async function resolveTopicMid(db: Database, topic: number | string | null | undefined): Promise<number | null> {
  if (topic === null || topic === undefined || topic === '' || topic === 0 || topic === '0') return 0;
  const numeric = Number.parseInt(String(topic), 10);
  if (Number.isSafeInteger(numeric) && String(numeric) === String(topic).trim()) {
    const row = await db.query.metas.findFirst({
      where: and(eq(schema.metas.mid, numeric), eq(schema.metas.type, NOTE_TOPIC_TYPE)),
      columns: { mid: true },
    });
    return row?.mid || null;
  }
  const value = String(topic).trim();
  if (!value || value.length > 80) return null;
  const row = await db.query.metas.findFirst({
    where: and(eq(schema.metas.type, NOTE_TOPIC_TYPE), or(eq(schema.metas.slug, value), eq(schema.metas.name, value))),
    columns: { mid: true },
  });
  return row?.mid || null;
}

async function listNotesData(db: Database, rawOptions: ListOptions = {}): Promise<NotesListResult> {
  const admin = !!rawOptions.admin;
  const mode: ListMode = rawOptions.mode === 'mixed' ? 'mixed' : 'notes';
  const page = clampInteger(rawOptions.page, 1, 1, 100_000);
  const pageSize = clampInteger(rawOptions.pageSize, 12, 1, 50);
  const cid = rawOptions.cid ? clampInteger(rawOptions.cid, 0, 1, Number.MAX_SAFE_INTEGER) : 0;
  const viewerUid = clampInteger(rawOptions.viewerUid, 0, 0, Number.MAX_SAFE_INTEGER);
  const keywords = admin && typeof rawOptions.keywords === 'string'
    ? rawOptions.keywords.trim().slice(0, 100)
    : '';
  const topicMid = await resolveTopicMid(db, rawOptions.topic);
  const rawStatus = (rawOptions as any).status || 'all';
  const status = rawStatus === 'publish' || rawStatus === 'private' || rawStatus === 'draft' ? rawStatus : 'all';
  if (topicMid === null) {
    return { data: [], topics: [], pagination: { page, pageSize, total: 0, totalPages: 1 }, stats: { days: 0, notes: 0, posts: 0 } };
  }

  const now = Math.floor(Date.now() / 1000);
  const publicNoteCondition = and(
    eq(schema.contents.type, NOTE_TYPE),
    eq(schema.contents.status, 'publish'),
    lte(schema.contents.created, now),
  );
  const visibleNoteCondition = viewerUid > 0
    ? and(
      eq(schema.contents.type, NOTE_TYPE),
      lte(schema.contents.created, now),
      or(
        eq(schema.contents.status, 'publish'),
        and(eq(schema.contents.status, 'private'), eq(schema.contents.authorId, viewerUid)),
      ),
    )
    : publicNoteCondition;
  const publicPostCondition = and(
    eq(schema.contents.type, 'post'),
    eq(schema.contents.status, 'publish'),
    lte(schema.contents.created, now),
  );
  const conditions: any[] = [];
  if (admin) {
    conditions.push(mode === 'mixed' ? inArray(schema.contents.type, [NOTE_TYPE, 'post']) : eq(schema.contents.type, NOTE_TYPE));
    if (status !== 'all') conditions.push(eq(schema.contents.status, status));
  } else {
    conditions.push(mode === 'mixed' ? or(publicPostCondition, visibleNoteCondition) : visibleNoteCondition);
  }
  if (cid) conditions.push(eq(schema.contents.cid, cid));
  if (keywords) conditions.push(like(schema.contents.text, `%${keywords}%`));

  const baseSelect = {
    cid: schema.contents.cid,
    title: schema.contents.title,
    slug: schema.contents.slug,
    type: schema.contents.type,
    text: schema.contents.text,
    created: schema.contents.created,
    modified: schema.contents.modified,
    status: schema.contents.status,
    commentsNum: schema.contents.commentsNum,
    allowComment: schema.contents.allowComment,
  };
  const offset = (page - 1) * pageSize;
  const where = topicMid
    ? and(...conditions, eq(schema.relationships.mid, topicMid))
    : and(...conditions);
  const notes = topicMid
    ? await db.select(baseSelect).from(schema.contents)
      .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
      .where(where).orderBy(desc(schema.contents.created), desc(schema.contents.cid)).limit(pageSize).offset(offset)
    : await db.select(baseSelect).from(schema.contents)
      .where(where).orderBy(desc(schema.contents.created), desc(schema.contents.cid)).limit(pageSize).offset(offset);
  const totalRows = topicMid
    ? await db.select({ value: count() }).from(schema.contents)
      .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid)).where(where)
    : await db.select({ value: count() }).from(schema.contents).where(where);

  const cids = notes.map(note => note.cid);
  const noteCids = notes.filter(note => note.type === NOTE_TYPE).map(note => note.cid);
  const topicCatalogPromise = admin
    ? db.select({ mid: schema.metas.mid, name: schema.metas.name, slug: schema.metas.slug, count: schema.metas.count })
      .from(schema.metas).where(and(eq(schema.metas.type, NOTE_TOPIC_TYPE), gt(schema.metas.count, 0)))
      .orderBy(desc(schema.metas.count), schema.metas.name)
    : db.select({ mid: schema.metas.mid, name: schema.metas.name, slug: schema.metas.slug, count: count() })
      .from(schema.metas)
      .innerJoin(schema.relationships, eq(schema.relationships.mid, schema.metas.mid))
      .innerJoin(schema.contents, eq(schema.contents.cid, schema.relationships.cid))
      .where(and(eq(schema.metas.type, NOTE_TOPIC_TYPE), visibleNoteCondition))
      .groupBy(schema.metas.mid, schema.metas.name, schema.metas.slug)
      .orderBy(desc(count()), schema.metas.name);
  const [fieldRows, topicRows, topics, noteCountRows, postCountRows, firstRows] = await Promise.all([
    noteCids.length
      ? db.select().from(schema.fields).where(and(
        inArray(schema.fields.cid, noteCids),
        eq(schema.fields.name, 'note_images'),
      ))
      : Promise.resolve([]),
    cids.length
      ? db.select({ cid: schema.relationships.cid, mid: schema.metas.mid, name: schema.metas.name, slug: schema.metas.slug })
        .from(schema.relationships).innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
        .where(and(inArray(schema.relationships.cid, cids), eq(schema.metas.type, NOTE_TOPIC_TYPE)))
      : Promise.resolve([]),
    topicCatalogPromise,
    db.select({ value: count() }).from(schema.contents).where(admin
      ? eq(schema.contents.type, NOTE_TYPE)
      : visibleNoteCondition),
    db.select({ value: count() }).from(schema.contents).where(admin
      ? and(eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish'))
      : publicPostCondition),
    db.select({ value: min(schema.contents.created) }).from(schema.contents).where(admin
      ? inArray(schema.contents.type, ['post', NOTE_TYPE])
      : or(publicPostCondition, visibleNoteCondition)),
  ]);

  const imageIdsByCid = new Map<number, number[]>();
  const allImageIds = new Set<number>();
  for (const field of fieldRows) {
    if (field.name === 'note_images' && field.str_value) {
      try {
        const ids = JSON.parse(field.str_value);
        if (!Array.isArray(ids)) continue;
        const normalizedIds = ids.map(Number).filter(id => Number.isInteger(id) && id > 0);
        imageIdsByCid.set(field.cid, normalizedIds);
        normalizedIds.forEach(id => allImageIds.add(id));
      } catch {
        // Optional image metadata must never make a note unreadable.
      }
    }
  }

  const attachmentRows = allImageIds.size
    ? await db.select({ cid: schema.contents.cid, text: schema.contents.text, title: schema.contents.title })
      .from(schema.contents).where(and(inArray(schema.contents.cid, [...allImageIds]), eq(schema.contents.type, 'attachment')))
    : [];
  const attachments = new Map(attachmentRows.map(attachment => {
    const meta = parseAttachmentMeta(attachment.text);
    return [attachment.cid, { cid: attachment.cid, name: meta.name || attachment.title || '', url: meta.url || '' }];
  }));
  const topicsByCid = new Map<number, NoteTopic[]>();
  for (const row of topicRows) {
    const entries = topicsByCid.get(row.cid) || [];
    entries.push({ mid: row.mid, name: row.name || '', slug: row.slug || '' });
    topicsByCid.set(row.cid, entries);
  }

  const firstCreated = Number(firstRows[0]?.value || 0);
  const days = firstCreated > 0 ? Math.max(1, Math.floor((Date.now() / 1000 - firstCreated) / 86_400) + 1) : 0;
  const total = Number(totalRows[0]?.value || 0);
  const siteUrl = rawOptions.siteUrl || '';
  return {
    data: notes.map(note => {
      const isNote = note.type === NOTE_TYPE;
      const noteTopics = topicsByCid.get(note.cid) || [];
      const source = stripMarkdownMarker(note.text || '');
      return {
        cid: note.cid,
        type: isNote ? 'note' : 'post',
        title: note.title || (isNote ? '' : '无标题'),
        permalink: isNote
          ? `${siteUrl.replace(/\/$/, '')}/note/${note.cid}`
          : buildPermalink(note, siteUrl || 'http://localhost', rawOptions.permalinkPattern),
        source,
        html: isNote ? renderNoteContent(note.text || '', siteUrl) : renderMarkdown(note.text || ''),
        created: note.created || 0,
        modified: note.modified || 0,
        status: note.status || 'publish',
        comments: note.commentsNum || 0,
        allowComment: note.allowComment === '1',
        topics: noteTopics,
        topic: noteTopics[0] || null,
        images: isNote ? (imageIdsByCid.get(note.cid) || []).map(id => attachments.get(id)).filter(Boolean) as Array<{ cid: number; name: string; url: string }> : [],
      };
    }),
    topics: topics.map(topic => ({ mid: topic.mid, name: topic.name || '', slug: topic.slug || '', count: topic.count || 0 })),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    stats: { days, notes: Number(noteCountRows[0]?.value || 0), posts: Number(postCountRows[0]?.value || 0) },
  };
}

/**
 * Theme-facing server data. A theme receives both arrays in one server-side
 * call and can iterate `notes` or `mixed` exactly as it iterates its `posts`
 * prop. No browser request or core theme-prop change is required.
 */
export async function getNotesForTheme(
  db: Database,
  query: ThemeNotesQuery = {},
  themeOptions: ThemeNotesOptions | string = {},
): Promise<NotesThemeVariables> {
  const resolvedOptions = typeof themeOptions === 'string'
    ? { siteUrl: themeOptions }
    : themeOptions;
  const common = {
    ...query,
    admin: false,
    siteUrl: resolvedOptions.siteUrl || '',
    permalinkPattern: resolvedOptions.permalinkPattern,
  };
  const [noteResult, mixedResult] = await Promise.all([
    listNotesData(db, { ...common, mode: 'notes' }),
    listNotesData(db, { ...common, mode: 'mixed' }),
  ]);
  return {
    notes: noteResult.data,
    mixed: mixedResult.data,
    topics: noteResult.topics,
    pagination: {
      notes: noteResult.pagination,
      mixed: mixedResult.pagination,
    },
  };
}

export async function getNoteForTheme(
  db: Database,
  cid: number,
  siteUrl = '',
  viewerUid?: number | null,
): Promise<NoteListItem | null> {
  const result = await listNotesData(db, { cid, pageSize: 1, admin: false, siteUrl, viewerUid });
  return result.data[0] || null;
}

async function listNoteComments(cid: number, context: NotesActionContext): Promise<Response> {
  const note = await context.db.query.contents.findFirst({
    where: and(eq(schema.contents.cid, cid), eq(schema.contents.type, NOTE_TYPE)),
    columns: { cid: true },
  });
  if (!note) return jsonError(404, '笔记不存在');

  const rows = await context.db.select().from(schema.comments)
    .where(eq(schema.comments.cid, cid))
    .orderBy(asc(schema.comments.created), asc(schema.comments.coid));
  const options = context.options || {};
  return jsonOk({
    success: true,
    comments: rows.map(comment => ({
      coid: comment.coid,
      author: comment.author || '匿名',
      status: comment.status || 'approved',
      html: renderCommentText(comment.text || '', {
        markdown: !!options.commentsMarkdown,
        htmlTagAllowed: options.commentsHTMLTagAllowed,
      }),
      created: comment.created || 0,
      parent: comment.parent || 0,
    })),
  });
}

async function listNotes(request: Request, context: NotesActionContext): Promise<Response> {
  const url = new URL(request.url);
  const commentsCid = clampInteger(url.searchParams.get('commentsCid'), 0, 0, Number.MAX_SAFE_INTEGER);
  if (commentsCid) return listNoteComments(commentsCid, context);

  const result = await listNotesData(context.db, {
    admin: true,
    cid: clampInteger(url.searchParams.get('cid'), 0, 0, Number.MAX_SAFE_INTEGER),
    page: clampInteger(url.searchParams.get('page'), 1, 1, 100_000),
    pageSize: clampInteger(url.searchParams.get('pageSize'), 12, 1, 50),
    topic: url.searchParams.get('topic'),
    keywords: url.searchParams.get('keywords'),
    mode: 'notes',
    ...(url.searchParams.get('status') ? { status: url.searchParams.get('status') } : {}),
  } as ListOptions);
  return jsonOk({ success: true, ...result });
}

async function createNote(body: unknown, context: NotesActionContext): Promise<Response> {
  const input = normalizeNoteInput(body);
  const topicMids = await resolveInputTopics(context.db, input);
  const now = Math.floor(Date.now() / 1000);
  const inserted = await context.db.insert(schema.contents).values({
    title: null,
    slug: `note-${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
    created: now,
    modified: now,
    text: noteText(input.content),
    authorId: context.uid,
    type: NOTE_TYPE,
    status: input.status,
    commentsNum: 0,
    allowComment: input.status === 'publish' ? '1' : '0',
    allowPing: '0',
    allowFeed: '0',
  }).returning({ cid: schema.contents.cid });
  const cid = inserted[0]?.cid;
  if (!cid) return jsonError(500, '笔记创建失败');
  await synchronizeNoteTopics(context.db, cid, topicMids);
  if (input.status === 'publish') {
    await invalidatePublicCache(context.db, { reason: 'note-create', domains: ['home', 'note'] });
  }
  return jsonOk({ success: true, cid, topics: topicMids });
}

async function updateNote(body: Record<string, unknown>, context: NotesActionContext): Promise<Response> {
  const cid = Number.parseInt(String(body.cid || 0), 10);
  if (!cid) return jsonError(400, '缺少笔记 cid');
  const input = normalizeNoteInput(body);
  const existing = await context.db.query.contents.findFirst({
    where: and(eq(schema.contents.cid, cid), eq(schema.contents.type, NOTE_TYPE)),
    columns: { cid: true, status: true },
  });
  if (!existing) return jsonError(404, '笔记不存在');
  const topicMids = await resolveInputTopics(context.db, input);
  await context.db.update(schema.contents).set({
    text: noteText(input.content),
    status: input.status,
    allowComment: input.status === 'publish' ? '1' : '0',
    modified: Math.floor(Date.now() / 1000),
  }).where(and(eq(schema.contents.cid, cid), eq(schema.contents.type, NOTE_TYPE)));
  await synchronizeNoteTopics(context.db, cid, topicMids);
  if (existing.status === 'publish' || input.status === 'publish') {
    await invalidatePublicCache(context.db, { reason: 'note-update', domains: ['home', 'note'] });
  }
  return jsonOk({ success: true, topics: topicMids });
}

async function deleteNote(body: Record<string, unknown>, context: NotesActionContext): Promise<Response> {
  const cid = Number.parseInt(String(body.cid || 0), 10);
  if (!cid) return jsonError(400, '缺少笔记 cid');
  const existing = await context.db.query.contents.findFirst({
    where: and(eq(schema.contents.cid, cid), eq(schema.contents.type, NOTE_TYPE)),
    columns: { cid: true, status: true },
  });
  if (!existing) return jsonError(404, '笔记不存在');
  const oldTopics = await context.db.select({ mid: schema.relationships.mid }).from(schema.relationships)
    .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
    .where(and(eq(schema.relationships.cid, cid), eq(schema.metas.type, NOTE_TOPIC_TYPE)));
  await context.db.batch([
    context.db.delete(schema.relationships).where(eq(schema.relationships.cid, cid)),
    context.db.delete(schema.comments).where(eq(schema.comments.cid, cid)),
    context.db.delete(schema.fields).where(eq(schema.fields.cid, cid)),
    context.db.delete(schema.contents).where(and(eq(schema.contents.cid, cid), eq(schema.contents.type, NOTE_TYPE))),
  ]);
  await recountTopics(context.db, oldTopics.map(topic => topic.mid));
  if (existing.status === 'publish') {
    await invalidatePublicCache(context.db, { reason: 'note-delete', domains: ['home', 'note'] });
  }
  return jsonOk({ success: true });
}

async function createTopic(body: Record<string, unknown>, context: NotesActionContext): Promise<Response> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 40) return jsonError(400, 'Topic 名称长度应为 1-40 个字符');
  const [mid] = await findOrCreateTopics(context.db, [name]);
  const topic = mid ? await context.db.query.metas.findFirst({ where: eq(schema.metas.mid, mid) }) : null;
  return jsonOk({ success: true, topic });
}

async function replyToNoteComment(
  body: Record<string, unknown>,
  context: NotesActionContext,
  request: Request,
): Promise<Response> {
  const cid = Number.parseInt(String(body.cid || 0), 10);
  const parent = Number.parseInt(String(body.parent || 0), 10);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!cid) return jsonError(400, '缺少笔记 cid');
  if (!Number.isSafeInteger(parent) || parent < 0) return jsonError(400, '父评论无效');
  if (!text) return jsonError(400, '回复内容不能为空');
  if (text.length > 10_000) return jsonError(400, '回复内容不能超过 10000 个字符');

  const note = await context.db.query.contents.findFirst({
    where: and(eq(schema.contents.cid, cid), eq(schema.contents.type, NOTE_TYPE)),
    columns: { cid: true, authorId: true },
  });
  if (!note) return jsonError(404, '笔记不存在');
  if (parent > 0) {
    const parentComment = await context.db.query.comments.findFirst({
      where: and(eq(schema.comments.coid, parent), eq(schema.comments.cid, cid)),
      columns: { coid: true },
    });
    if (!parentComment) return jsonError(400, '父评论不存在');
  }

  const user = context.user || await context.db.query.users.findFirst({
    where: eq(schema.users.uid, context.uid),
    columns: { name: true, screenName: true, mail: true, url: true },
  });
  const now = Math.floor(Date.now() / 1000);
  const [inserted] = await context.db.batch([
    context.db.insert(schema.comments).values({
      cid,
      created: now,
      author: user?.screenName || user?.name || '管理员',
      authorId: context.uid,
      ownerId: note.authorId || 0,
      mail: user?.mail || '',
      url: user?.url || '',
      ip: getClientIp(request),
      agent: request.headers.get('user-agent') || '',
      text,
      type: 'comment',
      status: 'approved',
      parent,
    }).returning({ coid: schema.comments.coid }),
    context.db.update(schema.contents)
      .set({ commentsNum: sql`${schema.contents.commentsNum} + 1` })
      .where(and(eq(schema.contents.cid, cid), eq(schema.contents.type, NOTE_TYPE))),
  ]);
  const coid = inserted[0]?.coid;
  if (!coid) return jsonError(500, '回复保存失败');

  return jsonOk({ success: true, coid });
}

export async function handleNotesRequest(request: Request, context: NotesActionContext): Promise<Response> {
  if (request.method === 'GET') return listNotes(request, context);
  if (request.method !== 'POST') return jsonError(405, 'Method not allowed', { Allow: 'GET, POST' });

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonError(400, '请求 JSON 格式无效');
  }
  try {
    const action = String(body.action || 'create');
    if (action === 'create') return await createNote(body, context);
    if (action === 'update') return await updateNote(body, context);
    if (action === 'delete') return await deleteNote(body, context);
    if (action === 'create-topic') return await createTopic(body, context);
    if (action === 'reply-comment') return await replyToNoteComment(body, context, request);
    return jsonError(400, `未知操作: ${action}`);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : '笔记操作失败');
  }
}
