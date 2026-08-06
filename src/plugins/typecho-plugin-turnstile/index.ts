import { escapeAttr, fetchWithTimeout, getClientIp, parsePluginOption } from 'typecho/plugin-sdk';
import type { PluginInitContext } from 'typecho/plugin-sdk';

interface TurnstileConfig {
  sitekey: string;
  secret: string;
  input: string;
  appearance: string;
  theme: string;
  size: string;
}

interface TurnstileVerifyResponse {
  success?: boolean;
}

interface MutableContext {
  _rejected?: string;
  [key: string]: unknown;
}

interface VerificationExtra {
  options?: Record<string, unknown>;
  formData?: FormData;
  request?: Request;
  isLoggedIn?: boolean;
  skipIfLoggedIn?: boolean;
}

type CspDirectives = Record<string, string[]>;

const DEFAULTS: TurnstileConfig = {
  sitekey: '',
  secret: '',
  input: 'cf-turnstile-response',
  appearance: 'always',
  theme: 'auto',
  size: 'normal',
};

function getPluginConfig(options?: Record<string, unknown>): TurnstileConfig {
  const config = parsePluginOption(options?.['plugin:typecho-plugin-turnstile'], 'turnstile');
  return {
    sitekey: String(config.sitekey || DEFAULTS.sitekey),
    secret: String(config.secret || DEFAULTS.secret),
    input: String(config.input || DEFAULTS.input),
    appearance: String(config.appearance || DEFAULTS.appearance),
    theme: String(config.theme || DEFAULTS.theme),
    size: String(config.size || DEFAULTS.size),
  };
}

function addCspSource(directives: CspDirectives, key: string, sources: string[]): void {
  const existing = new Set(directives[key] || []);
  for (const src of sources) existing.add(src);
  directives[key] = Array.from(existing);
}

async function verifyTurnstile(token: string, secret: string, remoteIp: string): Promise<TurnstileVerifyResponse> {
  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: remoteIp,
  });

  const resp = await fetchWithTimeout(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    5_000,
    'Turnstile verification timed out',
  );
  return await resp.json() as TurnstileVerifyResponse;
}

