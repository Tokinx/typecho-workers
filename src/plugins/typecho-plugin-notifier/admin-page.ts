/**
 * Notifier admin page: notification matrix + channel tabs (credentials / templates / test).
 * Rendered via admin:page into /admin/plugin/notifier-settings.
 */
import { escapeHtml } from 'typecho/plugin-sdk';
import {
  VALID_PROVIDERS,
  toFormValues,
  maskSecretFormValues,
  type MailProvider,
  type NotifierConfig,
} from './config';
import { TEMPLATE_PLACEHOLDERS, SYSTEM_PLACEHOLDERS } from './templates';

export const ADMIN_PAGE_SLUG = 'notifier-settings';
/** Former slug — still matched so old bookmarks keep working. */
export const ADMIN_PAGE_SLUG_LEGACY = 'notifier-test';
export const TEST_API_ROUTE = '/api/admin/plugin-notifier/test';
export const CONFIG_API_ROUTE = '/api/admin/plugin-notifier/config';

/** Provider sites — quick link from the settings page to grab an API Key. */
const PROVIDER_SITES: Record<MailProvider, string> = {
  resend: 'https://resend.com',
  mailersend: 'https://mailersend.com',
  brevo: 'https://brevo.com',
  plunk: 'https://useplunk.com',
  maileroo: 'https://maileroo.com',
};

export function isNotifierAdminSlug(slug: string | undefined): boolean {
  return slug === ADMIN_PAGE_SLUG || slug === ADMIN_PAGE_SLUG_LEGACY;
}

function attr(value: string): string {
  return escapeHtml(value);
}

function checked(on: boolean): string {
  return on ? ' checked' : '';
}

function checkbox(name: string, label: string, on: boolean): string {
  return `<label class="notifier-check"><input type="checkbox" name="${name}" value="1"${checked(on)}> ${escapeHtml(label)}</label>`;
}

function textInput(name: string, value: string, opts: { type?: string; placeholder?: string } = {}): string {
  const type = opts.type || 'text';
  const ph = opts.placeholder ? ` placeholder="${attr(opts.placeholder)}"` : '';
  return `<input type="${type}" name="${name}" id="nf-${name}" class="text w-100" value="${attr(value)}"${ph}>`;
}

function textarea(name: string, value: string, rows = 4): string {
  return `<textarea name="${name}" id="nf-${name}" class="w-100" rows="${rows}">${escapeHtml(value)}</textarea>`;
}

