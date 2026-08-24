import { escapeAttr, parsePluginOption } from 'typecho/plugin-sdk';
import type { PluginInitContext } from 'typecho/plugin-sdk';

type SpamMode = 'spam' | 'waiting' | 'discard';

interface AntiSpamConfig {
  mode: SpamMode;
  honeypot: boolean;
  timeCheck: boolean;
  minTime: number;
  maxTime: number;
  linkCheck: boolean;
  maxLinks: number;
}

interface MutableCommentData {
  _rejected?: string;
  [key: string]: unknown;
}

interface HookExtra {
  options?: Record<string, unknown>;
  request?: Request;
  formData?: FormData;
  isLoggedIn?: boolean;
}

const DEFAULTS: AntiSpamConfig = {
  mode: 'spam',
  honeypot: true,
  timeCheck: true,
  minTime: 3,
  maxTime: 86400,
  linkCheck: false,
  maxLinks: 2,
};

const VALID_MODES: readonly SpamMode[] = ['spam', 'waiting', 'discard'] as const;

function validateMode(raw: unknown): SpamMode {
  const s = String(raw || '');
  return (VALID_MODES as readonly string[]).includes(s) ? s as SpamMode : DEFAULTS.mode;
}

const PLUGIN_ID = 'typecho-plugin-antispam';
const HONEYPOT_FIELD = 'address_confirm';
const TOKEN_FIELD = 'antispam_token';
const SNIPPET_ID = 'typecho-antispam-fields';

function intOrDefault(raw: unknown, fallback: number, min: number): number {
  const n = parseInt(String(raw ?? ''));
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function getConfig(options?: Record<string, unknown>): AntiSpamConfig {
  const raw = parsePluginOption(options?.[`plugin:${PLUGIN_ID}`]);
  return {
    mode: validateMode(raw.mode),
    honeypot: raw.honeypot !== '0' && raw.honeypot !== false,
    timeCheck: raw.timeCheck !== '0' && raw.timeCheck !== false,
    minTime: intOrDefault(raw.minTime, DEFAULTS.minTime, 0),
    maxTime: intOrDefault(raw.maxTime, DEFAULTS.maxTime, 1),
    linkCheck: raw.linkCheck === '1' || raw.linkCheck === true,
    maxLinks: intOrDefault(raw.maxLinks, DEFAULTS.maxLinks, 0),
  };
}

function getSecret(options?: Record<string, unknown>): string {
  return String(options?.secret || '');
}

let cachedHmacKey: CryptoKey | null = null;
let cachedHmacSecret: string | null = null;

async function getHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedHmacKey && cachedHmacSecret === secret) return cachedHmacKey;
  const encoder = new TextEncoder();
  cachedHmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedHmacSecret = secret;
  return cachedHmacKey;
}

