import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../../../tests/helpers';
import { schema } from 'typecho/db';
import { HookPoints } from 'typecho/plugin-sdk';
import init from './index';
import { readSummary, upsertSummary } from './summary';
import { SETTINGS_DEFAULTS } from './config';

const AI_SUMMARY = '这是一段由 AI 生成的内容概览。';
let db: TestDatabase;
let hooks: Map<string, (...args: any[]) => any>;
let fetchMock: ReturnType<typeof vi.fn>;

function options(enabled = '1') {
  return { 'plugin:typecho-plugin-engine': JSON.stringify({
    ...SETTINGS_DEFAULTS, endpoint: 'https://ai.example/v1', apiKey: 'test-key', model: 'test-model', autoSummary: enabled,
  }) };
}

async function seed(type = 'post') {
  const [row] = await db.insert(schema.contents).values({
    title: '测试标题', slug: `summary-${type}`, text: '正文内容', type, status: 'publish', created: 1, modified: 1, authorId: 1,
  }).returning();
  return row;
}

beforeEach(async () => {
  db = await createTestDb();
  hooks = new Map();
  init({ pluginId: 'typecho-plugin-engine', HookPoints, addHook(point, _plugin, handler) { hooks.set(point, handler); } });
  fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: AI_SUMMARY } }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('automatic AI summaries', () => {
  it.each(['post', 'page'])('automatically summarizes a published %s through waitUntil', async type => {
    const content = await seed(type);
    const tasks: Promise<unknown>[] = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => tasks.push(task));
    await hooks.get(`${type}:finishPublish`)!(content, { db, options: options(), waitUntil });
    expect(waitUntil).toHaveBeenCalledOnce();
    await Promise.all(tasks);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await readSummary(db, content.cid!)).toBe(AI_SUMMARY);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.messages[0].content).toContain('帮助读者快速理解内容');
    expect(request.messages[0].content).not.toContain('站内搜索');
    expect(request.messages[1].content).toContain(content.title);
  });

  it('awaits generation when an adapter provides no waitUntil', async () => {
    const content = await seed();
    await hooks.get('post:finishPublish')!(content, { db, options: options() });
    expect(await readSummary(db, content.cid!)).toBe(AI_SUMMARY);
  });

  it.each(['post', 'page'])('does no AI or database work for %s with automatic generation off', async type => {
    const access = vi.fn(() => { throw new Error('must not access database'); });
    const untouchedDb = new Proxy({}, { get: access });
    const waitUntil = vi.fn();
    await hooks.get(`${type}:finishPublish`)!({ cid: 1, type, status: 'publish', text: '正文' }, { db: untouchedDb, options: options('0'), waitUntil });
    expect(access).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'post_draft', status: 'draft' },
    { type: 'page_draft', status: 'publish' },
    { type: 'post', status: 'waiting' },
    { type: 'page', status: 'private' },
    { type: 'attachment', status: 'publish' },
    { type: 'post', status: 'hidden' },
  ])('does not generate for ineligible content %j', async state => {
    const waitUntil = vi.fn();
    await hooks.get('post:finishPublish')!({ cid: 1, ...state }, { db, options: options(), waitUntil });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN])('ignores invalid cid %s', async cid => {
    await hooks.get('post:finishPublish')!({ cid, type: 'post', status: 'publish' }, { db, options: options() });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not block publishing or write a fallback if AI fails', async () => {
    const content = await seed();
    fetchMock.mockRejectedValue(new Error('provider unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(hooks.get('post:finishPublish')!(content, { db, options: options() })).resolves.toBeUndefined();
    expect(await readSummary(db, content.cid!)).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('preserves an existing summary on failure or empty AI output', async () => {
    const content = await seed();
    await upsertSummary(db, content.cid!, '原有摘要');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementationOnce(async () => new Response('unavailable', { status: 503 }));
    await hooks.get('post:finishPublish')!(content, { db, options: options() });
    expect(await readSummary(db, content.cid!)).toBe('原有摘要');
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] })));
    await hooks.get('post:finishPublish')!(content, { db, options: options() });
    expect(await readSummary(db, content.cid!)).toBe('原有摘要');
    expect(log).toHaveBeenCalled();
  });

  it('regenerates on published content updates, preserving the existing publish-hook behavior', async () => {
    const content = await seed();
    await upsertSummary(db, content.cid!, '旧摘要');
    await hooks.get('post:finishPublish')!({ ...content, text: '更新后的正文' }, { db, options: options(), previousText: content.text });
    expect(await readSummary(db, content.cid!)).toBe(AI_SUMMARY);
  });

  it('manual generation remains available when the automatic switch is off', async () => {
    const content = await seed();
    const result = await hooks.get('plugin:typecho-plugin-engine:action')!({}, { action: 'summarizeOne', payload: { cid: content.cid }, db, options: options('0') });
    expect(result).toMatchObject({ success: true, summary: AI_SUMMARY });
    expect(await readSummary(db, content.cid!)).toBe(AI_SUMMARY);
  });
});