function select(name: string, value: string, options: Record<string, string>): string {
  const opts = Object.entries(options)
    .map(([v, label]) => `<option value="${attr(v)}"${v === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
  return `<select name="${name}" id="nf-${name}">${opts}</select>`;
}

function field(label: string, control: string, description?: string): string {
  const desc = description ? `<p class="description">${description}</p>` : '';
  return `<li><label class="typecho-label">${escapeHtml(label)}</label>${control}${desc}</li>`;
}

/** Two labeled controls side-by-side (desktop); stacks on narrow viewports via CSS. */
function fieldRow(
  left: { label: string; control: string; description?: string },
  right: { label: string; control: string; description?: string },
): string {
  const cell = (item: { label: string; control: string; description?: string }) =>
    `<div class="notifier-field">`
    + `<label class="typecho-label">${escapeHtml(item.label)}</label>${item.control}`
    + (item.description ? `<p class="description">${item.description}</p>` : '')
    + `</div>`;
  return `<li class="notifier-row">${cell(left)}${cell(right)}</li>`;
}

function matrixRow(label: string, checksHtml: string): string {
  return `<li>`
    + `<label class="typecho-label">${escapeHtml(label)}</label>`
    + `<p class="notifier-checks">${checksHtml}</p>`
    + `</li>`;
}

export function adminPageHtml(csrf: string, config: NotifierConfig, _siteTitle: string): string {
  const values = maskSecretFormValues(toFormValues(config));
  const v = (key: keyof typeof values) => values[key] || '';
  const on = (key: keyof NotifierConfig) => Boolean(config[key]);
  const ph = (list: readonly string[]) => list.map(p => `<code>${p}</code>`).join('');
  const commentGroups = [
    { label: '站点信息', keys: TEMPLATE_PLACEHOLDERS.filter(p => p.startsWith('{site.')) },
    { label: '文章信息', keys: TEMPLATE_PLACEHOLDERS.filter(p => p.startsWith('{post.')) },
    { label: '新回复信息', keys: TEMPLATE_PLACEHOLDERS.filter(p => p.startsWith('{reply.')) },
    { label: '原评论信息', keys: TEMPLATE_PLACEHOLDERS.filter(p => p.startsWith('{comment.')) },
  ];
  const phRow = (label: string, keys: readonly string[]) =>
    `<div class="notifier-ph-row"><span class="notifier-ph-label">${label}</span>${ph(keys)}</div>`;
  const SYSTEM_PH_LABELS: Record<string, string> = {
    '{subject}': '邮件主题',
    '{body}': '正文（HTML）',
    '{text}': '纯文本',
    '{reason}': '原因',
    '{to}': '收件人',
  };
  const systemRows = SYSTEM_PLACEHOLDERS
    .map(p => phRow(SYSTEM_PH_LABELS[p] ?? p, [p]))
    .join('');

  const providerOptions = Object.fromEntries(VALID_PROVIDERS.map(p => [
    p,
    ({ resend: 'Resend', mailersend: 'MailerSend', brevo: 'Brevo', plunk: 'Plunk', maileroo: 'Maileroo' } as Record<string, string>)[p],
  ]));

  return `<div class="col-mb-12" id="notifier-settings-app">
  <div id="notifier-settings-notice" style="display:none" role="status" aria-live="polite"></div>

  <form id="notifier-settings-form">
    <ul class="typecho-option">
      ${matrixRow('系统通知', `
          ${checkbox('systemEmail', '邮件', on('systemEmail'))}
          <span class="notifier-sep">·</span>
          ${checkbox('systemWebhook', 'WebHook', on('systemWebhook'))}
      `)}
      ${matrixRow('新消息通知管理员', `
          ${checkbox('commentEmail', '邮件', on('commentEmail'))}
          <span class="notifier-sep">·</span>
          ${checkbox('commentWebhook', 'WebHook', on('commentWebhook'))}
      `)}
      ${matrixRow('评论回复通知', checkbox('replyEmail', '邮件', on('replyEmail')))}
    </ul>

    <div class="notifier-tabs-wrap">
      <nav class="notifier-tabs" aria-label="渠道设置" role="tablist">
        <button type="button" class="current" role="tab" aria-selected="true" data-tab="email">邮件</button>
        <button type="button" role="tab" aria-selected="false" data-tab="webhook">WebHook</button>
      </nav>

      <div class="notifier-tab-panel" data-panel="email" role="tabpanel">
        <ul class="typecho-option">
          ${fieldRow(
            {
              label: '服务商',
              control: select('emailProvider', v('emailProvider'), providerOptions),
              description: `获取 API Key：<a id="nf-emailProvider-link" href="${PROVIDER_SITES[v('emailProvider') as MailProvider] ?? '#'}" target="_blank" rel="noopener">${PROVIDER_SITES[v('emailProvider') as MailProvider] ?? ''}</a>`,
            },
            {
              label: 'API Key',
              control: textInput('emailApiKey', v('emailApiKey'), { type: 'password' }),
              description: '留空或保持占位表示不修改已保存的密钥。',
            },
          )}
          ${fieldRow(
            { label: '发件邮箱', control: textInput('emailFrom', v('emailFrom')) },
            { label: '发件名称', control: textInput('emailFromName', v('emailFromName')) },
          )}
          ${field('邮件标题', textInput('mailSubject', v('mailSubject')))}
          ${field('邮件正文', textarea('mailBody', v('mailBody'), 5))}
          <li>
            <label class="typecho-label" for="notifier-test-to">发送测试</label>
            <div class="notifier-inline">
              <input type="email" id="notifier-test-to" class="text" placeholder="you@example.com" value="">
              <button type="button" class="btn" data-channel="email">发送测试邮件</button>
            </div>
          </li>
        </ul>
      </div>

      <div class="notifier-tab-panel" data-panel="webhook" role="tabpanel" hidden>
        <ul class="typecho-option">
          ${fieldRow(
            { label: 'API 地址', control: textInput('webhookUrl', v('webhookUrl'), { placeholder: 'https://' }) },
            { label: 'API Key / Token（可选）', control: textInput('webhookToken', v('webhookToken'), { type: 'password' }) },
          )}
          ${field('系统通知', textarea('systemWebhookPayload', v('systemWebhookPayload'), 7))}
          ${field('评论通知', textarea('commentWebhookPayload', v('commentWebhookPayload'), 7))}
          <li>
            <label class="typecho-label">发送测试</label>
            <button type="button" class="btn" data-channel="webhook">发送测试请求</button>
          </li>
        </ul>
      </div>
    </div>

    <div class="typecho-option">
      <div class="notifier-ph notifier-ph-groups">
        <div class="notifier-ph-group">
          <div class="notifier-ph-title">系统通知</div>
          ${systemRows}
        </div>
        <div class="notifier-ph-group">
          <div class="notifier-ph-title">评论通知</div>
          ${commentGroups.map(g => phRow(g.label, g.keys)).join('')}
        </div>
      </div>
      <p class="description">{reply.*} 为新评论，{comment.*} 为被回复的评论（无被回复评论时为空）；JSON 模板中占位符须放在双引号内。</p>
    </div>

    <ul class="typecho-option typecho-option-submit">
      <li>
        <button type="submit" class="btn primary" id="notifier-save-btn">保存设置</button>
      </li>
    </ul>
  </form>
</div>
<style>
.typecho-option li:not(:first-child){margin-top:1em}
#notifier-settings-app .typecho-option textarea{display:block}
#notifier-settings-app .notifier-ph{border:1px solid #E7EAF0;border-radius:4px;background:#FBFBFA;padding:12px 14px;}
#notifier-settings-app .notifier-ph-head{font-weight:bold;margin:0 0 10px}
#notifier-settings-app .notifier-ph-groups{display:grid;grid-template-columns:1fr 2fr;gap:0 20px}
#notifier-settings-app .notifier-ph-group + .notifier-ph-group{border-left:1px solid #E7EAF0;padding-left:20px}
#notifier-settings-app .notifier-ph-title{font-size:.92857em;font-weight:bold;color:#315F78;margin:0 0 8px}
#notifier-settings-app .notifier-ph-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;margin:0 0 8px;font-size:.92857em}
#notifier-settings-app .notifier-ph-row .notifier-ph-label{min-width:5.5em;color:#888;flex-shrink:0}
#notifier-settings-app .notifier-ph-row code{background:#F0F0EC;border:1px solid #E7EAF0;border-radius:3px;padding:1px 6px;color:#444;font-size:.92857em}
#notifier-settings-app .notifier-checks{display:flex;flex-wrap:wrap;align-items:center;gap:6px 4px;margin:4px 0 0}
#notifier-settings-app .notifier-check{display:inline-flex;align-items:center;gap:4px;margin:0;font-weight:normal;cursor:pointer}
#notifier-settings-app .notifier-sep{color:#bbb;margin:0 4px}
#notifier-settings-app .notifier-row{display:grid;grid-template-columns:1fr 1fr;gap:12px 20px}
#notifier-settings-app .notifier-field .text,#notifier-settings-app .notifier-field select{width:100%;box-sizing:border-box}
#notifier-settings-app .notifier-field select{height:32px}
#notifier-settings-app .notifier-inline{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
#notifier-settings-app .notifier-inline .text{flex:1 1 220px;min-width:0;max-width:360px}
#notifier-settings-app .notifier-tabs-wrap{margin-top:16px}
#notifier-settings-app .notifier-tabs{display:flex;gap:20px;border-bottom:1px solid #e7eaf0;margin-bottom:12px}
#notifier-settings-app .notifier-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;color:#64748b;padding:10px 0;cursor:pointer;font:inherit}
#notifier-settings-app .notifier-tabs button:hover{color:#315f78}
#notifier-settings-app .notifier-tabs button.current{color:#315f78;border-bottom-color:#315f78}
#notifier-settings-app .notifier-tab-panel[hidden]{display:none}
#notifier-settings-notice:empty{display:none}
@media (max-width:600px){
  #notifier-settings-app .notifier-row{grid-template-columns:1fr}
  #notifier-settings-app .notifier-ph-groups{grid-template-columns:1fr}
  #notifier-settings-app .notifier-ph-group + .notifier-ph-group{border-left:0;padding-left:0;margin-top:12px;border-top:1px solid #E7EAF0;padding-top:12px}
}
</style>
<script>
(function(){
var csrf=${JSON.stringify(csrf)};
var PROVIDER_SITES=${JSON.stringify(PROVIDER_SITES)};
var providerSel=document.getElementById("nf-emailProvider");
var providerLink=document.getElementById("nf-emailProvider-link");
function updateProviderHint(){
  var site=PROVIDER_SITES[providerSel.value]||"";
  providerLink.href=site;
  providerLink.textContent=site;
}
if(providerSel&&providerLink){providerSel.addEventListener("change",updateProviderHint)}
var noticeEl=document.getElementById("notifier-settings-notice");
var form=document.getElementById("notifier-settings-form");
var timer=null;
var TEST_LABELS={email:"发送测试邮件",webhook:"发送测试请求"};
function notice(msg,type){
  clearTimeout(timer);
  noticeEl.style.display="block";
  noticeEl.className="message "+(type==="success"?"success":"error");
  noticeEl.innerHTML="<p>"+E(msg)+"</p>";
  timer=setTimeout(function(){noticeEl.style.display="none";noticeEl.innerHTML=""},8000);
}
function E(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}

document.querySelectorAll(".notifier-tabs [data-tab]").forEach(function(btn){
  btn.addEventListener("click",function(){
    var tab=btn.getAttribute("data-tab");
    document.querySelectorAll(".notifier-tabs [data-tab]").forEach(function(b){
      var on=b===btn;
      b.classList.toggle("current",on);
      b.setAttribute("aria-selected",on?"true":"false");
    });
    document.querySelectorAll(".notifier-tab-panel").forEach(function(p){
      p.hidden=p.getAttribute("data-panel")!==tab;
    });
  });
});

function collectSettings(){
  var data={};
  var fd=new FormData(form);
  form.querySelectorAll("input[type=checkbox]").forEach(function(cb){
    data[cb.name]=cb.checked?"1":"0";
  });
  form.querySelectorAll("input:not([type=checkbox]):not([type=email]), select, textarea").forEach(function(el){
    if(!el.name) return;
    data[el.name]=el.value;
  });
  return data;
}

form.addEventListener("submit",async function(e){
  e.preventDefault();
  var btn=document.getElementById("notifier-save-btn");
  btn.disabled=true;btn.textContent="保存中…";
  try{
    var r=await fetch(${JSON.stringify(CONFIG_API_ROUTE)},{
      method:"POST",
      headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},
      body:JSON.stringify({settings:collectSettings()})
    });
    var j;try{j=await r.json()}catch(err){throw new Error("Server error ("+r.status+")")}
    if(!r.ok||!j.success){throw new Error(j.message||j.error||"保存失败（"+r.status+"）")}
    if(j.settings){
      Object.keys(j.settings).forEach(function(key){
        var el=form.querySelector('[name="'+key+'"]');
        if(!el) return;
        if(el.type==="checkbox"){el.checked=j.settings[key]==="1";return}
        el.value=j.settings[key]==null?"":String(j.settings[key]);
      });
    }
    notice(j.message||"设置已保存","success");
  }catch(err){
    notice("保存失败："+err.message,"error");
  }finally{
    btn.disabled=false;btn.textContent="保存设置";
  }
});

document.querySelectorAll("[data-channel]").forEach(function(btn){
  btn.addEventListener("click",async function(){
    var channel=btn.getAttribute("data-channel");
    var body={channel:channel};
    if(channel==="email"){
      var to=document.getElementById("notifier-test-to").value.trim();
      if(!to){notice("请先填写测试收件邮箱","error");return}
      body.to=to;
    }
    btn.disabled=true;btn.textContent="发送中…";
    try{
      var r=await fetch(${JSON.stringify(TEST_API_ROUTE)},{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify(body)});
      var j;try{j=await r.json()}catch(err){throw new Error("Server error ("+r.status+")")}
      if(!r.ok||!j.success){throw new Error(j.message||"发送失败（"+r.status+"）")}
      notice(j.message||"测试通知已发送","success");
    }catch(err){
      notice("发送失败："+err.message,"error");
    }finally{
      btn.disabled=false;btn.textContent=TEST_LABELS[channel]||"发送测试";
    }
  });
});
})();
</script>`;
}
