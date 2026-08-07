/**
 * Typecho-Workers Mailer 插件
 *
 * - `mail:send`                邮件传输适配器：为核心 sendMail()（密码重置等）提供 5 种 HTTP API 渠道
 * - `feedback:finishComment`   新评论通知管理员 + 回复通知评论者
 * - `route:request`            插件自带的「发送测试邮件」API（/api/admin/plugin-mail/test）
 * - `admin:page`               插件专属测试页面（/admin/plugin/mail-test）
 * - `admin:footer`             后台导航菜单注入入口
 * - `plugin:config:beforeSave` 配置校验与规范化
 */
import { buildPermalink, escapeHtml, hasPermission, registerPluginAdminPath } from 'typecho/plugin-sdk';
import type { PluginInitContext, PluginRouteResult } from 'typecho/plugin-sdk';
import { schema } from 'typecho/db';
import { eq } from 'drizzle-orm';
import { getAuthCookies, validateAuthToken, requireAdminCSRF } from '@/lib/auth';
import { buildGravatarUrl } from '@/lib/gravatar';

import { PLUGIN_ID, SECRET_PLACEHOLDER, loadConfig, normalizeConfig, isValidEmail, isReady, toFormValues } from './config';
import type { MailPluginConfig } from './config';
import { sendViaProvider } from './providers';
import type { SendPayload } from './providers';
import { renderTemplate, escapeVars, htmlToText, type TemplateVars } from './templates';

const TEST_API_ROUTE = '/api/admin/plugin-mail/test';
const ADMIN_PAGE_SLUG = 'mail-test';

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
    console.error(`[${PLUGIN_ID}] 邮件发送失败: ${result.error || '未知错误'}`);
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

/** Render subject + html/text body from the config template. */
function renderEmail(config: MailPluginConfig, vars: TemplateVars): { subject: string; html: string; text: string } {
  const subject = renderTemplate(config.subject, escapeVars(vars));
  const html = renderTemplate(config.body, escapeVars(vars));
  const text = htmlToText(renderTemplate(config.body, vars));
  return { subject, html, text };
}

