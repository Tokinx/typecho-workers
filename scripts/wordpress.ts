import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface WordPressCategoryRef {
  domain: string;
  slug: string;
  name: string;
}

export interface WordPressPostMeta {
  key: string;
  value: string;
}

export interface WordPressComment {
  oldId: number;
  parentId: number;
  author: string;
  authorEmail: string;
  authorUrl: string;
  authorIp: string;
  authorId: number;
  date: string;
  dateGmt: string;
  content: string;
  approved: string;
  type: string;
  agent: string;
}

export interface WordPressItem {
  oldId: number;
  postType: string;
  status: string;
  title: string;
  slug: string;
  guid: string;
  creator: string;
  date: string;
  dateGmt: string;
  modified: string;
  modifiedGmt: string;
  content: string;
  excerpt: string;
  parentId: number;
  menuOrder: number;
  isSticky: number;
  password: string;
  commentStatus: string;
  pingStatus: string;
  attachmentUrl: string;
  mimeType: string;
  categories: WordPressCategoryRef[];
  postMeta: WordPressPostMeta[];
  comments: WordPressComment[];
}

export interface WordPressTerm {
  domain: 'category' | 'post_tag' | 'topic';
  slug: string;
  name: string;
  parentSlug: string;
  description: string;
}

export interface WordPressExport {
  siteTitle: string;
  siteUrl: string;
  authors: Array<{ login: string; email: string; displayName: string }>;
  terms: WordPressTerm[];
  items: WordPressItem[];
}

export interface ExistingMeta {
  mid: number;
  type: string;
  slug: string;
}

export interface WordPressTargetState {
  maxContentId: number;
  maxCommentId: number;
  maxMetaId: number;
  contentSlugs: string[];
  metas: ExistingMeta[];
}

export interface WordPressMigrationConfig {
  authorId: number;
  includeAttachments: boolean;
  siteUrl: string;
  rewriteMedia: boolean;
  preserveIds?: boolean;
  skipMediaKeys?: ReadonlySet<string>;
}

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface MediaAsset {
  sourceUrl: string;
  key: string;
  targetUrl: string;
}

export interface WordPressMigrationDataset {
  contents: SqlRow[];
  comments: SqlRow[];
  metas: SqlRow[];
  relationships: SqlRow[];
  fields: SqlRow[];
  mediaAssets: MediaAsset[];
  affectedMetaIds: number[];
  skipped: Record<string, number>;
  imported: Record<string, number>;
}

/**
 * SQL executed before an override import. Meta definitions stay in place so
 * site settings such as the default category continue to reference valid IDs.
 */
export function buildWordPressOverrideStatements(): string[] {
  return [
    'DELETE FROM typecho_comments;',
    'DELETE FROM typecho_relationships;',
    'DELETE FROM typecho_fields;',
    'DELETE FROM typecho_contents;',
    "DELETE FROM sqlite_sequence WHERE name IN ('typecho_contents', 'typecho_comments');",
    'UPDATE typecho_metas SET "count" = 0;',
  ];
}

export function buildWordPressOverrideTargetState(target: WordPressTargetState): WordPressTargetState {
  return {
    ...target,
    maxContentId: 0,
    maxCommentId: 0,
    contentSlugs: [],
  };
}

const ARRAY_TAGS = new Set([
  'item',
  'category',
  'wp:author',
  'wp:category',
  'wp:tag',
  'wp:term',
  'wp:postmeta',
  'wp:comment',
]);

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const nodeText = (value as Record<string, unknown>)['#text'];
    return nodeText === null || nodeText === undefined ? '' : String(nodeText);
  }
  return String(value);
}

