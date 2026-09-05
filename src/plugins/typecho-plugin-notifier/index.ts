/**
 * Typecho-Workers Notifier 插件
 *
 * - `mail:send`                系统通知适配器：核心邮件事件（密码重置等）按「系统通知」开关分发到邮件/WebHook
 * - `feedback:finishComment`   新评论通知管理员（approved + waiting，含回复）+ 回复通知被回复者（仅 approved，仅邮件）
 * - `route:request`            设置保存 API + 测试发送 API
 * - `admin:page`               统一设置页（/admin/plugin/notifier-settings）
 * - `admin:footer`             后台导航菜单注入入口
 */
import { buildPermalink, hasPermission, registerPluginAdminPath, setOption } from 'typecho/plugin-sdk';
import type { PluginInitContext, PluginRouteResult } from 'typecho/plugin-sdk';
import { schema } from 'typecho/db';
import { eq } from 'drizzle-orm';
import { getAuthCookies, validateAuthToken, requireAdminCSRF } from '@/lib/auth';
import { isSameOriginRequest } from '@/lib/admin-auth';
import { buildGravatarUrl } from '@/lib/gravatar';

import {
  PLUGIN_ID, loadConfig, isValidEmail,
  isEmailReady, isWebhookReady, emailInvalidReason,
  restoreSecretFormValues, maskSecretFormValues, toFormValues,
} from './config';
import type { NotifierConfig } from './config';
import { sendEmail, sendWebhook } from './channels';
import type { EmailPayload } from './channels';
import { renderTemplate, escapeVars, jsonEscapeVars, htmlToText, type TemplateVars } from './templates';
import { validateAndNormalizeSettings } from './validate';
import {
  ADMIN_PAGE_SLUG,
  TEST_API_ROUTE,
  CONFIG_API_ROUTE,
  adminPageHtml,
  isNotifierAdminSlug,
} from './admin-page';

interface HookExtra {
  request?: Request;
  options?: Record<string, unknown>;
  db?: any;
  siteUrl?: string;
  permalinkPattern?: string;
  pagePattern?: string;
  path?: string;
}

interface CommentLike {
  coid?: number;
  cid?: number;
  author?: string | null;
  mail?: string | null;
  text?: string | null;
  parent?: number;
  authorId?: number | null;
  status?: string;
}

function logSendFailure(result: { sent: boolean; error?: string }): void {
  if (!result.sent) {
    console.error(`[${PLUGIN_ID}] 通知发送失败: ${result.error || '未知错误'}`);
  }
}

/** Build the base template variables shared by every notification. */
function baseVars(options: Record<string, unknown>): TemplateVars {
  return {
    'site.name': String(options.title || ''),
    'site.url': String(options.siteUrl || ''),
    'site.description': String(options.description || ''),
    'post.title': '',
    'post.url': '',
    'reply.author': '',
    'reply.content': '',
    'reply.mail': '',
    'reply.avatarUrl': '',
    'comment.author': '',
    'comment.content': '',
    'comment.mail': '',
    'comment.avatarUrl': '',
  };
}

/** Build template variables for a system notification (a core mail:send event). */
function systemVars(options: Record<string, unknown>, payload: EmailPayload, reason: string): TemplateVars {
  const text = payload.text ?? htmlToText(payload.html ?? '');
  return {
    ...baseVars(options),
    subject: payload.subject ?? '',
    body: payload.html ?? '',
    text,
    reason,
    to: payload.to ?? '',
  };
}

/** Build the gravatar URL for a comment author (async). */
async function commentAvatarUrl(mail?: string | null): Promise<string> {
  return buildGravatarUrl(mail || '', { defaultImage: 'identicon', size: 40 });
}

/** Query administrator mail addresses (excluding the actor's own uid). */
async function adminRecipients(db: any, excludeUid?: number | null): Promise<{ to: string }[]> {
  const admins = await db.query.users.findMany({
    where: eq(schema.users.group, 'administrator'),
    columns: { uid: true, mail: true },
  });
  const out: { to: string }[] = [];
  for (const admin of admins) {
    if (!admin.mail || !isValidEmail(admin.mail)) continue;
    if (excludeUid != null && admin.uid === excludeUid) continue;
    out.push({ to: admin.mail });
  }
  return out;
}

/** Render subject + html/text body from a template pair. */
function renderEmail(subjectTemplate: string, bodyTemplate: string, vars: TemplateVars): { subject: string; html: string; text: string } {
  const subject = renderTemplate(subjectTemplate, escapeVars(vars));
  const html = renderTemplate(bodyTemplate, escapeVars(vars));
  const text = htmlToText(renderTemplate(bodyTemplate, vars));
  return { subject, html, text };
}

