import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAuthToken, generateSecurityToken } from '@/lib/auth';
import { SECRET_PLACEHOLDER } from '@/lib/plugin-config-secrets';
import init from './index';
import { renderTemplate, escapeVars, jsonEscapeVars, htmlToText, isValidJsonTemplate } from './templates';
import {
  normalizeConfig, loadConfig, isValidEmail,
  isEmailReady, isWebhookReady, emailInvalidReason,
  DEFAULT_MAIL_SUBJECT, DEFAULT_MAIL_BODY,
} from './config';
import { validateAndNormalizeSettings } from './validate';
import { sendEmail, sendWebhook } from './channels';

// Non-credential-like fixture values; the adapter logic only checks presence.
const KEY = 'k';
const WEBHOOK_URL = 'https://hooks.example.com/t';
const WEBHOOK_TOKEN = 'wt';

// ── Test helpers ────────────────────────────────────────────────────────────

function collectHooks(): Map<string, Function> {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-notifier',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
  });
  return hooks;
}

function options(settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    'plugin:typecho-plugin-notifier': JSON.stringify({
      emailProvider: 'resend',
      emailApiKey: KEY,
      emailFrom: 'blog@example.com',
      emailFromName: '博客',
      webhookUrl: WEBHOOK_URL,
      webhookToken: WEBHOOK_TOKEN,
      mailSubject: '[{site.name}] 新消息：{reply.author}',
      mailBody: '<p>{site.name}</p><p>{reply.content}</p>',
      commentWebhookPayload: '{"author":"{reply.author}","content":"{reply.content}"}',
      systemWebhookPayload: '{"event":"system","subject":"{subject}","site":"{site.name}"}',
      ...settings,
    }),
    title: '测试博客',
    siteUrl: 'https://example.com',
    ...extra,
  };
}

function makeExtra(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request('https://example.com/'),
    options: options({}),
    db: mockDb(),
    siteUrl: 'https://example.com',
    permalinkPattern: '/archives/{cid}/',
    pagePattern: '/{slug}.html',
    ...overrides,
  };
}

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([{ uid: 1, mail: 'admin@example.com' }]),
      },
      contents: {
        findFirst: vi.fn().mockResolvedValue({
          cid: 10, title: '测试文章', slug: 'test-post', type: 'post', created: 1700000000, authorId: 1,
        }),
      },
      comments: {
        findFirst: vi.fn().mockResolvedValue({ mail: 'parent@example.com', author: '父评论者', text: '父评论内容' }),
      },
    },
    ...overrides,
  };
}

function okResponse(body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ...body, success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function errorResponse(status = 401, body: Record<string, unknown> = { message: 'bad key' }): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(okResponse({ id: 'mocked-id' }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Extract the JSON body of the first fetch call to the given URL. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, url: string): any {
  const call = fetchMock.mock.calls.find(([u]) => u === url);
  if (!call) throw new Error(`no fetch call to ${url}`);
  return JSON.parse(call[1].body);
}

const commentFixture = {
  coid: 7, cid: 10, author: '访客', mail: 'guest@example.com', text: '不错的文章',
  parent: 0, authorId: null, status: 'approved',
};

const replyFixture = {
  ...commentFixture,
  coid: 8,
  parent: 5,
};

/** Build a signed admin session (cookie + CSRF token) for route:request tests. */
async function adminSession(group = 'administrator') {
  const secret = 'admin-secret';
  const authCode = 'admin-auth';
  const uid = 1;
  const token = await generateAuthToken(uid, authCode, secret);
  const csrf = await generateSecurityToken(secret, authCode, uid);
  const cookie = `__typecho_uid=${uid}; __typecho_authCode=${token.split(':')[1]}`;
  const authDb = {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({ uid, name: 'admin', authCode, group }),
        findMany: vi.fn().mockResolvedValue([{ uid, mail: 'admin@example.com' }]),
      },
    },
  };
  return { secret, authCode, uid, csrf, cookie, authDb };
}

function adminOptions(auth: Awaited<ReturnType<typeof adminSession>>, settings: Record<string, unknown> = {}) {
  return { secret: auth.secret, ...options(settings) };
}