async function sendToAll(config: MailPluginConfig, recipients: { to: string }[], mail: { subject: string; html: string; text: string }): Promise<void> {
  for (const recipient of recipients) {
    const result = await sendViaProvider(config.provider, config.apiKey, config.from, {
      to: recipient.to,
      fromName: config.fromName,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    logSendFailure(result);
  }
}

/** Send one test mail using the currently saved config. */
async function sendTestMail(config: MailPluginConfig, to: string, options: Record<string, unknown>): Promise<{ sent: boolean; error?: string }> {
  const siteName = String(options.title || '');
  const siteUrl = String(options.siteUrl || '');
  const vars: TemplateVars = {
    ...baseVars(options),
    'site.name': siteName,
    'site.url': siteUrl,
    'post.title': '测试邮件',
    'post.url': siteUrl || 'https://example.com',
    'reply.author': '测试',
    'reply.content': '这是一封来自「' + siteName + '」的测试邮件，如果你收到了它，说明邮件配置一切正常。',
    'reply.mail': 'test@example.com',
    'reply.avatarUrl': 'https://www.gravatar.com/avatar/test',
    'comment.author': '评论者',
    'comment.content': '这是被回复的评论内容。',
    'comment.mail': 'parent@example.com',
    'comment.avatarUrl': 'https://www.gravatar.com/avatar/parent',
  };
  const mail = renderEmail(config, vars);
  return sendViaProvider(config.provider, config.apiKey, config.from, {
    to,
    fromName: config.fromName,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
}

function maskKey(apiKey: string): string {
  if (apiKey.length <= 8) return apiKey ? '****' : '';
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

// ── Plugin admin page (send test) ──

function adminPageHtml(csrf: string, config: MailPluginConfig, siteTitle: string): string {
  const status = isReady(config)
    ? '<span style="color:#5A9E5F">已启用</span>'
    : '<span style="color:#C0392B">未启用或配置不完整</span>';
  return `<div class="col-mb-12" id="mail-test-app">
  <div id="mail-test-notice" style="display:none"></div>
  <ul class="typecho-option" id="typecho-option-item-status">
    <li>
      <label class="typecho-label">当前状态</label>
      <p>${status}<span>渠道：${escapeHtml(config.provider)}</span><span>发件邮箱：${escapeHtml(config.from) || '<span style="color:#999">未设置</span>'}</span><span>API Key：${maskKey(config.apiKey) || '<span style="color:#999">未设置</span>'}</span></p>
    </li>
  </ul>
  <ul class="typecho-option" id="typecho-option-item-to">
    <li>
      <label class="typecho-label" for="mail-test-to">测试收件邮箱</label>
      <input type="email" id="mail-test-to" class="text" placeholder="you@example.com" value="">
      <p class="description">测试邮件将发送到该邮箱，发送内容使用「插件设置」中已保存的渠道、API Key 与模板。若未生效请先保存设置。</p>
    </li>
  </ul>
  <ul class="typecho-option typecho-option-submit">
    <li>
      <button type="button" class="btn primary" id="btn-mail-test-send">发送测试邮件</button>
    </li>
  </ul>
</div>
<script>
(function(){
var csrf=${JSON.stringify(csrf)},btn=document.getElementById("btn-mail-test-send"),input=document.getElementById("mail-test-to"),noticeEl=document.getElementById("mail-test-notice");
var timer=null;
function notice(msg,type){clearTimeout(timer);noticeEl.style.display="block";noticeEl.className="message "+(type==="success"?"success":"error");noticeEl.innerHTML="<p>"+E(msg)+"</p>";timer=setTimeout(function(){noticeEl.style.display="none"},6000)}
function E(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
(function(){
var titleBar=document.querySelector(".typecho-page-title");
if(titleBar&&!document.getElementById("mail-test-settings-link")){
  var link=document.createElement("a");
  link.id="mail-test-settings-link";
  link.href="/admin/plugin-config?id=${PLUGIN_ID}";
  link.textContent="设置";
  titleBar.appendChild(link);
}
})();
btn.addEventListener("click",async function(){
  var to=input.value.trim();
  if(!to){notice("请先填写测试收件邮箱","error");return}
  btn.disabled=true;btn.textContent="发送中…";
  try{
    var r=await fetch("/api/admin/plugin-mail/test",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({to:to})});
    var j;
    try{j=await r.json()}catch(e){throw new Error("Server error ("+r.status+")")}
    if(!r.ok||!j.success){throw new Error(j.message||"发送失败（"+r.status+"）")}
    notice(j.message||"测试邮件已发送，请检查收件箱","success");
  }catch(e){
    notice("发送失败："+e.message,"error");
  }finally{
    btn.disabled=false;btn.textContent="发送测试邮件";
  }
});
})();
</script>`;
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  registerPluginAdminPath(TEST_API_ROUTE);

  // ── Transport adapter for core sendMail() (password reset etc.) ──
  addHook(
    'mail:send',
    pluginId,
    async (result: unknown, extra?: { payload?: SendPayload; ctx?: { options?: Record<string, unknown> } }) => {
      const payload = extra?.payload;
      const ctxOptions = extra?.ctx?.options;
      if (!payload || !ctxOptions) return result ?? null;
      const config = loadConfig(ctxOptions);
      if (!isReady(config)) return null;
      return await sendViaProvider(config.provider, config.apiKey, config.from, {
        ...payload,
        fromName: config.fromName,
      });
    },
  );

  // ── New comment notifications (admin + reply to parent author) ──
  addHook(
    'feedback:finishComment',
    pluginId,
    async (comment: CommentLike, extra?: HookExtra) => {
      if (!extra?.db || !extra.options) return;
      const config = loadConfig(extra.options);
      if (!isReady(config)) return;

      const wantAdmin = config.commentNotifyEnabled;
      const wantReply = config.replyNotifyEnabled && Boolean(comment?.parent);
      if (!wantAdmin && !wantReply) return;
      if (String(comment?.status || '') !== 'approved') return;
      if (!comment?.cid || !comment.coid) return;

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

      // The parent comment being replied to (empty when this is a top-level comment).
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

      const seen = new Set<string>();
      const recipients: { to: string }[] = [];

      if (wantAdmin) {
        for (const r of await adminRecipients(extra.db, comment.authorId)) {
          if (seen.has(r.to)) continue;
          seen.add(r.to);
          recipients.push(r);
        }
      }

      if (wantReply && comment.parent) {
        if (
          parentComment?.mail && isValidEmail(parentComment.mail)
          && parentComment.mail !== comment.mail
          && !seen.has(parentComment.mail)
        ) {
          seen.add(parentComment.mail);
          recipients.push({ to: parentComment.mail });
        }
      }

      if (!recipients.length) return;
      await sendToAll(config, recipients, renderEmail(config, vars));
    },
  );

  // ── Test-send API (own admin route, no core changes needed) ──
  addHook(
    'route:request',
    pluginId,
    async (result: PluginRouteResult, extra?: HookExtra) => {
      if (result?.handled || !extra?.request || extra.path !== TEST_API_ROUTE) return result;

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
        const body = await extra.request.json() as { to?: unknown };
        const to = String(body.to || '').trim();
        if (!to) {
          return { handled: true, response: jsonOk('请填写测试收件邮箱', false) };
        }
        if (!isValidEmail(to)) {
          return { handled: true, response: jsonOk('测试收件邮箱格式不正确', false) };
        }

        const config = loadConfig(options);
        if (!config.apiKey) {
          return { handled: true, response: jsonOk('请先在「插件设置」中填写 API Key', false) };
        }
        if (!isValidEmail(config.from)) {
          return { handled: true, response: jsonOk('发件邮箱格式不正确，请先在「插件设置」中修正', false) };
        }

        const resultSend = await sendTestMail(config, to, options);
        if (resultSend.sent) {
          return { handled: true, response: jsonOk('测试邮件已发送，请检查收件箱', true) };
        }
        return { handled: true, response: jsonOk(`发送失败：${resultSend.error || '未知错误'}`, false) };
      } catch (error) {
        console.error(`[${PLUGIN_ID}] 测试邮件失败:`, error);
        return { handled: true, response: jsonOk('请求解析失败', false) };
      }
    },
    20,
  );

  // ── Plugin admin page (send test) ──
  addHook(
    'admin:page',
    pluginId,
    (html: string, extra?: { slug?: string; csrfToken?: string; options?: Record<string, unknown> }) => {
      if (extra?.slug !== ADMIN_PAGE_SLUG) return html;
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

      const isActive = extra?.activeMenu === ADMIN_PAGE_SLUG;
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
    li.innerHTML = '<a href="/admin/plugin/${ADMIN_PAGE_SLUG}">邮件测试</a>';
    sub.appendChild(li);
  }
})();
</script>`;
      return html + extraHtml;
    },
  );

  // ── Config validation ──
  addHook(
    'plugin:config:beforeSave',
    pluginId,
    (result: { success: boolean; settings?: Record<string, unknown>; error?: string }, extra?: { pluginId?: string; settings?: Record<string, unknown>; options?: Record<string, unknown> }) => {
      if (extra?.pluginId !== pluginId) return result;

      const settings = extra.settings || {};
      const config = normalizeConfig(settings);
      if (config.apiKey === SECRET_PLACEHOLDER) {
        config.apiKey = loadConfig(extra.options).apiKey;
      }

      if (config.enabled) {
        if (!config.apiKey) {
          return { success: false, error: '启用邮件通知时必须填写 API Key' };
        }
        if (!isValidEmail(config.from)) {
          return { success: false, error: '发件邮箱格式不正确' };
        }
      }

      return { success: true, settings: toFormValues(config) };
    },
  );
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
