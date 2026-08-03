import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAuthToken, generateSecurityToken } from '@/lib/auth';
import init from './index';
import { renderTemplate, escapeVars, htmlToText } from './templates';
import { normalizeConfig, loadConfig, isValidEmail } from './config';

// ── Test helpers ────────────────────────────────────────────────────────────

function collectHooks(): Map<string, Function> {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-mailer',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
  });
  return hooks;
}

function options(settings: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    'plugin:typecho-plugin-mailer': JSON.stringify({
      enabled: '1',
      provider: 'resend',
      apiKey: 're_test_key',
      from: 'blog@example.com',
      subject: '[{site.name}] 新的通知',
      body: '<p>{site.name}</p><p>{post.title} {reply.author}: {reply.content}</p><a href="{post.url}">查看</a>',
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

const commentFixture = {
  coid: 7, cid: 10, author: '访客', mail: 'guest@example.com', text: '不错的文章',
  parent: 0, authorId: null, status: 'approved',
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('typecho-plugin-mailer', () => {
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
        'plugin:config:beforeSave',
        'route:request',
      ]);
    });
  });

  describe('template rendering', () => {
    it('replaces known placeholders and drops unknown ones', () => {
      expect(renderTemplate('{site.name} - {post.title} {missing}', { 'site.name': '博客', 'post.title': '文章' }))
        .toBe('博客 - 文章 ');
    });

    it('supports dotted placeholders like reply.* and comment.*', () => {
      const html = renderTemplate(
        '{reply.author} 回复了 {comment.author}：{reply.content}（回复 {comment.content}）',
        { 'reply.author': '小王', 'reply.content': '很好', 'comment.author': '老李', 'comment.content': '不错' },
      );
      expect(html).toBe('小王 回复了 老李：很好（回复 不错）');
    });

    it('escapes user content for HTML emails but not for text versions', () => {
      const vars = { 'reply.content': '<script>alert(1)</script>' };
      expect(renderTemplate('{reply.content}', escapeVars(vars))).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(renderTemplate('{reply.content}', vars)).toBe('<script>alert(1)</script>');
    });

    it('derives plain text from HTML bodies', () => {
      expect(htmlToText('<p>Hello</p><p>World</p>')).toBe('Hello\nWorld');
    });
  });

  describe('config loading', () => {
    it('merges stored settings with defaults', () => {
      const cfg = loadConfig(options({ provider: 'brevo' }));
      expect(cfg.provider).toBe('brevo');
      expect(cfg.enabled).toBe(true);
      expect(cfg.replyNotifyEnabled).toBe(true);
      expect(cfg.commentNotifyEnabled).toBe(false);
    });

    it('falls back to defaults on invalid JSON and invalid provider', () => {
      const cfg = loadConfig({ 'plugin:typecho-plugin-mailer': 'not json' });
      expect(cfg.provider).toBe('resend');
      expect(cfg.enabled).toBe(false);
      expect(normalizeConfig({ provider: 'smtp' }).provider).toBe('resend');
    });

    it('validates email addresses', () => {
      expect(isValidEmail('a@b.co')).toBe(true);
      expect(isValidEmail('not-an-email')).toBe(false);
    });
  });

  describe('mail:send transport adapter', () => {
    it('returns null when disabled or not configured', async () => {
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      const cfg = options({ enabled: '0' });
      const result = await handler(null, { payload: { to: 'x@y.com', subject: 's', html: '<p>h</p>' }, ctx: { options: cfg } });
      expect(result).toBeNull();

      const noKey = await handler(null, { payload: { to: 'x@y.com', subject: 's', html: '<p>h</p>' }, ctx: { options: options({ apiKey: '' }) } });
      expect(noKey).toBeNull();
    });

    it('returns null when payload or ctx missing', async () => {
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      expect(await handler(null, {})).toBeNull();
      expect(await handler(null, { payload: {} })).toBeNull();
    });

    it('sends via Resend and returns sent:true', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      const result = await handler(null, {
        payload: { to: 'user@example.com', subject: '重置密码', html: '<p>hi</p>', text: 'hi' },
        ctx: { options: options({}), reason: 'password-reset' },
      });
      expect(result.sent).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.resend.com/emails',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Authorization': 'Bearer re_test_key' }),
        }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.from).toBe('blog@example.com');
      expect(body.to).toEqual(['user@example.com']);
      expect(body.subject).toBe('重置密码');
    });

    it('propagates provider errors without throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, { message: 'API key invalid' })));
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      const result = await handler(null, {
        payload: { to: 'user@example.com', subject: 's', html: '<p>h</p>' },
        ctx: { options: options({}), reason: 'password-reset' },
      });
      expect(result.sent).toBe(false);
      expect(result.error).toContain('401');
      expect(result.error).toContain('API key invalid');
    });

    it('uses the configured sender name in the Resend from address', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      await handler(null, {
        payload: { to: 'user@example.com', subject: 's', html: '<p>h</p>' },
        ctx: { options: options({ fromName: '我的博客' }) },
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.from).toBe('"我的博客" <blog@example.com>');
    });
  });

  describe('feedback:finishComment notifications', () => {
    it('skips when plugin disabled', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(commentFixture, makeExtra({ options: options({ enabled: '0' }) }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('skips comments that are not approved', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler({ ...commentFixture, status: 'waiting' }, makeExtra({}));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('skips when both admin and reply notifications are off', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(commentFixture, makeExtra({ options: options({ commentNotifyEnabled: '0', replyNotifyEnabled: '0' }) }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('notifies every administrator when a new comment arrives', async () => {
      const fetchMock = stubFetch();
      const db = mockDb({
        query: {
          users: { findMany: vi.fn().mockResolvedValue([{ uid: 1, mail: 'admin@example.com' }, { uid: 2, mail: 'admin2@example.com' }, { uid: 3, mail: '' }]) },
          contents: { findFirst: vi.fn().mockResolvedValue({ cid: 10, title: '测试文章', slug: 'test-post', type: 'post', created: 1700000000, authorId: 1 }) },
          comments: { findFirst: vi.fn() },
        },
      });
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(commentFixture, makeExtra({ db, options: options({ commentNotifyEnabled: '1' }) }));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const bodies = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body));
      expect(bodies.map((b: any) => b.to[0])).toEqual(expect.arrayContaining(['admin@example.com', 'admin2@example.com']));
    });

    it('skips the administrator who authored the comment', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler({ ...commentFixture, authorId: 1 }, makeExtra({ options: options({ commentNotifyEnabled: '1' }) }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('notifies the parent comment author on replies', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler({ ...commentFixture, parent: 5, authorId: 1 }, makeExtra({ options: options({ replyNotifyEnabled: '1' }) }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to[0]).toBe('parent@example.com');
    });

    it('does not reply-notify the commenter themselves', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler({ ...commentFixture, parent: 5, mail: 'parent@example.com' }, makeExtra({ options: options({ replyNotifyEnabled: '1' }) }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('renders the template with comment placeholders', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(commentFixture, makeExtra({ options: options({ commentNotifyEnabled: '1' }) }));
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.subject).toBe('[测试博客] 新的通知');
      expect(body.html).toContain('<p>测试博客</p>');
      expect(body.html).toContain('访客');
      expect(body.html).toContain('不错的文章');
      expect(body.html).toContain('href="https://example.com/archives/10/#comment-7"');
    });

    it('fills reply.* and comment.* placeholders for replies', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      const extra = makeExtra({
        options: options({
          replyNotifyEnabled: '1',
          body: '<p>{reply.author} 回复了 {comment.author}：{reply.content}（原文：{comment.content}）</p><p>{reply.avatarUrl} | {comment.avatarUrl} | {site.description}</p>',
        }, { description: '站点描述' }),
      });
      await handler({ ...commentFixture, parent: 5, authorId: 1 }, extra);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).toContain('访客 回复了 父评论者：不错的文章（原文：父评论内容）');
      expect(body.html).toContain('https://www.gravatar.com/avatar/');
      expect(body.html).toContain('| 站点描述</p>');
    });

    it('leaves comment.* placeholders empty for top-level comments', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler(commentFixture, makeExtra({
        options: options({
          commentNotifyEnabled: '1',
          body: '<p>新评论：{reply.author}；被回复评论：{comment.author}</p>',
        }),
      }));
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).toContain('新评论：访客；被回复评论：');
    });

    it('escapes user content inside the HTML email', async () => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('feedback:finishComment')!;
      await handler({ ...commentFixture, text: '<script>bad()</script>' }, makeExtra({ options: options({ commentNotifyEnabled: '1' }) }));
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
      expect(body.html).not.toContain('<script>bad()</script>');
    });
  });

  describe('provider adapters', () => {
    const payload = { to: 'user@example.com', subject: 'S', html: '<p>H</p>', fromName: '博客' };

    it.each([
      ['mailersend', 'https://api.mailersend.com/v1/email', 'mlsn_key', { Authorization: 'Bearer mlsn_key' }, (b: any) => ({ from: b.from.email, fromName: b.from.name, to: b.to[0].email, subject: b.subject, html: b.html })],
      ['brevo', 'https://api.brevo.com/v3/smtp/email', 'brevo_key', { 'api-key': 'brevo_key' }, (b: any) => ({ from: b.sender.email, fromName: b.sender.name, to: b.to[0].email, subject: b.subject, html: b.htmlContent })],
      ['plunk', 'https://api.useplunk.com/v1/email/send', 'plk_key', { Authorization: 'Bearer plk_key' }, (b: any) => ({ from: b.from.email, fromName: b.from.name, to: b.to, subject: b.subject, html: b.body })],
      ['maileroo', 'https://smtp.maileroo.com/api/v2/emails', 'mr_key', { 'X-Api-Key': 'mr_key' }, (b: any) => ({ from: b.from.address, fromName: b.from.display_name, to: b.to[0].address, subject: b.subject, html: b.html })],
    ] as const)('builds a valid %s request', async (provider, url, apiKey, headers, extract) => {
      const fetchMock = stubFetch();
      const hooks = collectHooks();
      const handler = hooks.get('mail:send')!;
      const result = await handler(null, {
        payload,
        ctx: { options: options({ provider, apiKey, fromName: '博客' }) },
      });
      expect(result.sent).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST', headers: expect.objectContaining(headers) }));
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(extract(body)).toEqual({ from: 'blog@example.com', fromName: '博客', to: 'user@example.com', subject: 'S', html: '<p>H</p>' });
    });
  });

  describe('plugin:config:beforeSave', () => {
    it('accepts a valid configuration', () => {
      const hooks = collectHooks();
      const handler = hooks.get('plugin:config:beforeSave')!;
      const result = handler({ success: true, settings: {} }, {
        pluginId: 'typecho-plugin-mailer',
        settings: { enabled: '1', apiKey: 'k', from: 'blog@example.com', provider: 'resend', testTo: 't@example.com' },
        options: options({}),
      });
      expect(result.success).toBe(true);
      expect(result.settings.enabled).toBe('1');
    });

    it('rejects enabling without an API key', () => {
      const hooks = collectHooks();
      const handler = hooks.get('plugin:config:beforeSave')!;
      const result = handler({ success: true, settings: {} }, {
        pluginId: 'typecho-plugin-mailer',
        settings: { enabled: '1', apiKey: '', from: 'blog@example.com' },
        options: options({}),
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('API Key');
    });

    it('rejects an invalid sender address', () => {
      const hooks = collectHooks();
      const handler = hooks.get('plugin:config:beforeSave')!;
      const result = handler({ success: true, settings: {} }, {
        pluginId: 'typecho-plugin-mailer',
        settings: { enabled: '1', apiKey: 'k', from: 'not-an-email' },
        options: options({}),
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('发件邮箱');
    });

    it('restores the secret placeholder from stored config', () => {
      const hooks = collectHooks();
      const handler = hooks.get('plugin:config:beforeSave')!;
      const result = handler({ success: true, settings: {} }, {
        pluginId: 'typecho-plugin-mailer',
        settings: { enabled: '1', apiKey: '__PLUGIN_CONFIG_SECRET__', from: 'blog@example.com' },
        options: options({ apiKey: 'stored-key' }),
      });
      expect(result.success).toBe(true);
      expect(result.settings.apiKey).toBe('stored-key');
    });

    it('ignores other plugins', () => {
      const hooks = collectHooks();
      const handler = hooks.get('plugin:config:beforeSave')!;
      const input = { success: false, error: 'other plugin says no' };
      const result = handler(input, { pluginId: 'typecho-plugin-other', settings: {} });
      expect(result).toBe(input);
    });
  });

  describe('route:request test-send API', () => {
    function routeHandler() {
      const hooks = collectHooks();
      return hooks.get('route:request')!;
    }

    function adminOptions(auth: Awaited<ReturnType<typeof adminSession>>, settings: Record<string, unknown> = {}) {
      return {
        secret: auth.secret,
        'plugin:typecho-plugin-mailer': JSON.stringify({
          enabled: '1',
          provider: 'resend',
          apiKey: 're_test_key',
          from: 'blog@example.com',
          subject: '[{site.name}] 新的通知',
          body: '<p>{site.name}</p><p>{reply.content}</p>',
          ...settings,
        }),
        title: '测试博客',
        siteUrl: 'https://example.com',
      };
    }

    async function postTestRequest(auth: Awaited<ReturnType<typeof adminSession>>, body: unknown, overrides: Record<string, unknown> = {}) {
      return new Request('https://example.com/api/admin/plugin-mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf, cookie: auth.cookie },
        body: JSON.stringify(body),
        ...overrides,
      });
    }

    it('ignores paths that are not the test route', async () => {
      const handler = routeHandler();
      const result = await handler({ handled: false }, { request: new Request('https://example.com/'), path: '/' });
      expect(result).toEqual({ handled: false });
    });

    it('rejects unauthenticated requests', async () => {
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: new Request('https://example.com/api/admin/plugin-mail/test', { method: 'POST' }),
        path: '/api/admin/plugin-mail/test',
        db: {},
        options: {},
      });
      expect(result.handled).toBe(true);
      expect(result.response.status).toBe(401);
    });

    it('rejects non-administrator users', async () => {
      const auth = await adminSession('subscriber');
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { to: 't@example.com' }),
        path: '/api/admin/plugin-mail/test',
        db: auth.authDb,
        options: adminOptions(auth),
      });
      expect(result.handled).toBe(true);
      expect(result.response.status).toBe(403);
    });

    it('rejects non-POST methods', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: new Request('https://example.com/api/admin/plugin-mail/test', { method: 'GET', headers: { cookie: auth.cookie } }),
        path: '/api/admin/plugin-mail/test',
        db: auth.authDb,
        options: adminOptions(auth),
      });
      expect(result.handled).toBe(true);
      expect(result.response.status).toBe(405);
    });

    it('rejects requests without a valid CSRF token', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: new Request('https://example.com/api/admin/plugin-mail/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: auth.cookie },
          body: JSON.stringify({ to: 't@example.com' }),
        }),
        path: '/api/admin/plugin-mail/test',
        db: auth.authDb,
        options: adminOptions(auth),
      });
      expect(result.handled).toBe(true);
      expect(result.response.status).toBe(403);
    });

    it('rejects a missing or invalid recipient', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const noTo = await handler({ handled: false }, {
        request: await postTestRequest(auth, {}),
        path: '/api/admin/plugin-mail/test',
        db: auth.authDb,
        options: adminOptions(auth),
      });
      expect(await noTo.response.json()).toMatchObject({ success: false });
      const badTo = await handler({ handled: false }, {
        request: await postTestRequest(auth, { to: 'nope' }),
        path: '/api/admin/plugin-mail/test',
        db: auth.authDb,
        options: adminOptions(auth),
      });
      expect(await badTo.response.json()).toMatchObject({ success: false });
    });

    it('rejects when the plugin is not configured with an API key', async () => {
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { to: 't@example.com' }),
        path: '/api/admin/plugin-mail/test',
        db: auth.authDb,
        options: adminOptions(auth, { apiKey: '' }),
      });
      const body = await result.response.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('API Key');
    });

    it('sends a test mail with the stored config', async () => {
      const fetchMock = stubFetch();
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { to: 't@example.com' }),
        path: '/api/admin/plugin-mail/test',
        db: auth.authDb,
        options: adminOptions(auth),
      });
      expect(result.response.status).toBe(200);
      const body = await result.response.json();
      expect(body.success).toBe(true);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.to[0]).toBe('t@example.com');
      expect(sent.from).toBe('blog@example.com');
      expect(sent.subject).toBe('[测试博客] 新的通知');
    });

    it('reports provider failures with the error message', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, { message: 'API key invalid' })));
      const auth = await adminSession();
      const handler = routeHandler();
      const result = await handler({ handled: false }, {
        request: await postTestRequest(auth, { to: 't@example.com' }),
        path: '/api/admin/plugin-mail/test',
        db: auth.authDb,
        options: adminOptions(auth),
      });
      const body = await result.response.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('API key invalid');
    });
  });

  describe('admin:page test page', () => {
    it('renders the test page for the mail-test slug', () => {
      const hooks = collectHooks();
      const handler = hooks.get('admin:page')!;
      const html = handler('', { slug: 'mail-test', csrfToken: 'csrf-token', options: options({}) });
      expect(html).toContain('btn-mail-test-send');
      expect(html).toContain('csrf-token');
      expect(html).toContain('blog@example.com');
      expect(html).not.toContain('·');
      expect(html).toContain('/admin/plugin-config?id=typecho-plugin-mailer');
      expect(html).toContain('设置');
    });

    it('leaves other plugin pages untouched', () => {
      const hooks = collectHooks();
      const handler = hooks.get('admin:page')!;
      expect(handler('', { slug: 'webdav', csrfToken: 'x' })).toBe('');
    });
  });

  describe('admin:footer nav entry', () => {
    it('injects the nav entry for administrators', () => {
      const hooks = collectHooks();
      const handler = hooks.get('admin:footer')!;
      const html = handler('', { user: { group: 'administrator' } });
      expect(html).toContain('/admin/plugin/mail-test');
      expect(html).toContain('邮件测试');
    });

    it('does not inject for other roles', () => {
      const hooks = collectHooks();
      const handler = hooks.get('admin:footer')!;
      expect(handler('', { user: { group: 'subscriber' } })).toBe('');
      expect(handler('', {})).toBe('');
    });
  });
});