function buildSnippet(options: Record<string, unknown> | undefined, formId: string): { headHtml: string; bodyHtml: string } {
  const config = getPluginConfig(options);
  if (!config.sitekey) {
    return { headHtml: '', bodyHtml: '' };
  }

  const headHtml = `<script is:inline>
(function() {
  window.__typechoTurnstilePending = window.__typechoTurnstilePending || null;
  window.__typechoTurnstileSubmit = window.__typechoTurnstileSubmit || function(token) {
    var pending = window.__typechoTurnstilePending;
    if (!pending || !pending.form) return;

    var old = pending.form.querySelector('input[name="' + pending.inputName + '"]');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var field = document.createElement("input");
    field.id = pending.inputName;
    field.name = pending.inputName;
    field.type = "hidden";
    field.value = token;
    pending.form.appendChild(field);

    if (pending.timer) clearTimeout(pending.timer);
    if (pending.button) pending.button.disabled = false;
    window.__typechoTurnstilePending = null;
    if (typeof pending.form.requestSubmit === "function") {
      pending.form.requestSubmit();
    } else {
      pending.form.submit();
    }
  };
  window.__typechoTurnstileSetStatus = window.__typechoTurnstileSetStatus || function(containerId, message, type) {
    var container = document.getElementById(containerId);
    var form = container && container.closest("form");
    var status = form && form.querySelector("[data-comment-message]");
    if (!status) status = document.getElementById(containerId + "-status");
    if (!status) return;
    status.textContent = message || status.getAttribute("data-default-message") || "";
    if (!status.hasAttribute("data-comment-message")) {
      status.className = "typecho-turnstile-status message " + (type === "error" ? "error" : "notice");
    }
  };
  window.__typechoTurnstileResetPending = window.__typechoTurnstileResetPending || function(message) {
    var pending = window.__typechoTurnstilePending;
    if (pending && pending.timer) clearTimeout(pending.timer);
    if (pending && pending.button) pending.button.disabled = false;
    if (pending && pending.containerId && message) {
      window.__typechoTurnstileSetStatus(pending.containerId, message, "error");
    }
    window.__typechoTurnstilePending = null;
  };
  window.__typechoTurnstileReady = window.__typechoTurnstileReady || function(callback) {
    if (window.turnstile && typeof window.turnstile.render === "function") {
      callback();
      return;
    }
    var attempts = 0;
    var timer = setInterval(function() {
      attempts += 1;
      if (window.turnstile && typeof window.turnstile.render === "function") {
        clearInterval(timer);
        callback();
      } else if (attempts >= 100) {
        clearInterval(timer);
      }
    }, 100);
  };
})();
</script><style>
.typecho-turnstile { margin: 0 0 1em; text-align: left; }
.typecho-turnstile[data-typecho-turnstile-pending] {
  position: fixed;
  top: 0;
  left: -10000px;
}
.typecho-turnstile-widget { display: inline-block; min-height: 65px; }
.typecho-turnstile-status:empty { display: none; }
.typecho-turnstile-status { margin: 6px 0 0; text-align: left; }
</style><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>`;
  const sitekey = escapeAttr(config.sitekey);
  const inputAttr = escapeAttr(config.input);
  const themeAttr = escapeAttr(config.theme);
  const sizeAttr = escapeAttr(config.size);
  const appearanceAttr = escapeAttr(config.appearance);
  const onDemand = config.appearance === 'execute' || config.appearance === 'interaction-only';
  const executionAttr = escapeAttr(onDemand ? 'execute' : 'render');
  const input = JSON.stringify(config.input);
  const targetFormSelector = formId === 'comment-form'
    ? '.warm-comment-form,[data-comment-form],#comment-form,form[action$="/api/comment"]'
    : `#${formId}`;
  const targetFormSelectorValue = JSON.stringify(targetFormSelector);
  const containerIdValue = `typecho-turnstile-${formId}`;
  const containerIdAttr = escapeAttr(containerIdValue);
  const statusIdAttr = escapeAttr(`${containerIdValue}-status`);
  const statusHtml = formId === 'comment-form'
    ? ''
    : `<p id="${statusIdAttr}" class="typecho-turnstile-status" aria-live="polite"></p>`;

  const widgetHtml = `<div class="typecho-turnstile" data-typecho-turnstile-pending>
<div
  id="${containerIdAttr}"
  class="cf-turnstile typecho-turnstile-widget"
  data-sitekey="${sitekey}"
  data-theme="${themeAttr}"
  data-size="${sizeAttr}"
  data-appearance="${appearanceAttr}"
  data-execution="${executionAttr}"
  data-response-field="true"
  data-response-field-name="${inputAttr}"
  data-callback="__typechoTurnstileSubmit"
  data-error-callback="__typechoTurnstileResetPending"
  data-timeout-callback="__typechoTurnstileResetPending"
></div>
${statusHtml}
</div>`;

  // archive:footer is rendered just before </body>. Move the widget into the
  // target form, including forms created later by API-backed themes.
  const placementHtml = `<script is:inline>
(function() {
  var formSelector = ${targetFormSelectorValue};
  var containerId = ${JSON.stringify(containerIdValue)};
  function renderWidget() {
    var container = document.getElementById(containerId);
    if (!container || !container.isConnected || !window.turnstile || typeof window.turnstile.render !== "function") return false;
    if (container.getAttribute("data-typecho-turnstile-widget-id") !== null) return true;
    try {
      var widgetId = window.turnstile.render(container, {
        sitekey: container.getAttribute("data-sitekey") || "",
        theme: container.getAttribute("data-theme") || "auto",
        size: container.getAttribute("data-size") || "normal",
        appearance: container.getAttribute("data-appearance") || "always",
        execution: container.getAttribute("data-execution") || "render",
        "response-field": true,
        "response-field-name": container.getAttribute("data-response-field-name") || "cf-turnstile-response",
        callback: window.__typechoTurnstileSubmit,
        "error-callback": window.__typechoTurnstileResetPending,
        "timeout-callback": window.__typechoTurnstileResetPending
      });
      if (widgetId === undefined || widgetId === null) return false;
      container.setAttribute("data-typecho-turnstile-widget-id", String(widgetId));
      return true;
    } catch (error) {
      console.error("[turnstile] Widget render failed:", error);
      return false;
    }
  }
  function queueRender() {
    window.__typechoTurnstileReady(renderWidget);
  }
  function placeWidget() {
    var form = document.querySelector(formSelector);
    var container = document.getElementById(containerId);
    if (!form || !container) return false;
    var widget = container.closest('.typecho-turnstile');
    if (!widget) return false;
    if (widget.parentNode === form) {
      widget.removeAttribute('data-typecho-turnstile-pending');
      queueRender();
      return true;
    }
    var anchor = form.classList.contains('warm-comment-form')
      ? form.querySelector('.warm-comment-form__actions')
      : form.querySelector('.submit');
    if (anchor && anchor.parentNode === form) {
      anchor.before(widget);
    } else {
      form.appendChild(widget);
    }
    widget.removeAttribute('data-typecho-turnstile-pending');
    queueRender();
    return true;
  }
  function watchForForm() {
    if (placeWidget() || !document.body) return;
    var observer = new MutationObserver(function() {
      if (placeWidget()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForForm, { once: true });
  } else {
    watchForForm();
  }
})();
</script>`;

  if (!onDemand) {
    return {
      headHtml,
      bodyHtml: widgetHtml + placementHtml,
    };
  }

  return {
    headHtml,
    bodyHtml: `${widgetHtml}${placementHtml}<script is:inline>
(function() {
  var inputName = ${input};
  var formSelector = ${targetFormSelectorValue};
  var containerId = ${JSON.stringify(containerIdValue)};

  function getTokenField(form) {
    return form.querySelector('input[name="' + inputName + '"]');
  }

  function hasToken(form) {
    var field = getTokenField(form);
    return !!(field && field.value);
  }

  function resetPending() {
    window.__typechoTurnstileResetPending("人机验证加载超时，请检查网络后重试");
  }

  function initTurnstile() {
    var form = document.querySelector(formSelector);
    if (!form || form.dataset.typechoTurnstileBound === "1") return !!form;
    form.dataset.typechoTurnstileBound = "1";
    form.addEventListener("submit", function(e) {
      if (hasToken(form)) return;
      e.preventDefault();
      var button = form.querySelector('[type="submit"]');
      if (button) button.disabled = true;
      window.__typechoTurnstileSetStatus(containerId, "正在加载人机验证，请稍候...", "loading");
      window.__typechoTurnstilePending = {
        form: form,
        inputName: inputName,
        containerId: containerId,
        button: button,
        timer: setTimeout(resetPending, 15000)
      };
      window.__typechoTurnstileReady(function() {
        window.__typechoTurnstileSetStatus(containerId, "请完成人机验证", "loading");
        var container = document.getElementById(containerId);
        var widgetId = container && container.getAttribute("data-typecho-turnstile-widget-id");
        if (!widgetId || !window.turnstile || typeof window.turnstile.execute !== "function") {
          window.__typechoTurnstileResetPending("人机验证加载失败，请刷新页面后重试");
          return;
        }
        window.turnstile.execute(widgetId);
      });
    });
    return true;
  }
  function watchForForm() {
    if (initTurnstile() || !document.body) return;
    var observer = new MutationObserver(function() {
      if (initTurnstile()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForForm, { once: true });
  } else {
    watchForForm();
  }
})();
</script>`,
  };
}