function integer(value: unknown): number {
  const parsed = Number.parseInt(text(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeSlug(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function parseTermDefinitions(channel: Record<string, any>): WordPressTerm[] {
  const result: WordPressTerm[] = [];

  for (const category of asArray<Record<string, any>>(channel['wp:category'])) {
    result.push({
      domain: 'category',
      slug: decodeSlug(text(category['wp:category_nicename'])),
      name: text(category['wp:cat_name']),
      parentSlug: decodeSlug(text(category['wp:category_parent'])),
      description: text(category['wp:category_description']),
    });
  }

  for (const tag of asArray<Record<string, any>>(channel['wp:tag'])) {
    result.push({
      domain: 'post_tag',
      slug: decodeSlug(text(tag['wp:tag_slug'])),
      name: text(tag['wp:tag_name']),
      parentSlug: '',
      description: text(tag['wp:tag_description']),
    });
  }

  for (const term of asArray<Record<string, any>>(channel['wp:term'])) {
    if (text(term['wp:term_taxonomy']) !== 'topic') continue;
    result.push({
      domain: 'topic',
      slug: decodeSlug(text(term['wp:term_slug'])),
      name: text(term['wp:term_name']),
      parentSlug: decodeSlug(text(term['wp:term_parent'])),
      description: text(term['wp:term_description']),
    });
  }

  return result.filter(term => term.slug || term.name);
}

function parseComment(raw: Record<string, any>): WordPressComment {
  return {
    oldId: integer(raw['wp:comment_id']),
    parentId: integer(raw['wp:comment_parent']),
    author: text(raw['wp:comment_author']),
    authorEmail: text(raw['wp:comment_author_email']),
    authorUrl: text(raw['wp:comment_author_url']),
    authorIp: text(raw['wp:comment_author_IP']),
    authorId: integer(raw['wp:comment_user_id']),
    date: text(raw['wp:comment_date']),
    dateGmt: text(raw['wp:comment_date_gmt']),
    content: text(raw['wp:comment_content']),
    approved: text(raw['wp:comment_approved']),
    type: text(raw['wp:comment_type']),
    agent: text(raw['wp:comment_agent']),
  };
}

function parseItem(raw: Record<string, any>): WordPressItem {
  return {
    oldId: integer(raw['wp:post_id']),
    postType: text(raw['wp:post_type']),
    status: text(raw['wp:status']),
    title: text(raw.title),
    slug: decodeSlug(text(raw['wp:post_name'])),
    guid: text(raw.guid),
    creator: text(raw['dc:creator']),
    date: text(raw['wp:post_date']),
    dateGmt: text(raw['wp:post_date_gmt']),
    modified: text(raw['wp:post_modified']),
    modifiedGmt: text(raw['wp:post_modified_gmt']),
    content: text(raw['content:encoded']),
    excerpt: text(raw['excerpt:encoded']),
    parentId: integer(raw['wp:post_parent']),
    menuOrder: integer(raw['wp:menu_order']),
    isSticky: integer(raw['wp:is_sticky']),
    password: text(raw['wp:post_password']),
    commentStatus: text(raw['wp:comment_status']),
    pingStatus: text(raw['wp:ping_status']),
    attachmentUrl: text(raw['wp:attachment_url']),
    mimeType: text(raw['wp:post_mime_type']),
    categories: asArray<Record<string, any>>(raw.category).map(category => ({
      domain: String(category['@domain'] || ''),
      slug: decodeSlug(String(category['@nicename'] || '')),
      name: text(category),
    })),
    postMeta: asArray<Record<string, any>>(raw['wp:postmeta']).map(meta => ({
      key: text(meta['wp:meta_key']),
      value: text(meta['wp:meta_value']),
    })).filter(meta => meta.key),
    comments: asArray<Record<string, any>>(raw['wp:comment']).map(parseComment),
  };
}

export function parseWordPressExport(xml: string): WordPressExport {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const message = typeof validation === 'object' && validation.err?.msg
      ? validation.err.msg
      : 'Invalid XML';
    throw new Error(`WordPress export is not valid XML: ${message}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  const document = parser.parse(xml) as Record<string, any>;
  const channel = document?.rss?.channel as Record<string, any> | undefined;
  if (!channel) throw new Error('WordPress export does not contain rss/channel');

  return {
    siteTitle: text(channel.title),
    siteUrl: text(channel['wp:base_blog_url']) || text(channel.link),
    authors: asArray<Record<string, any>>(channel['wp:author']).map(author => ({
      login: text(author['wp:author_login']),
      email: text(author['wp:author_email']),
      displayName: text(author['wp:author_display_name']),
    })),
    terms: parseTermDefinitions(channel),
    items: asArray<Record<string, any>>(channel.item).map(parseItem),
  };
}

function toUnixTimestamp(gmt: string, local: string): number {
  const source = gmt || local;
  if (!source || source.startsWith('0000-00-00')) return 0;
  const iso = `${source.trim().replace(' ', 'T')}${gmt ? 'Z' : ''}`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function normalizedTermType(domain: string): string | null {
  if (domain === 'category') return 'category';
  if (domain === 'post_tag') return 'tag';
  if (domain === 'topic') return 'note_topic';
  return null;
}

function termKey(type: string, slug: string): string {
  return `${type}\u0000${slug.toLocaleLowerCase()}`;
}

function makeUniqueSlug(base: string, oldId: number, used: Set<string>, prefix: string): string {
  const clean = base.trim() || `${prefix}-${oldId}`;
  if (!used.has(clean.toLocaleLowerCase())) {
    used.add(clean.toLocaleLowerCase());
    return clean;
  }

  let candidate = `${clean}-wp-${oldId}`;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) candidate = `${clean}-wp-${oldId}-${suffix++}`;
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function ensureMarkdownMarker(content: string): string {
  if (!content) return '';
  return content.startsWith('<!--markdown-->') ? content : `<!--markdown-->${content}`;
}

function inferMimeType(url: string): string {
  const pathname = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); }
  })();
  const extension = pathname.split('.').pop() || '';
  const known: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
    pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain',
  };
  return known[extension] || 'application/octet-stream';
}

function mediaRelativePath(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl);
    const marker = '/wp-content/uploads/';
    const index = url.pathname.indexOf(marker);
    if (index < 0) return null;
    const encoded = url.pathname.slice(index + marker.length);
    const decoded = decodeURIComponent(encoded);
    const parts = decoded.split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) return null;
    return parts.join('/');
  } catch {
    return null;
  }
}

const MEDIA_URL_RE = /https?:\/\/[^\s"'<>]+?\/wp-content\/uploads\/[^\s"'<>),]+/gi;

function collectMediaUrls(value: string): string[] {
  return value.match(MEDIA_URL_RE) || [];
}

function buildMediaPlan(items: WordPressItem[], siteUrl: string, skipMediaKeys: ReadonlySet<string>): {
  assets: MediaAsset[];
  replacements: Map<string, string>;
} {
  const byKey = new Map<string, MediaAsset>();
  const replacements = new Map<string, string>();
  const baseUrl = siteUrl.replace(/\/+$/, '');
  const urls = new Set<string>();

  for (const item of items) {
    if (item.attachmentUrl) urls.add(item.attachmentUrl);
    for (const url of collectMediaUrls(item.content)) urls.add(url);
    for (const url of collectMediaUrls(item.excerpt)) urls.add(url);
  }

  for (const sourceUrl of urls) {
    const relative = mediaRelativePath(sourceUrl);
    if (!relative) continue;
    const key = `usr/uploads/${relative}`;
    if (skipMediaKeys.has(key)) continue;
    const targetUrl = `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
    replacements.set(sourceUrl, targetUrl);
    if (!byKey.has(key)) byKey.set(key, { sourceUrl, key, targetUrl });
  }

  return { assets: [...byKey.values()], replacements };
}

function replaceMediaUrls(content: string, replacements: Map<string, string>): string {
  if (!content || replacements.size === 0) return content;
  return content.replace(MEDIA_URL_RE, source => replacements.get(source) || source);
}

function fieldRow(cid: number, name: string, value: string | number, numeric = false): SqlRow {
  if (numeric) {
    return { cid, name, type: 'int', str_value: null, int_value: Number(value) || 0, float_value: 0 };
  }
  return { cid, name, type: 'str', str_value: String(value), int_value: 0, float_value: 0 };
}

function commentStatus(status: string): string {
  if (status === '1' || status === 'approve' || status === 'approved') return 'approved';
  if (status === 'spam' || status === 'trash') return 'spam';
  return 'waiting';
}

function selectedContentType(item: WordPressItem): { type: string; status: string } {
  if (item.postType === 'attachment') return { type: 'attachment', status: 'publish' };
  if (item.postType === 'note') {
    const status = item.status === 'private' ? 'private' : item.status === 'publish' ? 'publish' : 'draft';
    return { type: 'note', status };
  }
  const isPage = item.postType === 'page';
  const type = isPage ? 'page' : 'post';
  if (item.status === 'draft' || item.status === 'pending') return { type: `${type}_draft`, status: 'draft' };
  if (item.status === 'private') return { type, status: 'private' };
  if (item.status === 'hidden' || item.status === 'future') return { type, status: 'hidden' };
  return { type, status: 'publish' };
}

function metaValues(item: WordPressItem): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const meta of item.postMeta) {
    const current = values.get(meta.key) || [];
    current.push(meta.value);
    values.set(meta.key, current);
  }
  return values;
}

function mapSourceIds(
  sourceIds: number[],
  firstGeneratedId: number,
  preserveIds: boolean,
  label: string,
): Map<number, number> {
  const ids = new Map<number, number>();
  let nextId = firstGeneratedId;
  for (const sourceId of sourceIds) {
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      throw new Error(`WordPress ${label} ID must be a positive integer`);
    }
    if (ids.has(sourceId)) throw new Error(`Duplicate WordPress ${label} ID: ${sourceId}`);
    ids.set(sourceId, preserveIds ? sourceId : nextId++);
  }
  return ids;
}

export function buildWordPressMigrationDataset(
  source: WordPressExport,
  target: WordPressTargetState,
  config: WordPressMigrationConfig,
): WordPressMigrationDataset {
  if (!Number.isInteger(config.authorId) || config.authorId <= 0) {
    throw new Error('authorId must be a positive integer');
  }
  if (config.rewriteMedia && !config.siteUrl) {
    throw new Error('siteUrl is required when media rewriting is enabled');
  }

  const skipped: Record<string, number> = {};
  const selected = source.items.filter(item => {
    const allowed = item.postType === 'post'
      || item.postType === 'page'
      || item.postType === 'note'
      || (config.includeAttachments && item.postType === 'attachment');
    if (!allowed) skipped[item.postType || 'unknown'] = (skipped[item.postType || 'unknown'] || 0) + 1;
    return allowed;
  }).sort((a, b) => {
    const priority = (item: WordPressItem) => {
      if (item.postType === 'post') return 0;
      if (item.postType === 'page') return 1;
      if (item.postType === 'note') return 2;
      return 3;
    };
    return priority(a) - priority(b) || a.oldId - b.oldId;
  });

  const mediaPlan = buildMediaPlan(selected, config.siteUrl, config.skipMediaKeys || new Set());
  const replacements = config.rewriteMedia ? mediaPlan.replacements : new Map<string, string>();
  const contentIdByOldId = mapSourceIds(
    selected.map(item => item.oldId),
    target.maxContentId + 1,
    config.preserveIds === true,
    'post',
  );

  const usedSlugs = new Set(target.contentSlugs.map(slug => slug.toLocaleLowerCase()));
  const contents: SqlRow[] = [];
  const contentByCid = new Map<number, SqlRow>();

  for (const item of selected) {
    const cid = contentIdByOldId.get(item.oldId)!;
    const mapped = selectedContentType(item);
    const created = toUnixTimestamp(item.dateGmt, item.date);
    const modified = toUnixTimestamp(item.modifiedGmt, item.modified) || created;
    const slugBase = item.postType === 'note' ? `note-${item.oldId}` : item.slug;
    const slug = makeUniqueSlug(slugBase, item.oldId, usedSlugs, item.postType === 'attachment' ? 'media' : 'post');
    const parent = contentIdByOldId.get(item.parentId) || 0;
    let storedText = '';

    if (item.postType === 'attachment') {
      const relative = mediaRelativePath(item.attachmentUrl);
      const key = config.rewriteMedia && relative && replacements.has(item.attachmentUrl)
        ? `usr/uploads/${relative}`
        : '';
      const targetUrl = config.rewriteMedia
        ? replacements.get(item.attachmentUrl) || item.attachmentUrl
        : item.attachmentUrl;
      storedText = JSON.stringify({
        name: relative?.split('/').pop() || item.title || `attachment-${item.oldId}`,
        path: key,
        size: 0,
        type: item.mimeType || inferMimeType(item.attachmentUrl),
        url: targetUrl,
        sourceUrl: item.attachmentUrl,
      });
    } else {
      storedText = ensureMarkdownMarker(replaceMediaUrls(item.content, replacements));
    }

    const row: SqlRow = {
      cid,
      title: item.title || null,
      slug,
      created,
      modified,
      text: storedText,
      order: item.menuOrder,
      authorId: config.authorId,
      template: null,
      type: mapped.type,
      status: mapped.status,
      password: item.password || null,
      commentsNum: 0,
      allowComment: item.commentStatus === 'open' && mapped.status === 'publish' ? '1' : '0',
      allowPing: item.pingStatus === 'open' ? '1' : '0',
      allowFeed: item.postType === 'post' ? '1' : '0',
      parent,
    };
    contents.push(row);
    contentByCid.set(cid, row);
  }

  const termDefinitions = new Map<string, WordPressTerm>();
  for (const term of source.terms) {
    const type = normalizedTermType(term.domain);
    if (type) termDefinitions.set(termKey(type, term.slug || term.name), term);
  }

  const usedTermRefs = new Map<string, { type: string; slug: string; name: string }>();
  for (const item of selected) {
    if (item.postType !== 'post' && item.postType !== 'note') continue;
    for (const category of item.categories) {
      const type = normalizedTermType(category.domain);
      if (!type || (type === 'note_topic' && item.postType !== 'note')) continue;
      const slug = category.slug || category.name;
      usedTermRefs.set(termKey(type, slug), { type, slug, name: category.name || slug });
    }
  }

  const existingMetaByKey = new Map(target.metas.map(meta => [termKey(meta.type, meta.slug), meta.mid]));
  const metaIdByKey = new Map<string, number>();
  const metas: SqlRow[] = [];
  let nextMetaId = target.maxMetaId + 1;

  for (const [key, ref] of usedTermRefs) {
    const existingMid = existingMetaByKey.get(key);
    if (existingMid) {
      metaIdByKey.set(key, existingMid);
      continue;
    }
    const mid = nextMetaId++;
    metaIdByKey.set(key, mid);
    const definition = termDefinitions.get(key);
    metas.push({
      mid,
      name: definition?.name || ref.name,
      slug: ref.slug,
      type: ref.type,
      description: definition?.description || null,
      count: 0,
      order: 0,
      parent: 0,
    });
  }

  for (const meta of metas) {
    const key = termKey(String(meta.type), String(meta.slug));
    const definition = termDefinitions.get(key);
    if (!definition?.parentSlug) continue;
    meta.parent = metaIdByKey.get(termKey(String(meta.type), definition.parentSlug)) || 0;
  }

  const relationships: SqlRow[] = [];
  const relationshipKeys = new Set<string>();
  for (const item of selected) {
    if (item.postType !== 'post' && item.postType !== 'note') continue;
    const cid = contentIdByOldId.get(item.oldId)!;
    for (const category of item.categories) {
      const type = normalizedTermType(category.domain);
      if (!type || (type === 'note_topic' && item.postType !== 'note')) continue;
      const mid = metaIdByKey.get(termKey(type, category.slug || category.name));
      if (!mid) continue;
      const key = `${cid}:${mid}`;
      if (relationshipKeys.has(key)) continue;
      relationshipKeys.add(key);
      relationships.push({ cid, mid });
    }
  }

  const commentSources = selected
    .filter(item => item.postType === 'post' || item.postType === 'page' || item.postType === 'note')
    .flatMap(item => item.comments.map(comment => ({ item, comment })));
  const commentIdByOldId = mapSourceIds(
    commentSources.map(({ comment }) => comment.oldId),
    target.maxCommentId + 1,
    config.preserveIds === true,
    'comment',
  );

  const comments: SqlRow[] = [];
  for (const { item, comment } of commentSources) {
    const cid = contentIdByOldId.get(item.oldId)!;
    const status = commentStatus(comment.approved);
    comments.push({
      coid: commentIdByOldId.get(comment.oldId)!,
      cid,
      created: toUnixTimestamp(comment.dateGmt, comment.date),
      author: comment.author || null,
      authorId: comment.authorId > 0 ? config.authorId : 0,
      ownerId: config.authorId,
      mail: comment.authorEmail || null,
      url: comment.authorUrl || null,
      ip: comment.authorIp || null,
      agent: comment.agent || null,
      text: comment.content || null,
      type: comment.type || 'comment',
      status,
      parent: commentIdByOldId.get(comment.parentId) || 0,
    });
    if (status === 'approved') {
      const content = contentByCid.get(cid)!;
      content.commentsNum = Number(content.commentsNum) + 1;
    }
  }

  const fields: SqlRow[] = [];
  for (const item of selected) {
    const cid = contentIdByOldId.get(item.oldId)!;
    const rows = new Map<string, SqlRow>();
    const add = (row: SqlRow) => rows.set(String(row.name), row);
    add(fieldRow(cid, 'wordpress_post_id', item.oldId, true));
    if (item.guid) add(fieldRow(cid, 'wordpress_guid', item.guid));
    if (item.excerpt) add(fieldRow(cid, 'wordpress_excerpt', replaceMediaUrls(item.excerpt, replacements)));

    const values = metaValues(item);
    for (const [key, entries] of values) {
      add(fieldRow(cid, `wordpress:${key}`, entries.length === 1 ? entries[0] : JSON.stringify(entries)));
    }
    if (item.isSticky) add(fieldRow(cid, 'wordpress_is_sticky', item.isSticky, true));
    const praise = values.get('praise')?.at(-1);
    if (item.postType === 'note' && praise !== undefined) add(fieldRow(cid, 'note_likes', praise, true));

    if (item.postType === 'note') {
      const imageIds = [...(values.get('images') || []), ...(values.get('attachment') || [])]
        .flatMap(value => value.match(/\d+/g) || [])
        .map(value => contentIdByOldId.get(Number(value)))
        .filter((value): value is number => value !== undefined);
      if (imageIds.length) add(fieldRow(cid, 'note_images', JSON.stringify([...new Set(imageIds)])));
    }

    const thumbnailId = Number(values.get('_thumbnail_id')?.at(-1) || 0);
    const mappedThumbnail = contentIdByOldId.get(thumbnailId);
    if (mappedThumbnail) add(fieldRow(cid, 'featured_attachment', mappedThumbnail, true));
    fields.push(...rows.values());
  }

  const importedNotes = selected.filter(item => item.postType === 'note').length;

  return {
    contents,
    comments,
    metas,
    relationships,
    fields,
    mediaAssets: config.rewriteMedia ? mediaPlan.assets : [],
    affectedMetaIds: [...new Set(relationships.map(row => Number(row.mid)))],
    skipped,
    imported: {
      posts: selected.filter(item => item.postType === 'post').length,
      pages: selected.filter(item => item.postType === 'page').length,
      notes: importedNotes,
      attachments: selected.filter(item => item.postType === 'attachment').length,
      comments: comments.length,
      metas: metas.length,
      relationships: relationships.length,
      fields: fields.length,
      media: config.rewriteMedia ? mediaPlan.assets.length : 0,
    },
  };
}

export function sqlLiteral(value: SqlValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot serialize non-finite number: ${value}`);
    return String(value);
  }
  // SQLite source text cannot contain a literal NUL byte. WXR files can carry
  // one in legacy CSS hacks, so use a hex text literal to preserve the value.
  if (value.includes('\u0000')) return `CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)`;
  return `'${value.replace(/'/g, "''")}'`;
}

function insertStatement(table: string, row: SqlRow): string {
  const columns = Object.keys(row);
  const values = columns.map(column => sqlLiteral(row[column]));
  return `INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(',')}) VALUES (${values.join(',')});`;
}

export function buildWordPressMigrationStatements(dataset: WordPressMigrationDataset): string[] {
  const statements = [
    ...dataset.metas.map(row => insertStatement('typecho_metas', row)),
    ...dataset.contents.map(row => insertStatement('typecho_contents', row)),
    // Import markers live in fields. Write them before the large comment set so
    // an interrupted run is detected instead of silently duplicating content.
    ...dataset.fields.map(row => insertStatement('typecho_fields', row)),
    ...dataset.relationships.map(row => insertStatement('typecho_relationships', row)),
    ...dataset.comments.map(row => insertStatement('typecho_comments', row)),
  ];

  for (const mid of dataset.affectedMetaIds) {
    statements.push(`UPDATE typecho_metas SET "count" = (SELECT COUNT(*) FROM typecho_relationships WHERE mid = ${mid}) WHERE mid = ${mid};`);
  }
  return statements;
}