async function postTestRequest(auth: Awaited<ReturnType<typeof adminSession>>, body: unknown, overrides: Record<string, unknown> = {}) {
  return new Request('https://example.com/api/admin/plugin-notifier/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf, cookie: auth.cookie },
    body: JSON.stringify(body),
    ...overrides,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('typecho-plugin-notifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('hook registration', () => {
    it('registers all expected hooks', () => {
      const hooks = collectHooks();
      expect([...hooks.keys()].sort()).toEqual([
        'admin:footer',
        'admin:page',
        'feedback:finishComment',
        'mail:send',
        'route:request',
      ]);
    });
  });

  describe('template rendering', () => {
    it('replaces known placeholders and drops unknown ones', () => {
      expect(renderTemplate('[{site.name}] {unknown}', { 'site.name': '博客' })).toBe('[博客] ');
    });

    it('supports dotted placeholders and null values', () => {
      expect(renderTemplate('{reply.author}: {comment.author}', {
        'reply.author': '新评论者',
        'comment.author': null,
      })).toBe('新评论者: ');
    });

    it('escapes user content for HTML emails but not for text versions', () => {
      const vars = { 'reply.content': 'a<b>&"c"' };
      expect(escapeVars(vars)['reply.content']).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
      expect(renderTemplate('{reply.content}', vars)).toBe('a<b>&"c"');
    });

    it('escapes values for JSON string embedding', () => {
      const vars = { 'reply.content': 'say "hi"\n\\end' };
      expect(jsonEscapeVars(vars)['reply.content']).toBe('say \\"hi\\"\\n\\\\end');
      const rendered = renderTemplate('{"c":"{reply.content}"}', jsonEscapeVars(vars));
      expect(JSON.parse(rendered)).toEqual({ c: 'say "hi"\n\\end' });
    });

    it('validates WebHook JSON templates with dummy placeholders', () => {
      expect(isValidJsonTemplate('{"a":"{reply.author}"}')).toBe(true);
      // Placeholders must sit inside quotes — an unquoted placeholder breaks the JSON.
      expect(isValidJsonTemplate('{"a":{reply.author}}')).toBe(false);
      expect(isValidJsonTemplate('{not json')).toBe(false);
      expect(isValidJsonTemplate('{"a": "x",}')).toBe(false);
    });

    it('derives plain text from HTML bodies', () => {
      expect(htmlToText('<p>Hello</p><p>World</p>')).toBe('Hello\nWorld');
    });
  });

  describe('config loading', () => {
    it('defaults every channel toggle to off', () => {
      const cfg = normalizeConfig({});
      expect(cfg.systemEmail).toBe(false);
      expect(cfg.commentWebhook).toBe(false);
      expect(cfg.replyEmail).toBe(false);
    });

    it('forces all toggles off when legacy enabled is false', () => {
      const cfg = normalizeConfig({
        enabled: '0',
        systemEmail: '1',
        commentWebhook: '1',
        replyEmail: '1',
        emailApiKey: KEY,
        emailFrom: 'a@b.co',
      });
      expect(cfg.systemEmail).toBe(false);
      expect(cfg.commentWebhook).toBe(false);
      expect(cfg.replyEmail).toBe(false);
      expect(cfg.emailApiKey).toBe(KEY);
    });

    it('normalizes the email provider', () => {
      const cfg = normalizeConfig({ provider: 'smtp', emailProvider: 'brevo' });
      expect(cfg.emailProvider).toBe('brevo');
      expect(normalizeConfig({ emailProvider: 'smtp' }).emailProvider).toBe('resend');
    });

    it('merges the 2.1 per-category mail templates into the unified one', () => {
      const cfg = normalizeConfig({
        commentSubject: '旧标题',
        commentBody: '<i>旧正文</i>',
        replySubject: '回复标题',
        replyBody: '<b>回复正文</b>',
      });
      expect(cfg.mailSubject).toBe('旧标题');
      expect(cfg.mailBody).toBe('<i>旧正文</i>');

      // An explicit unified key wins over stored legacy keys.
      const explicit = normalizeConfig({ mailSubject: '新标题', commentSubject: '旧标题' });
      expect(explicit.mailSubject).toBe('新标题');

      // Nothing stored → default template.
      expect(normalizeConfig({}).mailSubject).toBe(DEFAULT_MAIL_SUBJECT);
      expect(normalizeConfig({}).mailBody).toBe(DEFAULT_MAIL_BODY);
    });

    it('merges stored settings with template defaults', () => {
      const cfg = loadConfig(options({ commentEmail: '1' }));
      expect(cfg.commentEmail).toBe(true);
      expect(cfg.systemWebhook).toBe(false);
      expect(cfg.mailSubject).toBe('[{site.name}] 新消息：{reply.author}');
      expect(cfg.systemWebhookPayload).toBe('{"event":"system","subject":"{subject}","site":"{site.name}"}');
    });

    it('falls back to defaults on invalid JSON', () => {
      const cfg = loadConfig({ 'plugin:typecho-plugin-notifier': 'not json' });
      expect(cfg.systemEmail).toBe(false);
      expect(cfg.emailProvider).toBe('resend');
    });

    it('keeps the default JSON payloads valid after formatting (multi-line)', () => {
      const cfg = normalizeConfig({});
      for (const key of [
        'systemWebhookPayload', 'commentWebhookPayload',
      ] as const) {
        expect(isValidJsonTemplate(cfg[key]), key).toBe(true);
        expect(cfg[key], key).toContain('\n');
      }
    });

    it('maps legacy Mailer config onto the new shape', () => {
      const legacy = {
        'plugin:typecho-plugin-mailer': JSON.stringify({
          enabled: '1',
          provider: 'brevo',
          apiKey: KEY,
          from: 'legacy@example.com',
          fromName: '旧站',
          commentNotifyEnabled: '1',
          replyNotifyEnabled: '0',
          subject: '[{site.name}] 旧标题',
          body: '<p>{reply.content}</p>',
        }),
        title: '测试博客',
        siteUrl: 'https://example.com',
      };
      const cfg = loadConfig(legacy);
      expect(cfg.emailProvider).toBe('brevo');
      expect(cfg.emailApiKey).toBe(KEY);
      expect(cfg.emailFrom).toBe('legacy@example.com');
      expect(cfg.emailFromName).toBe('旧站');
      expect(cfg.commentEmail).toBe(true);
      expect(cfg.replyEmail).toBe(false);
      // Legacy subject/body map onto the unified mail template.
      expect(cfg.mailSubject).toBe('[{site.name}] 旧标题');
      expect(cfg.mailBody).toBe('<p>{reply.content}</p>');
      // New toggles have no legacy equivalent — stay off by default.
      expect(cfg.systemEmail).toBe(false);
      expect(cfg.systemWebhook).toBe(false);
    });

    it('maps legacy Mailer with enabled off to all toggles off', () => {
      const legacy = {
        'plugin:typecho-plugin-mailer': JSON.stringify({
          enabled: '0',
          provider: 'brevo',
          apiKey: KEY,
          from: 'legacy@example.com',
          commentNotifyEnabled: '1',
          replyNotifyEnabled: '1',
        }),
      };
      const cfg = loadConfig(legacy);
      expect(cfg.commentEmail).toBe(false);
      expect(cfg.replyEmail).toBe(false);
    });

    it('prefers the new config key over the legacy key', () => {
      const both = {
        'plugin:typecho-plugin-notifier': JSON.stringify({ emailProvider: 'plunk' }),
        'plugin:typecho-plugin-mailer': JSON.stringify({ enabled: '1', emailProvider: 'brevo', apiKey: KEY, from: 'a@b.co' }),
      };
      const cfg = loadConfig(both);
      expect(cfg.emailProvider).toBe('plunk');
    });

    it('validates email addresses and channel readiness', () => {
      expect(isValidEmail('a@b.co')).toBe(true);
      expect(isValidEmail('not-an-email')).toBe(false);

      const base = normalizeConfig({ emailApiKey: KEY, emailFrom: 'a@b.co' });
      expect(isEmailReady(base)).toBe(true);
      // Legacy enabled:false does not affect credential readiness (only category toggles).
      expect(isEmailReady(normalizeConfig({ enabled: '0', emailApiKey: KEY, emailFrom: 'a@b.co' }))).toBe(true);
      expect(isEmailReady(normalizeConfig({ emailApiKey: '', emailFrom: 'a@b.co' }))).toBe(false);
      expect(isWebhookReady(normalizeConfig({ webhookUrl: WEBHOOK_URL }))).toBe(true);
      expect(isWebhookReady(normalizeConfig({ webhookUrl: 'ftp://nope' }))).toBe(false);

      expect(emailInvalidReason(normalizeConfig({ emailApiKey: KEY, emailFrom: 'a@b.co' }))).toBeNull();
      expect(emailInvalidReason(normalizeConfig({ emailApiKey: '', emailFrom: 'a@b.co' }))).toContain('API Key');
      expect(emailInvalidReason(normalizeConfig({ emailApiKey: KEY, emailFrom: 'nope' }))).toContain('发件邮箱');
    });
  });

  describe('channel adapters', () => {
    it('sends email via Resend with fromName applied', async () => {
      const fetchMock = stubFetch();
      const result = await sendEmail('resend', KEY, 'blog@example.com', {
        to: 'a@b.co', fromName: '博客', subject: 'S', html: '<p>H</p>', text: 'H',
      });
      expect(result.sent).toBe(true);
      expect(result.channel).toBe('Resend');
      const init: any = fetchMock.mock.calls[0][1];
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.resend.com/emails');
      expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.parse(init.body)).toMatchObject({
        from: '"博客" <blog@example.com>',
        to: ['a@b.co'],
        subject: 'S',
        html: '<p>H</p>',
        text: 'H',
      });
    });

    it('sends email via Brevo with api-key header', async () => {
      const fetchMock = stubFetch();
      await sendEmail('brevo', KEY, 'blog@example.com', { to: 'a@b.co', subject: 'S', html: '<p>H</p>' });
      const init: any = fetchMock.mock.calls[0][1];
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.brevo.com/v3/smtp/email');
      expect(init.headers['api-key']).toBe(KEY);
    });

    it('reports email provider failures with the error message', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, { message: 'API key invalid' })));
      const result = await sendEmail('resend', KEY, 'blog@example.com', { to: 'a@b.co', subject: 'S', html: 'H' });
      expect(result.sent).toBe(false);
      expect(result.error).toContain('API key invalid');
    });

    it('sends WebHook requests with Bearer token and raw payload', async () => {
      const fetchMock = stubFetch();
      const payload = '{"a":"x"}';
      const result = await sendWebhook(WEBHOOK_URL, WEBHOOK_TOKEN, payload);
      expect(result.sent).toBe(true);
      const init: any = fetchMock.mock.calls[0][1];
      expect(fetchMock.mock.calls[0][0]).toBe(WEBHOOK_URL);
      expect(init.headers.Authorization).toBe(`Bearer ${WEBHOOK_TOKEN}`);
      expect(init.body).toBe(payload);

      await sendWebhook(WEBHOOK_URL, '', payload);
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
    });

    it('rejects a rendered payload that is not valid JSON without fetching', async () => {
      const fetchMock = stubFetch();
      const result = await sendWebhook(WEBHOOK_URL, '', '{"a": 未加引号}');
      expect(result.sent).toBe(false);
      expect(result.error).toContain('JSON');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports network failures without throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const result = await sendWebhook(WEBHOOK_URL, '', '{}');
      expect(result.sent).toBe(false);
      expect(result.error).toContain('network down');
    });
  });

  describe('mail:send system notifications', () => {
    it('returns null when legacy enabled is false (all toggles forced off)', async () => {
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      const fetchMock = stubFetch();
      const result = await handler(null, {
        payload: { to: 'x@y.co', subject: 's', html: '<p>h</p>' },
        ctx: { options: options({ enabled: '0', systemEmail: '1' }) },
      });
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null when the system email toggle is off', async () => {
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      const fetchMock = stubFetch();
      const result = await handler(null, {
        payload: { to: 'x@y.co', subject: 's', html: '<p>h</p>', text: 't' },
        ctx: { options: options({ systemEmail: '0' }) },
      });
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('relays the core payload through the email channel with fromName', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      const result = await handler(null, {
        payload: { to: 'user@example.com', subject: '重置密码', html: '<p>hi</p>', text: 'hi' },
        ctx: { options: options({ systemEmail: '1' }), reason: 'password-reset' },
      });
      expect(result.sent).toBe(true);
      const body = bodyOf(fetchMock, 'https://api.resend.com/emails');
      expect(body.to[0]).toBe('user@example.com');
      expect(body.subject).toBe('重置密码');
      expect(body.from).toBe('"博客" <blog@example.com>');
    });

    it('fans out to WebHook when its system toggle is on', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      const result = await handler(null, {
        payload: { to: 'user@example.com', subject: '重置密码', html: '<p>hi</p>', text: '正文文本' },
        ctx: { options: options({ systemEmail: '1', systemWebhook: '1' }), reason: 'password-reset' },
      });
      expect(result.sent).toBe(true);

      const webhookBody = fetchMock.mock.calls.find(([u]) => u === WEBHOOK_URL)![1].body;
      expect(JSON.parse(webhookBody)).toEqual({
        event: 'system',
        subject: '重置密码',
        site: '测试博客',
      });
    });

    it('skips fan-out channels that are not configured', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      await handler(null, {
        payload: { to: 'user@example.com', subject: '重置密码', html: '<p>hi</p>', text: 'hi' },
        ctx: { options: options({ systemEmail: '1', systemWebhook: '1', webhookUrl: '' }) },
      });
      const urls = fetchMock.mock.calls.map(([u]) => u);
      expect(urls).toEqual(['https://api.resend.com/emails']);
    });
  });

  describe('feedback:finishComment notifications', () => {
    it('does nothing when every toggle is off', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(commentFixture, makeExtra());
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('notifies admin by email on an approved comment', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(commentFixture, makeExtra({ options: options({ commentEmail: '1' }) }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = bodyOf(fetchMock, 'https://api.resend.com/emails');
      expect(body.to[0]).toBe('admin@example.com');
      expect(body.subject).toBe('[测试博客] 新消息：访客');
      expect(body.html).toContain('不错的文章');
    });

    it('notifies admin on a waiting (pending moderation) comment', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler({ ...commentFixture, status: 'waiting' }, makeExtra({ options: options({ commentEmail: '1' }) }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('skips spam comments entirely', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler({ ...commentFixture, status: 'spam' }, makeExtra({ options: options({ commentEmail: '1', commentWebhook: '1' }) }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('notifies admin when a reply comment arrives (approved or waiting)', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(replyFixture, makeExtra({ options: options({ commentEmail: '1' }) }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bodyOf(fetchMock, 'https://api.resend.com/emails').to[0]).toBe('admin@example.com');

      fetchMock.mockClear();
      await handler({ ...replyFixture, status: 'waiting' }, makeExtra({ options: options({ commentEmail: '1' }) }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('notifies the parent commenter on an approved reply (and not on a waiting one)', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(replyFixture, makeExtra({ options: options({ replyEmail: '1' }) }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = bodyOf(fetchMock, 'https://api.resend.com/emails');
      expect(body.to[0]).toBe('parent@example.com');
      // The reply mail reuses the unified 新消息 template.
      expect(body.subject).toBe('[测试博客] 新消息：访客');

      fetchMock.mockClear();
      await handler({ ...replyFixture, status: 'waiting' }, makeExtra({ options: options({ replyEmail: '1' }) }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never notifies the commenter about their own reply', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler({ ...replyFixture, mail: 'parent@example.com' }, makeExtra({ options: options({ replyEmail: '1' }) }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('combines admin email, reply email and the WebHook push on an approved reply', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(replyFixture, makeExtra({
        options: options({ commentEmail: '1', commentWebhook: '1', replyEmail: '1' }),
      }));
      const urls = fetchMock.mock.calls.map(([u]) => u);
      expect(urls).toEqual([
        'https://api.resend.com/emails', // admin
        WEBHOOK_URL,
        'https://api.resend.com/emails', // parent commenter
      ]);
      const webhookBody = fetchMock.mock.calls.find(([u]) => u === WEBHOOK_URL)![1].body;
      expect(JSON.parse(webhookBody)).toEqual({ author: '访客', content: '不错的文章' });
    });

    it('escapes comment content inside the WebHook JSON payload', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler({ ...commentFixture, text: 'say "hi" here' }, makeExtra({ options: options({ commentWebhook: '1' }) }));
      const webhookBody = fetchMock.mock.calls.find(([u]) => u === WEBHOOK_URL)![1].body;
      expect(JSON.parse(webhookBody)).toEqual({ author: '访客', content: 'say "hi" here' });
    });

    it('skips the WebHook push when the comment author is an administrator', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      const db = mockDb({
        query: {
          ...mockDb().query,
          users: {
            ...mockDb().query.users,
            findFirst: vi.fn().mockResolvedValue({ uid: 1, group: 'administrator' }),
          },
        },
      });
      await handler({ ...commentFixture, authorId: 1 }, makeExtra({
        options: options({ commentEmail: '1', commentWebhook: '1' }),
        db,
      }));
      // Email excludes the acting admin and the WebHook push is skipped.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('excludes the acting admin from email recipients but keeps other admins', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      const db = mockDb({
        query: {
          ...mockDb().query,
          users: {
            ...mockDb().query.users,
            findMany: vi.fn().mockResolvedValue([
              { uid: 1, mail: 'admin@example.com' },
              { uid: 2, mail: 'second@example.com' },
            ]),
            findFirst: vi.fn().mockResolvedValue({ uid: 1, group: 'administrator' }),
          },
        },
      });
      await handler({ ...commentFixture, authorId: 1 }, makeExtra({ options: options({ commentEmail: '1' }), db }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bodyOf(fetchMock, 'https://api.resend.com/emails').to[0]).toBe('second@example.com');
    });
  });

  describe('validateAndNormalizeSettings', () => {
    it('accepts an empty config (all toggles off)', () => {
      const result = validateAndNormalizeSettings({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.settings.enabled).toBeUndefined();
        expect(result.settings.systemEmail).toBe('0');
      }
    });

    it('accepts a complete configuration', () => {
      const result = validateAndNormalizeSettings({
        systemEmail: '1', commentEmail: '1', replyEmail: '1', commentWebhook: '1',
        emailApiKey: KEY, emailFrom: 'blog@example.com',
        webhookUrl: WEBHOOK_URL, systemWebhook: '1',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.settings.enabled).toBeUndefined();
        expect(result.settings.commentWebhook).toBe('1');
      }
    });

    it('rejects toggles whose channel credentials are incomplete', () => {
      const noKey = validateAndNormalizeSettings({ systemEmail: '1', emailApiKey: '', emailFrom: 'a@b.co' });
      expect(noKey.success).toBe(false);
      if (!noKey.success) expect(noKey.error).toContain('API Key');

      const badFrom = validateAndNormalizeSettings({ replyEmail: '1', emailApiKey: KEY, emailFrom: 'nope' });
      expect(badFrom.success).toBe(false);
      if (!badFrom.success) expect(badFrom.error).toContain('发件邮箱');

      const badWebhook = validateAndNormalizeSettings({ systemWebhook: '1', webhookUrl: 'ftp://x' });
      expect(badWebhook.success).toBe(false);
      if (!badWebhook.success) expect(badWebhook.error).toContain('WebHook');
    });

    it('rejects invalid WebHook JSON templates', () => {
      const result = validateAndNormalizeSettings({
        systemWebhook: '1', webhookUrl: WEBHOOK_URL,
        systemWebhookPayload: '{"event": "x",}',
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('JSON');
    });
  });

  describe('route:request test-send API', () => {
    function routeHandler() {
      return collectHooks().get('route:request')!;
    }

    it('rejects unauthenticated requests', async () => {
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: new Request('https://example.com/api/admin/plugin-notifier/test', { method: 'POST' }),
        path: '/api/admin/plugin-notifier/test',
        db: {},
        options: {},
      } as any);
      expect(result.handled).toBe(true);
      expect(result.response.status).toBe(401);
    });

    it('rejects non-administrator users', async () => {
      const auth = await adminSession('subscriber');
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { to: 't@example.com' }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);
      expect(result.handled).toBe(true);
      expect(result.response.status).toBe(403);
    });

    it('rejects non-POST methods', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: new Request('https://example.com/api/admin/plugin-notifier/test', { method: 'GET', headers: { cookie: auth.cookie } }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);
      expect(result.handled).toBe(true);
      expect(result.response.status).toBe(405);
    });

    it('rejects requests without a valid CSRF token', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: new Request('https://example.com/api/admin/plugin-notifier/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: auth.cookie },
          body: JSON.stringify({ to: 't@example.com' }),
        }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);
      expect(result.handled).toBe(true);
      expect(result.response.status).toBe(403);
    });

    it('rejects a missing or invalid email recipient', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const noTo = await handler({ handled: false }, {
        request: await postTestRequest(auth, { channel: 'email' }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);
      expect(await noTo.response.json()).toMatchObject({ success: false });
      const badTo = await handler({ handled: false }, {
        request: await postTestRequest(auth, { channel: 'email', to: 'nope' }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);
      expect(await badTo.response.json()).toMatchObject({ success: false });
    });

    it('rejects email tests when the email channel is not configured', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { channel: 'email', to: 't@example.com' }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth, { emailApiKey: '' }),
      } as any);
      const body = await result.response.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('邮件渠道不可用');
    });

    it('sends a test email with the stored config and templates', async () => {
      const fetchMock = stubFetch();
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { channel: 'email', to: 't@example.com' }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);
      expect(result.response.status).toBe(200);
      const body = await result.response.json();
      expect(body.success).toBe(true);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.to[0]).toBe('t@example.com');
      expect(sent.from).toBe('"博客" <blog@example.com>');
      expect(sent.subject).toBe('[测试博客] 新消息：测试访客');
    });

    it('sends a test WebHook request with the stored payload template', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ code: 200, ok: true })));
      const fetchMock = vi.mocked(fetch);
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { channel: 'webhook' }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);
      const body = await result.response.json();
      expect(body.success).toBe(true);
      const urls = fetchMock.mock.calls.map(([u]) => u);
      expect(urls).toEqual([WEBHOOK_URL]);
      expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({
        author: '测试访客',
        content: '这是一条来自「测试博客」的测试通知，收到即说明配置正常。',
      });
    });

    it('rejects tests when the channel is not configured', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const whResult = await handler({ handled: false }, {
        request: await postTestRequest(auth, { channel: 'webhook' }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth, { webhookUrl: '' }),
      } as any);
      expect((await whResult.response.json()).message).toContain('WebHook');
    });

    it('rejects unknown channels', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { channel: 'carrier-pigeon' }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);
      expect((await result.response.json()).message).toContain('未知');
    });

    it('reports provider failures with the error message', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, { message: 'API key invalid' })));
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { channel: 'email', to: 't@example.com' }),
        path: '/api/admin/plugin-notifier/test',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);
      const body = await result.response.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('API key invalid');
    });
  });

  describe('route:request config-save API', () => {
    function routeHandler() {
      return collectHooks().get('route:request')!;
    }

    async function postConfigRequest(auth: Awaited<ReturnType<typeof adminSession>>, body: unknown, origin = 'https://example.com') {
      return new Request('https://example.com/api/admin/plugin-notifier/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': auth.csrf,
          cookie: auth.cookie,
          Origin: origin,
        },
        body: JSON.stringify(body),
      });
    }

    it('saves settings and restores secret placeholders', async () => {
      const setOptionMod = await import('@/lib/options');
      const spy = vi.spyOn(setOptionMod, 'setOption').mockResolvedValue(undefined as any);

      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postConfigRequest(auth, {
          settings: {
            systemEmail: '1',
            emailApiKey: SECRET_PLACEHOLDER,
            emailFrom: 'blog@example.com',
            emailProvider: 'resend',
          },
        }),
        path: '/api/admin/plugin-notifier/config',
        db: auth.authDb,
        options: adminOptions(auth),
      } as any);

      expect(result.handled).toBe(true);
      expect(result.response.status).toBe(200);
      const body = await result.response.json();
      expect(body.success).toBe(true);
      expect(body.settings.systemEmail).toBe('1');
      expect(body.settings.emailApiKey).toBe(SECRET_PLACEHOLDER);
      expect(spy).toHaveBeenCalled();
      const saved = JSON.parse(String(spy.mock.calls[0][2]));
      expect(saved.emailApiKey).toBe(KEY);
      expect(saved.enabled).toBeUndefined();
      spy.mockRestore();
    });

    it('rejects incomplete credentials when a toggle is on', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postConfigRequest(auth, {
          settings: { systemEmail: '1', emailApiKey: '', emailFrom: 'a@b.co' },
        }),
        path: '/api/admin/plugin-notifier/config',
        db: auth.authDb,
        options: adminOptions(auth, { emailApiKey: '' }),
      } as any);
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('API Key');
    });

    it('rejects cross-origin requests', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postConfigRequest(auth, { settings: {} }, 'https://evil.example'),
        path: '/api/admin/plugin-notifier/config',
        db: auth.authDb,
        options: { ...adminOptions(auth), siteUrl: 'https://example.com' },
      } as any);
      expect(result.response.status).toBe(403);
    });
  });

  describe('admin:page settings page', () => {
    it('renders the settings page for the notifier-settings slug', () => {
      const hooks = collectHooks();
      const handler = hooks.get('admin:page')!;
      const html = handler('', { slug: 'notifier-settings', csrfToken: 'csrf-token', options: options({}) });
      expect(html).toContain('notifier-settings-app');
      expect(html).toContain('notifier-settings-form');
      expect(html).toContain('notifier-row');
      expect(html).toContain('notifier-inline');
      expect(html).toContain('name="systemEmail"');
      expect(html).toContain('name="commentWebhook"');
      expect(html).toContain('name="replyEmail"');
      expect(html).toContain('name="mailSubject"');
      expect(html).toContain('name="mailBody"');
      expect(html).toContain('name="systemWebhookPayload"');
      expect(html).toContain('name="commentWebhookPayload"');
      expect(html).toContain('模板占位符');
      expect(html).toContain('获取 API Key');
      expect(html).toContain('nf-emailProvider-link');
      expect(html).toContain('https://resend.com');
      expect(html).toContain('https://useplunk.com');
      expect(html).toContain('{reply.author}');
      expect(html).toContain('{subject}');
      expect(html).toContain('{reason}');
      expect(html).toContain('站点信息');
      expect(html).toContain('文章信息');
      expect(html).toContain('新回复信息');
      expect(html).toContain('原评论信息');
      expect(html).toContain('评论通知');
      expect(html).toContain('系统通知');
      expect(html).not.toContain('通知方式');
      expect(html).not.toContain('name="replySubject"');
      expect(html).not.toContain('name="systemBarkPayload"');
      expect(html).not.toContain('name="telegramBotToken"');
      expect(html).not.toContain('data-tab="bark"');
      expect(html).not.toContain('data-tab="telegram"');
      expect(html).toContain('data-tab="email"');
      expect(html).toContain('data-tab="webhook"');
      expect(html).toContain('notifier-test-to');
      expect(html).toContain('data-channel="email"');
      expect(html).toContain('/api/admin/plugin-notifier/config');
      expect(html).toContain('csrf-token');
      expect(html).toContain('保存设置');
      expect(html).not.toContain('/admin/plugin-config?id=typecho-plugin-notifier');
    });

    it('also renders for the legacy notifier-test slug', () => {
      const hooks = collectHooks();
      const handler = hooks.get('admin:page')!;
      const html = handler('', { slug: 'notifier-test', csrfToken: 'csrf-token', options: options({}) });
      expect(html).toContain('notifier-settings-app');
    });

    it('leaves other plugin pages untouched', () => {
      const hooks = collectHooks();
      const handler = hooks.get('admin:page')!;
      expect(handler('', { slug: 'unrelated-plugin', csrfToken: 'x' })).toBe('');
    });
  });

  describe('admin:footer nav entry', () => {
    it('injects the nav entry for administrators', () => {
      const hooks = collectHooks();
      const handler = hooks.get('admin:footer')!;
      const html = handler('', { user: { group: 'administrator' } });
      expect(html).toContain('/admin/plugin/notifier-settings');
      expect(html).toContain('通知设置');
    });

    it('does not inject for other roles', () => {
      const hooks = collectHooks();
      const handler = hooks.get('admin:footer')!;
      expect(handler('', { user: { group: 'subscriber' } })).toBe('');
      expect(handler('', {})).toBe('');
    });
  });
});