async function hmacSha256(message: string, secret: string): Promise<string> {
  const key = await getHmacKey(secret);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function encodeToken(timestamp: number, signature: string): string {
  return `${timestamp.toString(16)}:${signature}`;
}

function decodeToken(token: string): { timestamp: number; signature: string } | null {
  const idx = token.indexOf(':');
  if (idx === -1) return null;
  const tsHex = token.substring(0, idx);
  const sig = token.substring(idx + 1);
  const timestamp = parseInt(tsHex, 16);
  if (!Number.isFinite(timestamp) || timestamp < 0) return null;
  return { timestamp, signature: sig };
}

async function generateToken(
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const sig = await hmacSha256(String(now), secret);
  return encodeToken(now, sig);
}

async function validateToken(
  token: string,
  secret: string,
  minTime: number,
  maxTime: number,
): Promise<string | null> {
  if (!secret) return '站点安全密钥未配置';
  if (!token) return '安全令牌缺失';

  const decoded = decodeToken(token);
  if (!decoded) return '安全令牌无效';

  const expectedSig = await hmacSha256(String(decoded.timestamp), secret);
  if (decoded.signature !== expectedSig) return '安全令牌验证失败';

  const now = Math.floor(Date.now() / 1000);
  const age = now - decoded.timestamp;

  if (age < minTime) {
    return `提交过快，请${minTime - age}秒后再试`;
  }
  if (age > maxTime) {
    return '页面已过期，请刷新后重新提交';
  }

  return null;
}

function countLinks(text: string): number {
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const matches = text.match(urlPattern);
  return matches ? matches.length : 0;
}

function buildHoneypotHtml(): string {
  return `<div data-typecho-antispam-honeypot style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;" aria-hidden="true" tabindex="-1">
<label for="comment-${HONEYPOT_FIELD}">Address</label>
<input type="text" name="${escapeAttr(HONEYPOT_FIELD)}" id="comment-${escapeAttr(HONEYPOT_FIELD)}" tabindex="-1" autocomplete="off">
</div>`;
}

async function buildSnippet(options?: Record<string, unknown>): Promise<{ headHtml: string; bodyHtml: string }> {
  const config = getConfig(options);

  let bodyHtml = '';

  if (config.honeypot) {
    bodyHtml += buildHoneypotHtml();
  }

  if (!bodyHtml) return { headHtml: '', bodyHtml: '' };

  // The time token is not embedded in the page anymore: comments pages are
  // statically cached, so a token born at render time ages with the cache and
  // every reader of a long-lived copy submits an "expired" token. Instead the
  // token is issued by the comment list API (`comment:list` hook) when the
  // reader actually loads the comment component, and the component's JS writes
  // it into the form. Here we only carry the honeypot field into the form.
  const formSelector = '[data-comment-form],#comment-form,form[action$="/api/comment"]';
  const attachScript = `<script>
(() => {
  const source = document.getElementById(${JSON.stringify(SNIPPET_ID)});
  if (!source) return;
  const attachFields = () => {
    document.querySelectorAll(${JSON.stringify(formSelector)}).forEach(form => {
      if (!(form instanceof HTMLFormElement)) return;
      if (form.elements.namedItem(${JSON.stringify(HONEYPOT_FIELD)})) return;
      const field = source.querySelector('[name="' + ${JSON.stringify(HONEYPOT_FIELD)} + '"]');
      if (!field) return;
      form.appendChild(field.closest('[data-typecho-antispam-honeypot]') || field.cloneNode(true));
    });
  };
  attachFields();
  const observer = new MutationObserver(attachFields);
  observer.observe(document.body, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 60000);
})();
</script>`;

  return {
    headHtml: '',
    bodyHtml: `<div id="${SNIPPET_ID}" hidden>${bodyHtml}</div>${attachScript}`,
  };
}

function rejectComment(commentData: MutableCommentData, mode: SpamMode, reason: string): MutableCommentData {
  console.log(`[antispam] Spam detected (action=${mode}, reason=${reason})`);
  if (mode === 'discard') {
    commentData._rejected = reason;
  } else if (mode === 'waiting') {
    commentData.status = 'waiting';
  } else {
    commentData.status = 'spam';
  }
  return commentData;
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  addHook('feedback:comment', pluginId, async (
    commentData: MutableCommentData,
    extra?: HookExtra,
  ) => {
    if (!extra?.options) return commentData;

    const config = getConfig(extra.options);

    // Skip checks for logged-in users
    if (extra.isLoggedIn) return commentData;

    // 1. Honeypot check
    if (config.honeypot) {
      const honeypotValue = extra.formData?.get(HONEYPOT_FIELD)?.toString() || '';
      if (honeypotValue) {
        return rejectComment(commentData, config.mode, '检测到垃圾评论特征');
      }
    }

    // 2. Time check
    if (config.timeCheck) {
      const secret = getSecret(extra.options);
      if (secret) {
        const token = extra.formData?.get(TOKEN_FIELD)?.toString() || '';
        const error = await validateToken(token, secret, config.minTime, config.maxTime);
        if (error) {
          return rejectComment(commentData, config.mode, error);
        }
      }
    }

    // 3. Link check
    if (config.linkCheck) {
      const text = String(commentData.text || '');
      const links = countLinks(text);
      if (links > config.maxLinks) {
        const msg = config.maxLinks === 0
          ? '评论中不允许包含链接'
          : `评论中链接数量超过限制（最多${config.maxLinks}个）`;
        return rejectComment(commentData, config.mode, msg);
      }
    }

    return commentData;
  });

  // Issue the time token with the comment list API response instead of the
  // static page HTML. Pages are cached, so a render-time token would expire
  // with the cached copy; the reader fetching the comment component gets a
  // token that starts counting when they actually load the form.
  addHook('comment:list', pluginId, async (
    payload: unknown,
    extra?: { options?: Record<string, unknown> },
  ) => {
    if (!payload || typeof payload !== 'object') return payload;
    const config = getConfig(extra?.options);
    if (!config.timeCheck) return payload;
    const secret = getSecret(extra?.options);
    if (!secret) return payload;
    (payload as MutableCommentData).antispamToken = await generateToken(secret);
    return payload;
  });

  addHook('archive:footer', pluginId, async (
    bodyHtml: string,
    extra?: { options?: Record<string, unknown>; pageContext?: { hasComments?: boolean } },
  ) => {
    if (!extra?.pageContext?.hasComments) return bodyHtml;
    const snippet = await buildSnippet(extra?.options);
    return bodyHtml + snippet.bodyHtml;
  });
}
