import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateSecurityToken } from '@/lib/auth';
import { loadOptions } from '@/lib/options';
import { setRequestCoreContext } from '@/lib/context';
import { addHook, removePluginHooks } from '@/lib/plugin';
import {
  notifyEarlyRequestInvalidation,
  registerEarlyRequestLoaders,
  resetEarlyRequestProvidersForTests,
} from '@/lib/early-request';
import type { EarlyRequestProvider, SharedDataRead } from '@/lib/early-request';
import type { SharedCacheDomain } from '@/lib/cache';
import { POST as submitComment } from '@/pages/api/comment';
import { createTestDb, disposeTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../../../tests/helpers';
import init, {
  extractTopicNames,
  getNoteForTheme,
  getNotesForTheme,
  getNotesStreamForTheme,
  NOTES_ADMIN_API_PATH,
  handleNotesRequest,
  normalizeNoteInput,
  notesAdminPageHtml,
  renderNoteContent,
  topicSlug,
} from './index';

let db: TestDatabase;
const SECRET = 'notes-test-secret';
const AUTH_CODE = 'notes-test-auth';
const COMMENT_PLUGIN_ID = 'typecho-plugin-notes-comment-test';

beforeEach(async () => {
  resetEarlyRequestProvidersForTests();
  db = await createTestDb();
  await seedAdmin(db, { secret: SECRET, authCode: AUTH_CODE });
  await db.insert((await import('@/db/schema')).options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
});

afterEach(async () => {
  resetEarlyRequestProvidersForTests();
  removePluginHooks(COMMENT_PLUGIN_ID);
  await disposeTestDb(db);
});

function collectHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-notes',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => hooks.set(point, handler),
  });
  return hooks;
}

