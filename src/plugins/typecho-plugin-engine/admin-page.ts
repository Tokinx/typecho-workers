/**
 * Engine admin settings page (/admin/plugin/engine).
 */
import { escapeHtml } from 'typecho/plugin-sdk';
import {
  maskSecretFormValues,
  toFormValues,
  type EngineSettings,
  type SearchProvider,
} from './config';

export const ADMIN_PAGE_SLUG = 'engine';
export const CONFIG_API_ROUTE = '/api/admin/plugin-engine/config';

export function isEngineAdminSlug(slug: string | undefined): boolean {
  return slug === ADMIN_PAGE_SLUG;
}

function attr(value: string): string {
  return escapeHtml(value);
}

type FieldItem = { label: string; control: string; description?: string };

function fieldCell(item: FieldItem): string {
  return `<div class="engine-field">`
    + `<label class="typecho-label">${escapeHtml(item.label)}</label>${item.control}`
    + (item.description ? `<p class="description">${item.description}</p>` : '')
    + `</div>`;
}

/** N labeled controls in one row (desktop); stacks on narrow viewports. */
function fieldRow(...items: FieldItem[]): string {
  const cols = items.length;
  return `<li class="engine-row engine-row-${cols}">${items.map(fieldCell).join('')}</li>`;
}

function textInput(name: string, value: string, opts: { type?: string; placeholder?: string } = {}): string {
  const type = opts.type || 'text';
  const ph = opts.placeholder ? ` placeholder="${attr(opts.placeholder)}"` : '';
  return `<input type="${type}" name="${name}" id="engine-${name}" class="text w-100" value="${attr(value)}"${ph}>`;
}

function searchCards(
  name: string,
  value: string,
  options: Array<{ value: SearchProvider; label: string; badge: string; hint: string }>,
): string {
  return `<div class="engine-scope-grid" role="radiogroup" aria-label="搜索方式">${options.map((opt) => {
    const checked = opt.value === value ? ' checked' : '';
    const active = opt.value === value ? ' is-active' : '';
    return `<label class="engine-scope-card${active}">`
      + `<input type="radio" name="${name}" value="${attr(opt.value)}"${checked}>`
      + `<span class="engine-scope-top">`
      + `<span class="engine-scope-title">${escapeHtml(opt.label)}</span>`
      + `<span class="engine-scope-badge">${escapeHtml(opt.badge)}</span>`
      + `</span>`
      + `<span class="engine-scope-hint">${escapeHtml(opt.hint)}</span>`
      + `</label>`;
  }).join('')}</div>`;
}

const SEARCH_OPTIONS: Array<{ value: SearchProvider; label: string; badge: string; hint: string }> = [
  { value: 'default', label: '默认', badge: '站内搜索', hint: '搜索标题与正文，保持原有站内搜索行为' },
  { value: 'bing', label: 'Bing', badge: '外部搜索', hint: '直接跳转 Bing 搜索本站，关闭内部搜索路由' },
  { value: 'google', label: 'Google', badge: '外部搜索', hint: '直接跳转 Google 搜索本站，关闭内部搜索路由' },
];