/** Example variables used by the test page (covers every comment placeholder). */
function testVars(options: Record<string, unknown>): TemplateVars {
  const siteUrl = String(options.siteUrl || '');
  return {
    ...baseVars(options),
    'post.title': '测试文章',
    'post.url': siteUrl || 'https://example.com',
    'reply.author': '测试访客',
    'reply.content': '这是一条来自「' + String(options.title || '站点') + '」的测试通知，收到即说明配置正常。',
    'reply.mail': 'guest@example.com',
    'reply.avatarUrl': 'https://www.gravatar.com/avatar/guest',
    'comment.author': '父评论者',
    'comment.content': '这是被回复的评论内容。',
    'comment.mail': 'parent@example.com',
    'comment.avatarUrl': 'https://www.gravatar.com/avatar/parent',
  };
}

function sendTestEmail(config: NotifierConfig, to: string, options: Record<string, unknown>): ReturnType<typeof sendEmail> {
  const mail = renderEmail(config.mailSubject, config.mailBody, testVars(options));
  return sendEmail(config.emailProvider, config.emailApiKey, config.emailFrom, {
    to,
    fromName: config.emailFromName,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
}

function sendTestWebhook(config: NotifierConfig, options: Record<string, unknown>): ReturnType<typeof sendWebhook> {
  return sendWebhook(
    config.webhookUrl,
    config.webhookToken,
    renderTemplate(config.commentWebhookPayload, jsonEscapeVars(testVars(options))),
  );
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  registerPluginAdminPath(TEST_API_ROUTE);
  registerPluginAdminPath(CONFIG_API_ROUTE);

  // ── System notifications: transport adapter + fan-out for core sendMail() ──
  addHook(
    'mail:send',
    pluginId,
    async (result: unknown, extra?: { payload?: EmailPayload; ctx?: { options?: Record<string, unknown>; reason?: string } }) => {
      const payload = extra?.payload;
      const ctxOptions = extra?.ctx?.options;
      if (!payload || !ctxOptions) return result ?? null;
      const config = loadConfig(ctxOptions);

      const reason = String(extra.ctx?.reason || 'system');
      const vars = systemVars(ctxOptions, payload, reason);

      // Fan-out to the WebHook channel without blocking the request.
      if (config.systemWebhook && isWebhookReady(config)) {
        void sendWebhook(
          config.webhookUrl,
          config.webhookToken,
          renderTemplate(config.systemWebhookPayload, jsonEscapeVars(vars)),
        ).then(logSendFailure);
      }

      // Email relay carries the core payload unchanged (fromName only).
      if (config.systemEmail && isEmailReady(config)) {
        return await sendEmail(config.emailProvider, config.emailApiKey, config.emailFrom, {
          ...payload,
          fromName: config.emailFromName,
        });
      }
      return null;
    },
  );

  // ── Comment notifications (admin + reply to parent author) ──
  addHook(
    'feedback:finishComment',
    pluginId,
    async (comment: CommentLike, extra?: HookExtra) => {
      if (!extra?.db || !extra.options) return;
      const config = loadConfig(extra.options);
      if (!comment?.cid || !comment.coid) return;

      const status = String(comment?.status || '');
      const isReply = Boolean(comment?.parent);

      // Admin: approved AND waiting (pending moderation) comments, replies included; spam is skipped.
      const wantAdmin = (status === 'approved' || status === 'waiting')
        && (config.commentEmail || config.commentWebhook);
      // Reply notification to the parent commenter: only when the reply is approved.
      const wantReply = isReply && status === 'approved' && config.replyEmail;

      if (!wantAdmin && !wantReply) return;
      if (!isEmailReady(config) && !isWebhookReady(config)) return;

      const content = await extra.db.query.contents.findFirst({
        where: eq(schema.contents.cid, comment.cid),
        columns: { cid: true, title: true, slug: true, type: true, created: true, authorId: true },
      });
      if (!content) return;

      const postUrl = `${buildPermalink(
        content,
        String(extra.siteUrl || ''),
        extra.permalinkPattern ?? String(extra.options.permalinkPattern ?? ''),
        extra.pagePattern ?? String(extra.options.pagePattern ?? ''),
      )}#comment-${comment.coid}`;

      const replyAuthor = comment.author || '匿名';
      const replyContent = comment.text || '';
      const replyMail = comment.mail || '';

      // The parent comment being replied to (null when this is a top-level comment).
      let parentComment: { author?: string | null; mail?: string | null; text?: string | null } | null = null;
      if (comment.parent) {
        parentComment = await extra.db.query.comments.findFirst({
          where: eq(schema.comments.coid, comment.parent),
          columns: { mail: true, author: true, text: true },
        });
      }

      const vars: TemplateVars = {
        ...baseVars(extra.options),
        'post.title': content.title || '',
        'post.url': postUrl,
        'reply.author': replyAuthor,
        'reply.content': replyContent,
        'reply.mail': replyMail,
        'reply.avatarUrl': await commentAvatarUrl(replyMail),
        'comment.author': parentComment?.author || '',
        'comment.content': parentComment?.text || '',
        'comment.mail': parentComment?.mail || '',
        'comment.avatarUrl': await commentAvatarUrl(parentComment?.mail),
      };

      // Admin authored the comment → skip the WebHook push (the admin already knows).
      let authorIsAdmin = false;
      if (comment.authorId != null) {
        const author = await extra.db.query.users.findFirst({
          where: eq(schema.users.uid, comment.authorId),
          columns: { group: true },
        });
        authorIsAdmin = Boolean(author && author.group === 'administrator');
      }

      // Collect email recipients from admin + reply paths, then send once per mailbox.
      // Both paths reuse the same 「新消息」 template, so overlapping addresses would look like duplicates.
      const emailTos: string[] = [];
      if (wantAdmin && config.commentEmail && isEmailReady(config)) {
        for (const recipient of await adminRecipients(extra.db, comment.authorId)) {
          emailTos.push(recipient.to);
        }
      }
      if (
        wantReply
        && isEmailReady(config)
        && parentComment?.mail
        && isValidEmail(parentComment.mail)
        && parentComment.mail.toLowerCase() !== String(comment.mail || '').toLowerCase()
      ) {
        emailTos.push(parentComment.mail);
      }

      if (emailTos.length > 0) {
        const mail = renderEmail(config.mailSubject, config.mailBody, vars);
        const seen = new Set<string>();
        for (const to of emailTos) {
          const key = to.trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const result = await sendEmail(config.emailProvider, config.emailApiKey, config.emailFrom, {
            to,
            fromName: config.emailFromName,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          });
          logSendFailure(result);
        }
      }

      if (wantAdmin && !authorIsAdmin) {
        if (config.commentWebhook && isWebhookReady(config)) {
          const result = await sendWebhook(
            config.webhookUrl,
            config.webhookToken,
            renderTemplate(config.commentWebhookPayload, jsonEscapeVars(vars)),
          );
          logSendFailure(result);
        }
      }
    },
  );

  // ── Test-send + config-save APIs ──
  addHook(
    'route:request',
    pluginId,
    async (result: PluginRouteResult, extra?: HookExtra) => {
      if (result?.handled || !extra?.request) return result;

      if (extra.path === CONFIG_API_ROUTE) {
        return handleConfigSave(extra);
      }

      if (extra.path !== TEST_API_ROUTE) return result;

      const db = extra.db;
      const options = extra.options || {};
      if (!db) {
        return { handled: true, response: new Response(JSON.stringify({ success: false, message: '数据库不可用' }), { status: 503, headers: { 'Content-Type': 'application/json' } }) };
      }

      const auth = await authenticateAdmin(extra.request, db, options);
      if (auth instanceof Response) {
        return { handled: true, response: jsonErrorResponse(auth.status) };
      }

      if (extra.request.method !== 'POST') {
        return { handled: true, response: new Response(JSON.stringify({ success: false, message: 'Method Not Allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } }) };
      }

      const csrfError = await requireAdminCSRF(
        extra.request,
        String(options.secret || ''),
        String(auth.authCode || ''),
        auth.uid,
      );
      if (csrfError) {
        return { handled: true, response: jsonErrorResponse(403) };
      }

      try {
        const body = await extra.request.json() as { channel?: unknown; to?: unknown };
        const channel = String(body.channel || 'email');
        const config = loadConfig(options);

        if (channel === 'email') {
          const to = String(body.to || '').trim();
          if (!to) {
            return { handled: true, response: jsonOk('请填写测试收件邮箱', false) };
          }
          if (!isValidEmail(to)) {
            return { handled: true, response: jsonOk('测试收件邮箱格式不正确', false) };
          }
          const invalid = emailInvalidReason(config);
          if (invalid) {
            return { handled: true, response: jsonOk(`邮件渠道不可用：${invalid}`, false) };
          }
          const resultSend = await sendTestEmail(config, to, options);
          if (resultSend.sent) {
            return { handled: true, response: jsonOk('测试邮件已发送，请检查收件箱', true) };
          }
          return { handled: true, response: jsonOk(`发送失败：${resultSend.error || '未知错误'}`, false) };
        }

        if (channel === 'webhook') {
          if (!isWebhookReady(config)) {
            return { handled: true, response: jsonOk('WebHook 渠道不可用：请先填写地址并保存设置', false) };
          }
          const resultSend = await sendTestWebhook(config, options);
          if (resultSend.sent) {
            return { handled: true, response: jsonOk('测试请求已发送', true) };
          }
          return { handled: true, response: jsonOk(`发送失败：${resultSend.error || '未知错误'}`, false) };
        }

        return { handled: true, response: jsonOk('未知的通知渠道', false) };
      } catch (error) {
        console.error(`[${PLUGIN_ID}] 测试通知失败:`, error);
        return { handled: true, response: jsonOk('请求解析失败', false) };
      }
    },
    20,
  );

  // ── Plugin admin page (settings + channel test) ──
  addHook(
    'admin:page',
    pluginId,
    (html: string, extra?: { slug?: string; csrfToken?: string; options?: Record<string, unknown> }) => {
      if (!isNotifierAdminSlug(extra?.slug)) return html;
      const config = loadConfig(extra?.options);
      return adminPageHtml(extra?.csrfToken || '', config, String(extra?.options?.title || ''));
    },
  );

  // ── Nav menu entry ──
  addHook(
    'admin:footer',
    pluginId,
    (html: string, extra?: { activeMenu?: string; user?: { group?: string } }) => {
      const isAdmin = extra?.user?.group && hasPermission(extra.user.group, 'administrator');
      if (!isAdmin) return html;

      const isActive = isNotifierAdminSlug(extra?.activeMenu);
      const extraHtml = `<script>
(function(){
  var navs = document.querySelectorAll('.typecho-head-nav nav > menu > li');
  var settings = null;
  for (var i = 0; i < navs.length; i++) {
    var a = navs[i].querySelector(':scope > a');
    if (a && a.textContent.trim() === '设置') { settings = navs[i]; break; }
  }
  var sub = settings && settings.querySelector(':scope > menu');
  if (sub) {
    var li = document.createElement('li');
    li.className = '${isActive ? 'focus' : ''}';
    li.innerHTML = '<a href="/admin/plugin/${ADMIN_PAGE_SLUG}">通知设置</a>';
    sub.appendChild(li);
  }
})();
</script>`;
      return html + extraHtml;
    },
  );

}

async function handleConfigSave(extra: HookExtra): Promise<PluginRouteResult> {
  const request = extra.request!;
  const db = extra.db;
  const options = extra.options || {};
  if (!db) {
    return {
      handled: true,
      response: new Response(JSON.stringify({ success: false, message: '数据库不可用' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  const auth = await authenticateAdmin(request, db, options);
  if (auth instanceof Response) {
    return { handled: true, response: jsonErrorResponse(auth.status) };
  }

  if (request.method !== 'POST') {
    return {
      handled: true,
      response: new Response(JSON.stringify({ success: false, message: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  const csrfError = await requireAdminCSRF(
    request,
    String(options.secret || ''),
    String(auth.authCode || ''),
    auth.uid,
  );
  if (csrfError) {
    return { handled: true, response: jsonErrorResponse(403) };
  }

  if (!isSameOriginRequest(request, String(options.siteUrl || ''))) {
    return { handled: true, response: jsonErrorResponse(403) };
  }

  try {
    const body = await request.json() as { settings?: Record<string, unknown> };
    if (!body.settings || typeof body.settings !== 'object') {
      return { handled: true, response: jsonOk('请提供配置数据', false) };
    }

    const previous = toFormValues(loadConfig(options));
    const restored = restoreSecretFormValues(body.settings, previous);
    const validation = validateAndNormalizeSettings(restored);
    if (!validation.success) {
      return {
        handled: true,
        response: new Response(JSON.stringify({ success: false, message: validation.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
      };
    }

    await setOption(db, `plugin:${PLUGIN_ID}`, JSON.stringify(validation.settings));
    return {
      handled: true,
      response: new Response(JSON.stringify({
        success: true,
        message: '设置已保存',
        settings: maskSecretFormValues(validation.settings),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    };
  } catch (error) {
    console.error(`[${PLUGIN_ID}] 保存设置失败:`, error);
    return { handled: true, response: jsonOk('请求解析失败', false) };
  }
}

// ── Admin auth helpers for custom plugin routes ──

interface AdminAuthResult {
  uid: number;
  authCode: string;
}

async function authenticateAdmin(request: Request, db: any, options: Record<string, unknown>): Promise<AdminAuthResult | Response> {
  const { token } = getAuthCookies(request.headers.get('cookie'));
  if (!token || !options.secret) {
    return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const auth = await validateAuthToken(token, String(options.secret), db);
  if (!auth) {
    return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (!hasPermission(auth.user.group || 'visitor', 'administrator')) {
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  return {
    uid: auth.uid,
    authCode: String(auth.user.authCode || ''),
  };
}

function jsonOk(message: string, success: boolean): Response {
  return new Response(JSON.stringify({ success, message }), {
    status: success ? 200 : 400,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function jsonErrorResponse(status: number): Response {
  const message = status === 403 ? 'Forbidden' : 'Unauthorized';
  return new Response(JSON.stringify({ success: false, message }), { status, headers: { 'Content-Type': 'application/json' } });
}