async function checkTurnstile(config: TurnstileConfig, extra: VerificationExtra): Promise<string | null> {
  if (!config.sitekey || !config.secret) {
    return null;
  }
  if (extra.skipIfLoggedIn && extra.isLoggedIn) {
    return null;
  }

  const token = extra.formData?.get(config.input)?.toString() || '';
  if (!token) {
    return '请完成人机验证';
  }

  try {
    const result = await verifyTurnstile(token, config.secret, getClientIp(extra.request));
    return result.success ? null : '人机验证失败';
  } catch (err) {
    console.error('[turnstile] Verification API error:', err);
    return '验证服务异常，请稍后重试';
  }
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  addHook('csp:directives', pluginId, (directives: CspDirectives) => {
    addCspSource(directives, 'script-src', [
      'https://challenges.cloudflare.com',
      'https://static.cloudflareinsights.com',
    ]);
    addCspSource(directives, 'connect-src', [
      'https://challenges.cloudflare.com',
      'https://static.cloudflareinsights.com',
      'https://cloudflareinsights.com',
    ]);
    addCspSource(directives, 'frame-src', ['https://challenges.cloudflare.com']);
    return directives;
  });

  addHook('feedback:comment', pluginId, async (commentData: MutableContext, extra?: VerificationExtra) => {
    if (!extra?.options) return commentData;

    const config = getPluginConfig(extra.options);
    const msg = await checkTurnstile(config, { ...extra, skipIfLoggedIn: true });
    if (msg) {
      commentData._rejected = msg;
    }
    return commentData;
  });

  addHook('archive:header', pluginId, (headHtml: string, extra?: { options?: Record<string, unknown>; pageContext?: { hasComments?: boolean } }) => {
    if (!extra?.pageContext?.hasComments) return headHtml;
    const snippet = buildSnippet(extra?.options, 'comment-form');
    return headHtml + snippet.headHtml;
  });

  addHook('archive:footer', pluginId, (bodyHtml: string, extra?: { options?: Record<string, unknown>; pageContext?: { hasComments?: boolean } }) => {
    if (!extra?.pageContext?.hasComments) return bodyHtml;
    const snippet = buildSnippet(extra?.options, 'comment-form');
    return bodyHtml + snippet.bodyHtml;
  });

  addHook('admin:loginHead', pluginId, (headHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const snippet = buildSnippet(extra?.options, 'login-form');
    return headHtml + snippet.headHtml;
  });

  addHook('admin:loginForm', pluginId, (formHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const snippet = buildSnippet(extra?.options, 'login-form');
    return formHtml + snippet.bodyHtml;
  });

  addHook('user:login', pluginId, async (loginContext: MutableContext, extra?: VerificationExtra) => {
    if (!extra?.options) return loginContext;

    const config = getPluginConfig(extra.options);
    const msg = await checkTurnstile(config, extra);
    if (msg) {
      loginContext._rejected = msg;
    }
    return loginContext;
  });
}

/**
 * @deprecated Use archive:header / archive:footer hooks instead.
 * Kept for backward compatibility.
 */
export function getClientSnippet(options?: Record<string, unknown>): { headHtml: string; bodyHtml: string } {
  return buildSnippet(options, 'comment-form');
}