describe('typecho-plugin-notes', () => {
  it('registers the route, page and navigation hooks', () => {
    const hooks = collectHooks();
    expect(hooks.has('route:request')).toBe(true);
    expect(hooks.has('comment:allowContent')).toBe(true);
    expect(hooks.has('admin:page')).toBe(true);
    expect(hooks.has('admin:footer')).toBe(true);
    expect(hooks.has('archive:footer')).toBe(false);
    expect(hooks.get('admin:page')!('', { slug: 'other' })).toBe('');
    expect(hooks.get('admin:page')!('', { slug: 'notes', csrfToken: 'token' })).toContain('id="notes-app"');
  });

  it('allows read-only comment loading for a public note after replies are closed', () => {
    const hook = collectHooks().get('comment:allowContent')!;
    const content = { type: 'note', status: 'publish', created: Math.floor(Date.now() / 1000) - 1, allowComment: '0' };
    expect(hook(false, { content })).toBe(false);
    expect(hook(false, { content, readOnly: true })).toBe(true);
  });

  it('normalizes note content and Unicode topic slugs', () => {
    expect(normalizeNoteInput({ content: ' hello ', status: 'private', topicMid: '3' })).toEqual({
      content: 'hello', status: 'private', topicMid: 3, attachments: [],
    });
    expect(() => normalizeNoteInput({ content: '  ' })).toThrow('不能为空');
    expect(topicSlug(' 日常 / DevOps ')).toBe('日常-devops');
  });

  it('normalizes attachment ids from arrays, csv strings and invalid input', () => {
    expect(normalizeNoteInput({ content: 'x', attachments: ['3', 4, 4, 0, -1, 'abc'] })).toEqual({
      content: 'x', status: 'publish', topicMid: 0, attachments: [3, 4],
    });
    expect(normalizeNoteInput({ content: 'x', attachments: '5,6,6, 7' })).toEqual({
      content: 'x', status: 'publish', topicMid: 0, attachments: [5, 6, 7],
    });
    expect(normalizeNoteInput({ content: 'x' }).attachments).toEqual([]);
    const many = Array.from({ length: 30 }, (_, index) => index + 1);
    expect(normalizeNoteInput({ content: 'x', attachments: many }).attachments).toHaveLength(20);
  });

  it('extracts Wing-style Topics and renders /note/<cid> references', () => {
    expect(extractTopicNames('记录 #日常 与 #DevOps、#📝日常，再次 #日常；https://example.com/#not-topic')).toEqual(['日常', 'DevOps', '📝日常']);
    expect(extractTopicNames('\\#escaped #有效')).toEqual(['有效']);
    const html = renderNoteContent('查看 /note/42，旧格式 ~/note/43 和代码 `/note/99` 不会成为引用');
    expect(html).toContain('data-note-ref="42"');
    expect(html).toContain('href="/note/42"');
    expect(html).toContain('>/note/42</a>');
    expect(html).not.toContain('data-note-ref="43"');
    expect(html).not.toContain('data-note-ref="99"');
    expect(notesAdminPageHtml('csrf-value')).toContain('insertText("/note/"+Number(button.dataset.quote)');
    expect(renderNoteContent('正文中的 #话题')).toContain('class="note-topic-highlight"');
    expect(renderNoteContent('正文中的 #话题')).toContain('data-note-topic="话题"');
    expect(renderNoteContent('正文中的 #📝日常')).toContain('data-note-topic="📝日常"');
    expect(renderNoteContent('转义的 \\#话题')).not.toContain('note-topic-highlight');
  });

  it('renders a resizable composer, enter-to-search list and topic sidebar', () => {
    const html = notesAdminPageHtml('csrf-value');
    expect(html).toContain('placeholder="你在想什么？写下来吧。"');
    expect(html).toContain('id="notes-topics"');
    expect(html).not.toContain('全部 Topic');
    expect(html).not.toContain('notes-stats');
    expect(html).not.toContain('喜欢');
    expect(html).toContain('id="notes-comments-dialog"');
    expect(html).toContain('id="notes-comment-cancel-reply">取消回复</button>');
    expect(html).toContain('if(!commentReplying.textContent.trim()){commentsDialog.close();return}');
    expect(html).toContain('id="wmd-button-bar"');
    expect(html).toContain('id="wmd-preview"');
    expect(html).toContain('id="notes-attach"');
    expect(html).toContain('i-upload');
    expect(html).toContain('mountAttachButton');
    expect(html).toContain('wmd-button-row');
    expect(html).toContain('wmd-image-button');
    expect(html).toContain('id="notes-attachment-file"');
    expect(html).toContain('id="notes-attachment-chips"');
    expect(html).toContain('uploadAttachmentFile');
    expect(html).toContain('renderAttachmentChips');
    expect(html).toContain('data-attach-remove');
    expect(html).toContain('/api/admin/upload?cid=');
    expect(html).toContain('attachments:state.attachments.map');
    expect(html).toContain('concat(note.images||[],note.videos||[],note.music||[],note.attachments||[])');
    expect(html).toContain('function mimeClass');
    expect(html).toContain('mime-image');
    expect(html).toContain('mime-script');
    expect(html).toContain('mime-unknow');
    expect(html).toContain("<video src=\"'+E(video.url)+'\" controls preload=\"metadata\"></video>");
    expect(html).toContain("<audio src=\"'+E(track.url)+'\" controls preload=\"metadata\"></audio>");
    expect(html).toContain('note-media-list');
    expect(html).toContain('note-media-name');
    expect(html).toContain('var gridClass=imageItems.length?"has-"+Math.min(imageItems.length,4):""');
    expect(html).toContain("note-media-list '+gridClass+'\"");
    expect(html).toContain('.note-media-list.has-1{grid-template-columns:minmax(0,1fr);max-width:50%}');
    expect(html).toContain('.note-media-list.has-2{');
    expect(html).toContain('.note-media-list.has-3{');
    expect(html).toContain('note-media video{max-width:50%');
    expect(html).toContain('note-media audio{max-width:50%');
    expect(html).toContain('var videos=(note.videos||[])');
    expect(html).toContain('var music=(note.music||[])');
    expect(html).toContain('.note-media video{');
    expect(html).toContain('.note-media audio{');
    expect(html).toContain('png|jpe?g|gif|webp|svg|bmp|avif|ico');
    expect(html).toContain('mp4|webm|mov|m4v|avi|mkv|ogv');
    expect(html).toContain('mp3|wav|flac|m4a|aac|oga|opus|wma');
    expect(html).toContain('data-attach-index');
    expect(html).toContain('addEventListener("dragstart"');
    expect(html).toContain('addEventListener("drop"');
    expect(html).toContain('getBoundingClientRect');
    expect(html).toContain('drop-after');
    expect(html).toContain('drop-before');
    expect(html).toMatch(/<div class="notes-composer" id="notes-composer">[\s\S]*?<\/div>\s*<div id="notes-attachment-chips" class="notes-attachment-chips"/);
    expect(html).not.toContain('notes-attachment-chips" class="notes-attachment-chips"></div>\n    </div>');
    expect(html).toContain('/vendor/pagedown.js');
    expect(html).toContain('id="notes-search-input"');
    expect(html).not.toContain('notes-search-clear');
    expect(html).not.toContain('>搜索</button>');
    expect(html).toContain('className="notes-notice-close"');
    expect(html).toContain('setAttribute("aria-label","关闭提示")');
    expect(html).toContain('window.setTimeout(dismissNotice,5000)');
    expect(html).toContain('window.clearTimeout(noticeTimer)');
    expect(html).toContain('notice.addEventListener("click"');
    expect(html).toContain('searchInput.addEventListener("search"');
    expect(html).toContain('resize:vertical');
    expect(html).toContain('syncPreviewHeight');
    expect(html).toContain('ResizeObserver');
    expect(html).toContain('#wmd-hr-button');
    expect(html).not.toContain('fullscreen:"全屏');
    expect(html).not.toContain('undo:"撤销');
    expect(html).not.toContain('redo:"重做');
    expect(html).toContain('data-note-topic');
    expect(html).toContain('state.topic===topic?0:topic');
    expect(html).toContain('@media(max-width:760px)');
    expect(html).toContain('"csrf-value"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0])).not.toThrow();
  });

  it('injects write and manage links immediately after the native post links', () => {
    const footer = collectHooks().get('admin:footer')!;
    const html = footer('', { activeMenu: 'notes', user: { group: 'administrator' } });
    expect(html).toContain("insertAfter(2,'/admin/write-post','/admin/plugin/notes','撰写笔记',false)");
    expect(html).toContain("insertAfter(3,'/admin/manage-posts','/admin/plugin/notes','笔记',true)");
    expect(html).toContain("insertAdjacentElement('afterend',item)");
    expect(footer('unchanged', { activeMenu: 'notes', user: { group: 'editor' } })).toBe('unchanged');
  });

  it('creates a topic and completes the note create, list, update and delete flow', async () => {
    const topicResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create-topic', name: '日常' }),
    }), { db: db as any, uid: 1 });
    expect(topicResponse.status).toBe(200);
    const topic = (await topicResponse.json()).topic;

    const createResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', content: '**hello** #自动话题', status: 'publish', topicMid: topic.mid }),
    }), { db: db as any, uid: 1 });
    const cid = (await createResponse.json()).cid;
    expect(createResponse.status).toBe(200);

    const listResponse = await handleNotesRequest(new Request(`https://example.com/api/admin/notes?topic=${topic.mid}`), { db: db as any, uid: 1 });
    const listBody = await listResponse.json();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]).toMatchObject({ cid, source: '**hello** #自动话题', status: 'publish' });
    expect(listBody.data[0].html).toContain('<strong>hello</strong>');
    expect(listBody.data[0].topics.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(['日常', '自动话题']));
    expect(listBody.topics[0].count).toBe(1);

    const searchResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes?keywords=hello'), { db: db as any, uid: 1 });
    expect((await searchResponse.json()).data).toHaveLength(1);
    const emptySearchResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes?keywords=missing'), { db: db as any, uid: 1 });
    expect((await emptySearchResponse.json()).data).toEqual([]);

    const updateResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'update', cid, content: 'private note', status: 'private', topicMid: 0 }),
    }), { db: db as any, uid: 1 });
    expect(updateResponse.status).toBe(200);

    const deleteResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', cid }),
    }), { db: db as any, uid: 1 });
    expect(deleteResponse.status).toBe(200);
    const finalList = await handleNotesRequest(new Request('https://example.com/api/admin/notes'), { db: db as any, uid: 1 });
    expect((await finalList.json()).data).toEqual([]);
  });

  it('persists non-image attachments, drops orphans, and syncs updates', async () => {
    const { contents, fields } = await import('@/db/schema');
    const now = Math.floor(Date.now() / 1000);
    const inserted = await db.insert(contents).values([
      {
        title: '文档.pdf', slug: 'att-1',
        text: JSON.stringify({ name: '文档.pdf', url: 'https://r2.example.com/att/文档.pdf', size: 2048, type: 'application/pdf' }),
        created: now, modified: now, authorId: 1, type: 'attachment' as const, status: 'publish' as const,
      },
      {
        title: 'video.mp4', slug: 'att-2',
        text: JSON.stringify({ name: 'video.mp4', url: 'https://r2.example.com/att/video.mp4', size: 1024, type: 'video/mp4' }),
        created: now, modified: now, authorId: 1, type: 'attachment' as const, status: 'publish' as const,
      },
      {
        title: 'post-not-attachment', slug: 'att-3', text: '<!--markdown-->不是附件',
        created: now, modified: now, authorId: 1, type: 'post' as const, status: 'publish' as const,
      },
    ]).returning({ cid: contents.cid });
    const [pdf, video, post] = inserted.map(row => row.cid);

    const createResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', content: '带附件', status: 'publish', attachments: [pdf, video, post, 99_999, 0, -1] }),
    }), { db: db as any, uid: 1 });
    const created = await createResponse.json();
    expect(createResponse.status).toBe(200);
    expect(created.attachments).toEqual([pdf, video]);
    const cid = created.cid;

    const savedField = await db.query.fields.findFirst({
      where: (row: any, { and, eq }: any) => and(eq(row.cid, cid), eq(row.name, 'note_attachments')),
    });
    expect(savedField?.str_value).toBe(JSON.stringify([pdf, video]));

    const listResponse = await handleNotesRequest(new Request(`https://example.com/api/admin/notes?cid=${cid}`), { db: db as any, uid: 1 });
    const note = (await listResponse.json()).data[0];
    expect(note.attachments).toMatchObject([
      { cid: pdf, name: '文档.pdf', url: 'https://r2.example.com/att/文档.pdf', size: 2048, type: 'application/pdf' },
    ]);
    expect(note.videos).toMatchObject([
      { cid: video, name: 'video.mp4', url: 'https://r2.example.com/att/video.mp4', size: 1024, type: 'video/mp4' },
    ]);

    const updateResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'update', cid, content: '去掉一个附件', status: 'publish', attachments: [video] }),
    }), { db: db as any, uid: 1 });
    expect(updateResponse.status).toBe(200);
    const updatedField = await db.query.fields.findFirst({
      where: (row: any, { and, eq }: any) => and(eq(row.cid, cid), eq(row.name, 'note_attachments')),
    });
    expect(updatedField?.str_value).toBe(JSON.stringify([video]));

    await db.delete(contents).where(eq(contents.cid, video));
    const staleList = await handleNotesRequest(new Request(`https://example.com/api/admin/notes?cid=${cid}`), { db: db as any, uid: 1 });
    expect((await staleList.json()).data[0].videos).toEqual([]);

    const deleteResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', cid }),
    }), { db: db as any, uid: 1 });
    expect(deleteResponse.status).toBe(200);
    const remainingFields = await db.select({ cid: fields.cid }).from(fields).where(eq(fields.cid, cid));
    expect(remainingFields).toEqual([]);
  });

  it('splits attachments into images / videos / music / others and merges legacy note_images', async () => {
    const { contents, fields } = await import('@/db/schema');
    const now = Math.floor(Date.now() / 1000);
    const inserted = await db.insert(contents).values([
      {
        title: 'photo.png', slug: 'att-img',
        text: JSON.stringify({ name: 'photo.png', url: 'https://r2.example.com/att/photo.png', size: 100, type: 'image/png' }),
        created: now, modified: now, authorId: 1, type: 'attachment' as const, status: 'publish' as const,
      },
      {
        title: 'clip.webm', slug: 'att-vid',
        text: JSON.stringify({ name: 'clip.webm', url: 'https://r2.example.com/att/clip.webm', size: 200, type: 'video/webm' }),
        created: now, modified: now, authorId: 1, type: 'attachment' as const, status: 'publish' as const,
      },
      {
        title: 'clip2.webm', slug: 'att-vid2',
        text: JSON.stringify({ name: 'clip2.webm', url: 'https://r2.example.com/att/clip2.webm', size: 220, type: 'video/webm' }),
        created: now, modified: now, authorId: 1, type: 'attachment' as const, status: 'publish' as const,
      },
      {
        title: 'song.mp3', slug: 'att-mus',
        text: JSON.stringify({ name: 'song.mp3', url: 'https://r2.example.com/att/song.mp3', size: 300, type: 'audio/mpeg' }),
        created: now, modified: now, authorId: 1, type: 'attachment' as const, status: 'publish' as const,
      },
      {
        title: 'song2.mp3', slug: 'att-mus2',
        text: JSON.stringify({ name: 'song2.mp3', url: 'https://r2.example.com/att/song2.mp3', size: 320, type: 'audio/mpeg' }),
        created: now, modified: now, authorId: 1, type: 'attachment' as const, status: 'publish' as const,
      },
      {
        title: 'legacy.jpg', slug: 'att-legacy',
        text: JSON.stringify({ name: 'legacy.jpg', url: 'https://r2.example.com/att/legacy.jpg', size: 400, type: 'image/jpeg' }),
        created: now, modified: now, authorId: 1, type: 'attachment' as const, status: 'publish' as const,
      },
      {
        title: 'notes.zip', slug: 'att-zip',
        text: JSON.stringify({ name: 'notes.zip', url: 'https://r2.example.com/att/notes.zip', size: 500, type: 'application/zip' }),
        created: now, modified: now, authorId: 1, type: 'attachment' as const, status: 'publish' as const,
      },
    ]).returning({ cid: contents.cid });
    const [photo, clip, clip2, song, song2, legacy, zip] = inserted.map(row => row.cid);

    const createResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', content: '多媒体', status: 'publish', attachments: [photo, clip, song, clip2, song2, zip] }),
    }), { db: db as any, uid: 1 });
    const { cid } = await createResponse.json();
    expect(createResponse.status).toBe(200);

    await db.insert(fields).values({ cid, name: 'note_images', str_value: JSON.stringify([legacy]) });

    const listResponse = await handleNotesRequest(new Request(`https://example.com/api/admin/notes?cid=${cid}`), { db: db as any, uid: 1 });
    const note = (await listResponse.json()).data[0];
    expect(note.images).toMatchObject([
      { cid: legacy, name: 'legacy.jpg', type: 'image/jpeg' },
      { cid: photo, name: 'photo.png', type: 'image/png' },
    ]);
    expect(note.videos).toMatchObject([{ cid: clip, name: 'clip.webm', type: 'video/webm' }]);
    expect(note.music).toMatchObject([{ cid: song, name: 'song.mp3', type: 'audio/mpeg' }]);
    expect(note.attachments).toMatchObject([
      { cid: clip2, name: 'clip2.webm', type: 'video/webm' },
      { cid: song2, name: 'song2.mp3', type: 'audio/mpeg' },
      { cid: zip, name: 'notes.zip', type: 'application/zip' },
    ]);
    expect(note.images).toHaveLength(2);

    const deleteResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', cid }),
    }), { db: db as any, uid: 1 });
    expect(deleteResponse.status).toBe(200);
  });

  it('exposes public notes anonymously and the current author private notes when logged in', async () => {
    const { contents } = await import('@/db/schema');
    const now = Math.floor(Date.now() / 1000);
    const created = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', content: '公开笔记 #主题开发', status: 'publish' }),
    }), { db: db as any, uid: 1 });
    const noteCid = (await created.json()).cid;
    await db.insert(contents).values({
      title: '文章', slug: 'theme-post', text: '<!--markdown-->文章内容', created: now - 1,
      modified: now - 1, authorId: 1, type: 'post', status: 'publish', allowComment: '1',
    });
    const privateCreated = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', content: '私密笔记', status: 'private' }),
    }), { db: db as any, uid: 1 });
    const privateCid = (await privateCreated.json()).cid;
    await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', content: '草稿笔记', status: 'draft' }),
    }), { db: db as any, uid: 1 });
    await db.insert(contents).values({
      title: null, slug: 'other-private-note', text: '<!--markdown-->他人的私密笔记', created: now - 2,
      modified: now - 2, authorId: 2, type: 'note', status: 'private', allowComment: '0',
    });

    const variables = await getNotesForTheme(db as any, {}, {
      siteUrl: 'https://example.com',
      permalinkPattern: '/post/{slug}/',
    });
    expect(variables.notes).toHaveLength(1);
    expect(variables.notes[0]).toMatchObject({ cid: noteCid, type: 'note', permalink: `https://example.com/note/${noteCid}` });
    expect(variables.mixed.map(item => item.type)).toEqual(expect.arrayContaining(['note', 'post']));
    expect(variables.mixed.find(item => item.type === 'post')?.permalink).toBe('https://example.com/post/theme-post/');
    expect(variables.mixed.find(item => item.cid === noteCid)?.topics[0]?.name).toBe('主题开发');
    expect(variables.mixed.some(item => item.source === '私密笔记')).toBe(false);

    const loggedInVariables = await getNotesForTheme(db as any, { viewerUid: 1 }, {
      siteUrl: 'https://example.com',
      permalinkPattern: '/post/{slug}/',
    });
    expect(loggedInVariables.notes.map(item => item.cid)).toEqual(expect.arrayContaining([noteCid, privateCid]));
    expect(loggedInVariables.notes.some(item => item.source === '草稿笔记')).toBe(false);
    expect(loggedInVariables.notes.some(item => item.source === '他人的私密笔记')).toBe(false);
    expect((await getNoteForTheme(db as any, privateCid, 'https://example.com', 1))?.cid).toBe(privateCid);
    expect(await getNoteForTheme(db as any, privateCid, 'https://example.com')).toBeNull();
  });

  it('loads one lookahead stream, caches only public data, and honors Notes invalidation', async () => {
    const stored = new Map<string, unknown>();
    const cacheKeys: string[] = [];
    let reads = 0;
    let writes = 0;
    const provider: EarlyRequestProvider = {
      handle: async (_context, next) => next(),
      readSharedData: async <T,>(domain: SharedCacheDomain, key: string): Promise<SharedDataRead<T>> => {
        if (domain !== 'notes') return { handled: false, value: null };
        reads++;
        return { handled: true, value: (stored.get(key) as T | undefined) ?? null };
      },
      writeSharedData: async (domain, key, value) => {
        if (domain !== 'notes') return false;
        writes++;
        cacheKeys.push(key);
        stored.set(key, value);
        return true;
      },
      invalidate: async event => {
        const domains = event.sharedDomains;
        if (!domains || !(domains[0] === 'all' || (domains as readonly string[]).includes('notes'))) return false;
        stored.clear();
        return true;
      },
    };
    registerEarlyRequestLoaders({
      'notes-test-cache': async () => provider,
    });

    const { contents } = await import('@/db/schema');
    const now = Math.floor(Date.now() / 1000);
    await db.insert(contents).values([
      ...[1, 2, 3].map(index => ({
        slug: `public-stream-note-${index}`,
        text: `<!--markdown-->公开笔记 ${index}`,
        created: now - index,
        modified: now - index,
        authorId: 1,
        type: 'note' as const,
        status: 'publish' as const,
        allowComment: '1' as const,
      })),
      {
        slug: 'private-stream-note',
        text: '<!--markdown-->私密笔记',
        created: now - 10,
        modified: now - 10,
        authorId: 1,
        type: 'note',
        status: 'private',
        allowComment: '0',
      },
      {
        title: 'Mixed stream post',
        slug: 'mixed-stream-post',
        text: '<!--markdown-->文章',
        created: now - 20,
        modified: now - 20,
        authorId: 1,
        type: 'post',
        status: 'publish',
        allowComment: '1',
      },
    ]);

    const publicNotes = await getNotesStreamForTheme(db as any, 'notes', { pageSize: 2 }, {
      siteUrl: 'https://example.com', permalinkPattern: '/post/{slug}/',
    });
    expect(publicNotes.items).toHaveLength(2);
    expect(publicNotes.pagination).toEqual({
      page: 1, pageSize: 2, totalsExact: false, hasPrev: false, hasNext: true,
    });
    expect(writes).toBe(1);
    expect(JSON.parse(cacheKeys[0]!)).toMatchObject({
      stream: 'notes', page: 1, pageSize: 2, topic: '',
      siteUrl: 'https://example.com', permalinkPattern: '/post/{slug}/',
    });

    await getNotesStreamForTheme(db as any, 'notes', { pageSize: 2 }, {
      siteUrl: 'https://example.com', permalinkPattern: '/post/{slug}/',
    });
    expect(writes).toBe(1);

    const finalPublicPage = await getNotesStreamForTheme(db as any, 'notes', { page: 2, pageSize: 2 }, {
      siteUrl: 'https://example.com', permalinkPattern: '/post/{slug}/',
    });
    expect(finalPublicPage.items).toHaveLength(1);
    expect(finalPublicPage.pagination.hasNext).toBe(false);
    expect(writes).toBe(2);

    const mixed = await getNotesStreamForTheme(db as any, 'mixed', { pageSize: 5 }, {
      siteUrl: 'https://example.com', permalinkPattern: '/post/{slug}/',
    });
    expect(mixed.items.some(item => item.type === 'post')).toBe(true);
    expect(writes).toBe(3);

    const readsBeforePrivateLoad = reads;
    const privateNotes = await getNotesStreamForTheme(db as any, 'notes', { pageSize: 5, viewerUid: 1 }, {
      siteUrl: 'https://example.com', permalinkPattern: '/post/{slug}/',
    });
    expect(privateNotes.items.some(item => item.status === 'private')).toBe(true);
    expect(reads).toBe(readsBeforePrivateLoad);
    expect(writes).toBe(3);

    await notifyEarlyRequestInvalidation({ reason: 'note-update', domains: [], sharedDomains: ['notes'] });
    await getNotesStreamForTheme(db as any, 'notes', { pageSize: 2 }, {
      siteUrl: 'https://example.com', permalinkPattern: '/post/{slug}/',
    });
    expect(writes).toBe(4);
  });

  it('accepts frontend comments on public notes and rejects non-public notes', async () => {
    const { contents, options } = await import('@/db/schema');
    await db.insert(options).values([
      { name: 'commentsAntiSpam', user: 0, value: '0' },
      { name: 'commentsPostIntervalEnable', user: 0, value: '0' },
    ]);
    const created = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', content: '允许前台评论', status: 'publish' }),
    }), { db: db as any, uid: 1 });
    const publicCid = (await created.json()).cid;

    init({ pluginId: COMMENT_PLUGIN_ID, HookPoints: {} as any, addHook });
    const siteOptions = await loadOptions(db as any);
    async function postComment(cid: number) {
      const request = new Request('https://example.com/api/comment', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://example.com',
          referer: `https://example.com/note/${cid}`,
        },
        body: new URLSearchParams({ cid: String(cid), text: '前台评论', author: '访客', mail: 'visitor@example.com' }),
      });
      const locals = {} as any;
      setRequestCoreContext(locals, {
        db: db as any,
        options: siteOptions,
        pluginCtx: { activatedPlugins: new Set([COMMENT_PLUGIN_ID]) },
      }, request);
      return submitComment({ request, locals } as any);
    }

    const accepted = await postComment(publicCid);
    expect(accepted.status).toBe(302);
    expect(accepted.headers.get('location')).toMatch(new RegExp(`^/note/${publicCid}#comment-\\d+$`));
    const savedComments = await db.query.comments.findMany({
      where: (comment: any, { eq }: any) => eq(comment.cid, publicCid),
    });
    expect(savedComments).toHaveLength(1);

    const now = Math.floor(Date.now() / 1000);
    const blockedRows = await db.insert(contents).values([
      { slug: 'private-comment-note', text: '<!--markdown-->private', created: now, modified: now, authorId: 1, type: 'note', status: 'private', allowComment: '0' },
      { slug: 'draft-comment-note', text: '<!--markdown-->draft', created: now, modified: now, authorId: 1, type: 'note', status: 'draft', allowComment: '0' },
      { slug: 'future-comment-note', text: '<!--markdown-->future', created: now + 3600, modified: now, authorId: 1, type: 'note', status: 'publish', allowComment: '1' },
    ]).returning({ cid: contents.cid });
    for (const row of blockedRows) expect((await postComment(row.cid)).status).toBe(403);
  });

  it('lists and replies to note comments through the protected plugin service', async () => {
    const { comments, contents } = await import('@/db/schema');
    const now = Math.floor(Date.now() / 1000);
    const inserted = await db.insert(contents).values({
      title: null, slug: 'commentable-note', text: '<!--markdown-->可评论笔记', created: now,
      modified: now, authorId: 1, type: 'note', status: 'publish', allowComment: '0', commentsNum: 1,
    }).returning({ cid: contents.cid });
    const cid = inserted[0]!.cid;
    const parentRows = await db.insert(comments).values({
      cid, created: now - 10, author: '访客', mail: 'visitor@example.com', text: '原评论',
      type: 'comment', status: 'approved', parent: 0,
    }).returning({ coid: comments.coid });
    const parent = parentRows[0]!.coid;

    const context = {
      db: db as any,
      uid: 1,
      user: { name: 'admin', screenName: '管理员', mail: 'admin@example.com', url: '' },
      options: { siteUrl: 'https://example.com', commentsMarkdown: true },
    };
    const listResponse = await handleNotesRequest(
      new Request(`https://example.com/api/admin/notes?commentsCid=${cid}`),
      context,
    );
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).comments[0]).toMatchObject({ coid: parent, author: '访客', parent: 0 });

    const replyResponse = await handleNotesRequest(new Request('https://example.com/api/admin/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reply-comment', cid, parent, text: '后台回复' }),
    }), context);
    expect(replyResponse.status).toBe(200);
    const saved = await db.query.comments.findFirst({
      where: (comment: any, { eq }: any) => eq(comment.text, '后台回复'),
    });
    expect(saved).toMatchObject({ cid, parent, authorId: 1, status: 'approved' });
    const note = await db.query.contents.findFirst({ where: (content: any, { eq }: any) => eq(content.cid, cid) });
    expect(note?.commentsNum).toBe(2);
  });

  it('uses the real admin action guard for unauthenticated and cross-origin writes', async () => {
    const route = collectHooks().get('route:request')!;
    const options = await loadOptions(db as any);
    const unauthenticated = new Request('https://example.com/api/admin/notes');
    setRequestCoreContext({} as any, { db: db as any, options, pluginCtx: { activatedPlugins: new Set() } }, unauthenticated);
    const denied = await route({ handled: false }, { request: unauthenticated, path: NOTES_ADMIN_API_PATH });
    expect(denied.response.status).toBe(401);

    const cookie = await makeAuthCookie(db, 1, AUTH_CODE, SECRET);
    const csrf = await generateSecurityToken(SECRET, AUTH_CODE, 1);
    const crossOrigin = new Request('https://example.com/api/admin/notes', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', content: 'blocked' }),
    });
    setRequestCoreContext({} as any, { db: db as any, options, pluginCtx: { activatedPlugins: new Set() } }, crossOrigin);
    const forbidden = await route({ handled: false }, { request: crossOrigin, path: NOTES_ADMIN_API_PATH });
    expect(forbidden.response.status).toBe(403);
  });
});