export function adminPageHtml(csrf: string, config: EngineSettings): string {
  const values = maskSecretFormValues(toFormValues(config));
  const v = (key: keyof typeof values) => values[key] || '';

  return `<div class="col-mb-12" id="engine-settings-app">
  <div id="engine-settings-notice" style="display:none" role="status" aria-live="polite"></div>

  <form id="engine-settings-form">
    <input type="hidden" name="_" value="${attr(csrf)}">

    <section class="engine-panel">
      <header class="engine-panel-head">
        <h3>基础设置</h3>
        <p>连接 OpenAI 兼容接口，供写作辅助与摘要共用</p>
      </header>
      <ul class="typecho-option engine-option-list">
        ${fieldRow(
          {
            label: '接口地址',
            control: textInput('endpoint', v('endpoint'), { placeholder: 'https://…/v4/' }),
            description: 'Base URL，请求时自动追加 /chat/completions',
          },
          {
            label: 'API Key',
            control: textInput('apiKey', v('apiKey'), { type: 'password' }),
            description: '仅 AI 功能需要；已保存显示为掩码，保留掩码表示不修改',
          },
        )}
        ${fieldRow(
          { label: '模型名称', control: textInput('model', v('model')) },
          { label: 'Temperature', control: textInput('temperature', v('temperature')) },
          { label: 'Max Token', control: textInput('maxTokens', v('maxTokens')) },
        )}
      </ul>
    </section>

    <section class="engine-panel" aria-labelledby="engine-summary-title">
      <header class="engine-panel-head engine-summary-head">
        <div class="engine-summary-title">
          <h3 id="engine-summary-title">智能摘要</h3>
          <p>使用已保存的 AI 配置生成 120～300 字内容概览</p>
        </div>
        <label class="engine-toggle">
          <input type="checkbox" role="switch" name="autoSummary" id="engine-autoSummary" value="1"${v('autoSummary') === '1' ? ' checked' : ''} aria-label="自动生成智能摘要">
          <span id="engine-auto-summary-state" aria-hidden="true">${v('autoSummary') === '1' ? '开启' : '关闭'}</span>
        </label>
      </header>
      <div class="engine-summary-batch">
        <div class="engine-summary-batch-head">
          <div class="engine-summary-copy">
            <h4>手动批量生成</h4>
            <p class="description">为已发布的文章和页面生成智能摘要，不受自动生成开关影响。</p>
          </div>
          <div class="engine-summary-actions">
            <div class="engine-batch-actions">
              <button type="button" class="btn primary" id="engine-batch-start">批量生成</button>
              <button type="button" class="btn" id="engine-batch-stop" disabled>停止</button>
            </div>
            <label class="engine-check"><input type="checkbox" id="engine-skip-existing" checked> 跳过已有摘要</label>
          </div>
        </div>
        <div id="engine-batch-progress" class="engine-batch-progress" hidden>
          <div class="engine-batch-bar"><div id="engine-batch-bar-fill"></div></div>
          <p id="engine-batch-status" class="description" role="status" aria-live="polite"></p>
          <ul id="engine-batch-log" class="engine-batch-log"></ul>
        </div>
      </div>
    </section>

    <section class="engine-panel">
      <header class="engine-panel-head">
        <h3>搜索方式</h3>
        <p>选择站内搜索或直接跳转外部搜索引擎</p>
      </header>
      ${searchCards('searchProvider', v('searchProvider'), SEARCH_OPTIONS)}
      <p class="description">外部搜索使用关键词 + site:站点域名，仅能搜索引擎已收录的内容；新文章可能延迟出现。插件停用后恢复默认站内搜索。</p>
    </section>

    <p class="submit engine-submit">
      <button type="submit" class="btn primary" id="engine-settings-save">保存设置</button>
    </p>
  </form>
</div>

<style>
#engine-settings-app p:last-child,
#engine-settings-app .engine-batch-actions { margin-bottom: 0; }
#engine-settings-app .engine-panel {
  background: #fff;
  border: 1px solid #e7e7e7;
  border-radius: 6px;
  padding: 1.1em 1.25em 1.25em;
  margin-bottom: 1.25em;
}
#engine-settings-app .engine-panel-head { margin-bottom: 1em; }
#engine-settings-app .engine-panel-head h3 {
  margin: 0 0 .25em;
  font-size: 1.05em;
  font-weight: 600;
}
#engine-settings-app .engine-panel-head p {
  margin: 0;
  color: #888;
  font-size: .92857em;
}
#engine-settings-app .engine-option-list { list-style: none; margin: 0; padding: 0; }
#engine-settings-app .engine-option-list > li { margin: 0 0 1em; padding: 0; border: 0; }
#engine-settings-app .engine-option-list > li:last-child { margin-bottom: 0; }
#engine-settings-app .engine-row {
  display: grid !important;
  gap: 1em 1.25em;
  align-items: start;
}
#engine-settings-app .engine-row-2 { grid-template-columns: 1fr 1fr; }
#engine-settings-app .engine-row-3 { grid-template-columns: 1fr 1fr 1fr; }
#engine-settings-app .engine-field { min-width: 0; }
#engine-settings-app .engine-field .text,
#engine-settings-app .engine-field select {
  width: 100%;
  box-sizing: border-box;
}
#engine-settings-app .engine-field select { height: 32px; }
#engine-settings-app .engine-field .description { margin: .35em 0 0; }

#engine-settings-app .engine-summary-head,
#engine-settings-app .engine-summary-batch-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 1em 1.5em;
}
#engine-settings-app .engine-panel-head.engine-summary-head { margin-bottom: 0; }
#engine-settings-app .engine-summary-title,
#engine-settings-app .engine-summary-copy { min-width: 0; }
#engine-settings-app .engine-summary-copy h4 { margin: 0 0 .4em; font-size: 1em; font-weight: 600; }
#engine-settings-app .engine-summary-copy .description { margin: 0; line-height: 1.6; }
#engine-settings-app .engine-summary-batch { margin-top: 1em; padding-top: 1em; border-top: 1px solid #eee; }
#engine-settings-app .engine-summary-actions { display: flex; flex-direction: column; align-items: flex-start; gap: .65em; }
#engine-settings-app .engine-summary-actions .btn { white-space: nowrap; }
#engine-settings-app .engine-toggle { display: inline-flex; align-items: center; gap: .5em; margin: 0; white-space: nowrap; cursor: pointer; color: #666; }
#engine-settings-app .engine-toggle input {
  appearance: none;
  position: relative;
  width: 2.6em;
  height: 1.5em;
  margin: 0;
  border: 1px solid transparent;
  border-radius: 1em;
  background: #b8c0c5;
  cursor: pointer;
}
#engine-settings-app .engine-toggle input::before {
  content: '';
  position: absolute;
  width: 1.1em;
  height: 1.1em;
  top: calc(.2em - 1px);
  left: calc(.2em - 1px);
  border-radius: 50%;
  background: #fff;
  transition: transform .15s ease;
}
#engine-settings-app .engine-toggle input:checked { background: #467B96; }
#engine-settings-app .engine-toggle input:checked::before { transform: translateX(1.1em); }
#engine-settings-app .engine-toggle input:focus-visible { outline: 2px solid #467B96; outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  #engine-settings-app .engine-toggle input::before { transition: none; }
}
#engine-settings-app .engine-batch-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .5em;
  justify-content: flex-start;
}
#engine-settings-app .engine-check {
  display: inline-flex;
  gap: .35em;
  align-items: center;
  color: #555;
  margin: 0;
}
#engine-settings-app .engine-batch-progress { margin-top: .9em; }
#engine-settings-app .engine-batch-bar {
  height: 8px;
  background: #e8e8e8;
  border-radius: 4px;
  overflow: hidden;
}
#engine-settings-app #engine-batch-bar-fill {
  height: 100%;
  width: 0;
  background: #467B96;
  transition: width .2s ease;
}
#engine-settings-app .engine-batch-log {
  max-height: 200px;
  overflow: auto;
  margin: .55em 0 0;
  padding: .6em .8em;
  list-style: none;
  background: #fff;
  border: 1px solid #eee;
  border-radius: 4px;
  font-size: .92857em;
  color: #666;
}
#engine-settings-app .engine-batch-log li { margin: .15em 0; }
#engine-settings-app .engine-batch-log .ok { color: #2e7d32; }
#engine-settings-app .engine-batch-log .err { color: #c62828; }

#engine-settings-app .engine-scope-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: .85em;
}
#engine-settings-app .engine-scope-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: .4em;
  margin: 0;
  padding: 1em 1em 1em 2.4em;
  border: 1px solid #e5e5e5;
  border-radius: 6px;
  background: #fafafa;
  cursor: pointer;
  transition: border-color .15s ease, background .15s ease, box-shadow .15s ease;
}
#engine-settings-app .engine-scope-card:hover { border-color: #b7cdd8; }
#engine-settings-app .engine-scope-card.is-active,
#engine-settings-app .engine-scope-card:has(input:checked) {
  border-color: #467B96;
  background: #f3f8fb;
  box-shadow: inset 0 0 0 1px #467B96;
}
#engine-settings-app .engine-scope-card input {
  position: absolute;
  left: .9em;
  top: 1.2em;
  margin: 0;
}
#engine-settings-app .engine-scope-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .5em;
  margin-right: 0;
}
#engine-settings-app .engine-scope-title {
  font-weight: 600;
  color: #333;
  margin-right: 0;
}
#engine-settings-app .engine-scope-badge {
  flex-shrink: 0;
  margin: 0;
  padding: .12em .5em;
  border-radius: 999px;
  background: #eef3f6;
  color: #467B96;
  font-size: .78em;
  font-weight: 600;
  white-space: nowrap;
}
#engine-settings-app .engine-scope-card.is-active .engine-scope-badge,
#engine-settings-app .engine-scope-card:has(input:checked) .engine-scope-badge {
  background: #467B96;
  color: #fff;
}
#engine-settings-app .engine-scope-hint {
  color: #888;
  font-size: .92857em;
  line-height: 1.45;
  margin-right: 0;
}
#engine-settings-app .engine-submit { margin: .25em 0 1.5em; }

#engine-settings-notice { margin-bottom: 1em; padding: .75em 1em; border-radius: 4px; }
#engine-settings-notice.is-ok { background: #e8f5e9; color: #2e7d32; }
#engine-settings-notice.is-err { background: #ffebee; color: #c62828; }

@media (max-width: 820px) {
  #engine-settings-app .engine-row-2,
  #engine-settings-app .engine-row-3 {
    grid-template-columns: 1fr !important;
  }
  #engine-settings-app .engine-scope-grid {
    display: flex;
    flex-direction: column;
  }
}
@media (max-width: 640px) {
  #engine-settings-app .engine-summary-head { gap: 1em; }
  #engine-settings-app .engine-summary-batch-head { grid-template-columns: minmax(0, 1fr); gap: .85em; }
  #engine-settings-app .engine-summary-actions { flex-direction: row; align-items: center; flex-wrap: wrap; gap: .75em 1em; }
}
</style>

<script>
(function () {
  var form = document.getElementById('engine-settings-form');
  var notice = document.getElementById('engine-settings-notice');
  var saveBtn = document.getElementById('engine-settings-save');
  var startBtn = document.getElementById('engine-batch-start');
  var stopBtn = document.getElementById('engine-batch-stop');
  var skipExisting = document.getElementById('engine-skip-existing');
  var progressBox = document.getElementById('engine-batch-progress');
  var barFill = document.getElementById('engine-batch-bar-fill');
  var statusEl = document.getElementById('engine-batch-status');
  var logEl = document.getElementById('engine-batch-log');
  var csrf = ${JSON.stringify(csrf)};
  var configUrl = ${JSON.stringify(CONFIG_API_ROUTE)};
  var batchStop = false;
  var autoSummary = document.getElementById('engine-autoSummary');
  var autoSummaryState = document.getElementById('engine-auto-summary-state');
  if (autoSummary && autoSummaryState) {
    autoSummary.addEventListener('change', function () {
      autoSummaryState.textContent = autoSummary.checked ? '开启' : '关闭';
    });
  }


  function showNotice(ok, message) {
    if (!notice) return;
    notice.style.display = 'block';
    notice.className = ok ? 'is-ok' : 'is-err';
    notice.textContent = message;
  }

  form.querySelectorAll('.engine-scope-card input').forEach(function (input) {
    input.addEventListener('change', function () {
      form.querySelectorAll('.engine-scope-card').forEach(function (card) {
        card.classList.toggle('is-active', !!(card.querySelector('input') && card.querySelector('input').checked));
      });
    });
  });

  function collectSettings() {
    var data = new FormData(form);
    return {
      endpoint: String(data.get('endpoint') || ''),
      apiKey: String(data.get('apiKey') || ''),
      model: String(data.get('model') || ''),
      temperature: String(data.get('temperature') || ''),
      maxTokens: String(data.get('maxTokens') || ''),
      autoSummary: String(data.get('autoSummary') || '0'),
      searchProvider: String(data.get('searchProvider') || 'default'),
    };
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (saveBtn) saveBtn.disabled = true;
    try {
      var res = await fetch(configUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ settings: collectSettings(), _: csrf }),
      });
      var json = await res.json().catch(function () { return {}; });
      if (!res.ok || !json.success) {
        showNotice(false, json.message || ('保存失败 (' + res.status + ')'));
        return;
      }
      showNotice(true, json.message || '设置已保存');
      if (json.settings && json.settings.apiKey !== undefined) {
        var keyInput = document.getElementById('engine-apiKey');
        if (keyInput) keyInput.value = json.settings.apiKey;
      }
    } catch (err) {
      showNotice(false, '保存失败：网络错误');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  function pluginAction(action, payload) {
    return fetch('/api/admin/plugin-action', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify({
        _: csrf,
        plugin: 'typecho-plugin-engine',
        action: action,
        payload: payload || {},
      }),
    }).then(function (res) {
      return res.json().then(function (json) {
        return { ok: res.ok, status: res.status, json: json };
      });
    });
  }

  function appendLog(cls, text) {
    if (!logEl) return;
    var li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    logEl.appendChild(li);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function summarizeWithRetry(item, attempts) {
    var lastError = '未知错误';
    for (var i = 0; i < attempts; i++) {
      if (batchStop) throw new Error('已停止');
      try {
        var result = await pluginAction('summarizeOne', { cid: item.cid });
        if (result.json && result.json.success) return result.json;
        lastError = (result.json && (result.json.error || result.json.message)) || ('HTTP ' + result.status);
      } catch (err) {
        lastError = err && err.message ? err.message : '网络错误';
      }
    }
    throw new Error(lastError);
  }

  if (startBtn) {
    startBtn.addEventListener('click', async function () {
      batchStop = false;
      startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      if (progressBox) progressBox.hidden = false;
      if (logEl) logEl.innerHTML = '';
      if (barFill) barFill.style.width = '0%';
      if (statusEl) statusEl.textContent = '正在加载列表…';

      try {
        var listRes = await pluginAction('listForSummary', {});
        if (!listRes.json || !listRes.json.success || !Array.isArray(listRes.json.items)) {
          throw new Error((listRes.json && (listRes.json.error || listRes.json.message)) || '无法加载文章列表');
        }
        var items = listRes.json.items.slice();
        if (skipExisting && skipExisting.checked) {
          items = items.filter(function (item) { return !item.hasSummary; });
        }
        if (items.length === 0) {
          if (statusEl) statusEl.textContent = '没有需要处理的文章';
          showNotice(true, '没有需要生成摘要的内容');
          return;
        }

        var done = 0;
        var failed = 0;
        for (var i = 0; i < items.length; i++) {
          if (batchStop) break;
          var item = items[i];
          if (statusEl) {
            statusEl.textContent = '正在生成 (' + (i + 1) + '/' + items.length + ')：' + (item.title || ('#' + item.cid));
          }
          try {
            await summarizeWithRetry(item, 3);
            done++;
            appendLog('ok', '✓ #' + item.cid + ' ' + (item.title || ''));
          } catch (err) {
            failed++;
            appendLog('err', '✗ #' + item.cid + ' ' + (item.title || '') + ' — ' + (err && err.message ? err.message : '失败'));
          }
          if (barFill) barFill.style.width = Math.round(((i + 1) / items.length) * 100) + '%';
        }

        var summary = batchStop
          ? ('已停止：成功 ' + done + '，失败 ' + failed)
          : ('完成：成功 ' + done + '，失败 ' + failed);
        if (statusEl) statusEl.textContent = summary;
        showNotice(failed === 0 && !batchStop, summary);
      } catch (err) {
        showNotice(false, err && err.message ? err.message : '批量生成失败');
        if (statusEl) statusEl.textContent = '批量生成失败';
      } finally {
        startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
      }
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      batchStop = true;
      stopBtn.disabled = true;
    });
  }

})();
</script>`;
}
