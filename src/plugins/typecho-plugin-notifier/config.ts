import { SECRET_PLACEHOLDER } from '@/lib/plugin-config-secrets';

/**
 * Notifier plugin configuration: loading, normalization, legacy migration
 * and channel-readiness checks.
 */

export const PLUGIN_ID = 'typecho-plugin-notifier';

/** Legacy Mailer plugin id — config stored under this key is read as a fallback. */
export const LEGACY_PLUGIN_ID = 'typecho-plugin-mailer';

export const VALID_PROVIDERS = ['resend', 'mailersend', 'brevo', 'plunk', 'maileroo'] as const;
export type MailProvider = (typeof VALID_PROVIDERS)[number];

// ── Template defaults ────────────────────────────────────────────────────────

// One shared mail template covers both admin comment notifications and
// reply-to-commenter notifications ("new message" framing fits either).
export const DEFAULT_MAIL_SUBJECT = '[{site.name}] 新消息通知';
export const DEFAULT_MAIL_BODY =
  '<p>{site.name} 有新动态：</p>'
  + '<p>{reply.author}：</p>'
  + '<blockquote>{reply.content}</blockquote>'
  + '<p><a href="{post.url}">查看详情</a></p>';
// WebHook content is one JSON payload template per category.
// Placeholders live inside quotes; \n stays a JSON escape until send time.
export const DEFAULT_SYSTEM_WEBHOOK_PAYLOAD = `{
  "event": "system",
  "site": "{site.name}",
  "subject": "{subject}",
  "content": "{text}",
  "reason": "{reason}",
  "url": "{site.url}"
}`;
export const DEFAULT_COMMENT_WEBHOOK_PAYLOAD = `{
  "event": "comment",
  "site": "{site.name}",
  "post": {
    "title": "{post.title}",
    "url": "{post.url}"
  },
  "author": "{reply.author}",
  "mail": "{reply.mail}",
  "content": "{reply.content}"
}`;

// ── Config shape ─────────────────────────────────────────────────────────────

export interface NotifierConfig {
  // 通知方式（分类 × 渠道）；插件已激活即视为可发送，无总开关
  systemEmail: boolean;
  systemWebhook: boolean;
  commentEmail: boolean;
  commentWebhook: boolean;
  replyEmail: boolean;
  // 邮件渠道
  emailProvider: MailProvider;
  emailApiKey: string;
  emailFrom: string;
  emailFromName: string;
  // WebHook 渠道
  webhookUrl: string;
  webhookToken: string;
  // 模板（分类 × 渠道；邮件共用一套「新消息」模板，系统通知邮件无模板）
  mailSubject: string;
  mailBody: string;
  systemWebhookPayload: string;
  commentWebhookPayload: string;
}

/** Parse "1"/"true"/true → true, "0"/"false"/false → false, else fallback. */
export function parseBoolean(value: unknown, fallback = false): boolean {
  if (value === true) return true;
  if (value === false) return false;
  const s = String(value ?? '');
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return fallback;
}

/** Loose RFC 5322 addr-spec check. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

export function isMailProvider(value: unknown): value is MailProvider {
  return VALID_PROVIDERS.includes(value as MailProvider);
}

function str(value: unknown): string {
  return String(value ?? '').trim();
}

export function isValidWebhookUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

const TEMPLATE_SET = {
  mailSubject: DEFAULT_MAIL_SUBJECT,
  mailBody: DEFAULT_MAIL_BODY,
  systemWebhookPayload: DEFAULT_SYSTEM_WEBHOOK_PAYLOAD,
  commentWebhookPayload: DEFAULT_COMMENT_WEBHOOK_PAYLOAD,
} as const;

function templateOf(key: keyof typeof TEMPLATE_SET, raw: Record<string, unknown>): string {
  const value = raw[key];
  return value === undefined || value === null ? TEMPLATE_SET[key] : String(value);
}

/**
 * Unified mail template with 2.1 fallback: prefer the new key, then the
 * stored per-category keys (新评论 first), else the default.
 */
function mailTemplateOf(key: 'mailSubject' | 'mailBody', legacyKeys: readonly string[], raw: Record<string, unknown>): string {
  if (raw[key] !== undefined && raw[key] !== null) return String(raw[key]);
  for (const legacyKey of legacyKeys) {
    if (raw[legacyKey] !== undefined && raw[legacyKey] !== null) return String(raw[legacyKey]);
  }
  return TEMPLATE_SET[key];
}

/**
 * Build a normalized config from raw (possibly partial) settings.
 * Legacy `enabled: false` forces every category toggle off so old installs
 * that only flipped the master switch keep the same "nothing sends" behavior.
 */
export function normalizeConfig(raw: Record<string, unknown> | null | undefined): NotifierConfig {
  const src = raw || {};
  const legacyMasterOff = 'enabled' in src && !parseBoolean(src.enabled, true);
  const toggle = (key: string): boolean =>
    legacyMasterOff ? false : parseBoolean(src[key], false);
  return {
    systemEmail: toggle('systemEmail'),
    systemWebhook: toggle('systemWebhook'),
    commentEmail: toggle('commentEmail'),
    commentWebhook: toggle('commentWebhook'),
    replyEmail: toggle('replyEmail'),
    emailProvider: isMailProvider(src.emailProvider) ? src.emailProvider : 'resend',
    emailApiKey: str(src.emailApiKey),
    emailFrom: str(src.emailFrom),
    emailFromName: str(src.emailFromName),
    webhookUrl: str(src.webhookUrl),
    webhookToken: str(src.webhookToken),
    mailSubject: mailTemplateOf('mailSubject', ['commentSubject', 'replySubject'], src),
    mailBody: mailTemplateOf('mailBody', ['commentBody', 'replyBody'], src),
    systemWebhookPayload: templateOf('systemWebhookPayload', src),
    commentWebhookPayload: templateOf('commentWebhookPayload', src),
  };
}

/**
 * Map a legacy Mailer (<=1.x) flat config onto the new field names.
 * Fields without a legacy equivalent stay absent so normalizeConfig fills
 * the defaults (all new toggles are off — explicit opt-in).
 */
function mapLegacyConfig(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    // Preserve legacy master switch so normalizeConfig can force toggles off.
    enabled: raw.enabled,
    commentEmail: raw.commentNotifyEnabled,
    replyEmail: raw.replyNotifyEnabled,
    emailProvider: raw.provider,
    emailApiKey: raw.apiKey,
    emailFrom: raw.from,
    emailFromName: raw.fromName,
    mailSubject: raw.subject,
    mailBody: raw.body,
  };
}

function readPluginOption(options: Record<string, unknown> | undefined, pluginId: string): Record<string, unknown> {
  try {
    return JSON.parse(String(options?.[`plugin:${pluginId}`] || '{}')) as Record<string, unknown>;
  } catch {
    // Invalid JSON — fall through to defaults
  }
  return {};
}

/** Read the plugin config from the request options map (merge defaults). */
export function loadConfig(options?: Record<string, unknown>): NotifierConfig {
  let raw = readPluginOption(options, PLUGIN_ID);
  if (Object.keys(raw).length === 0) {
    raw = mapLegacyConfig(readPluginOption(options, LEGACY_PLUGIN_ID));
  }
  return normalizeConfig(raw);
}

// ── Channel readiness (credentials only; plugin activation is the gate) ──────

/** Email channel is ready when the credentials + sender are valid. */
export function isEmailReady(config: NotifierConfig): boolean {
  return Boolean(config.emailApiKey) && isValidEmail(config.emailFrom);
}

export function isWebhookReady(config: NotifierConfig): boolean {
  return Boolean(config.webhookUrl) && isValidWebhookUrl(config.webhookUrl);
}

/** Describe why the email channel is not ready (for validation errors). */
export function emailInvalidReason(config: NotifierConfig): string | null {
  if (!config.emailApiKey) return '未填写邮件 API Key';
  if (!isValidEmail(config.emailFrom)) return '发件邮箱格式不正确';
  return null;
}

/** Serialize settings back to form values for beforeSave round-trip (drops legacy `enabled`). */
export function toFormValues(config: NotifierConfig): Record<string, string> {
  const bool = (v: boolean) => (v ? '1' : '0');
  return {
    systemEmail: bool(config.systemEmail),
    systemWebhook: bool(config.systemWebhook),
    commentEmail: bool(config.commentEmail),
    commentWebhook: bool(config.commentWebhook),
    replyEmail: bool(config.replyEmail),
    emailProvider: config.emailProvider,
    emailApiKey: config.emailApiKey,
    emailFrom: config.emailFrom,
    emailFromName: config.emailFromName,
    webhookUrl: config.webhookUrl,
    webhookToken: config.webhookToken,
    mailSubject: config.mailSubject,
    mailBody: config.mailBody,
    systemWebhookPayload: config.systemWebhookPayload,
    commentWebhookPayload: config.commentWebhookPayload,
  };
}

/** Password / token fields — placeholder on save must not wipe stored secrets. */
export const SECRET_FIELDS = ['emailApiKey', 'webhookToken'] as const;

export { SECRET_PLACEHOLDER };

export function maskSecretFormValues(values: Record<string, string>): Record<string, string> {
  const out = { ...values };
  for (const key of SECRET_FIELDS) {
    if (out[key]) out[key] = SECRET_PLACEHOLDER;
  }
  return out;
}

/**
 * Restore secrets when the client sends the unchanged placeholder.
 * Empty string clears the secret (user explicitly wiped the field).
 */
export function restoreSecretFormValues(
  incoming: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const key of SECRET_FIELDS) {
    if (out[key] === SECRET_PLACEHOLDER) {
      out[key] = previous[key] ?? '';
    }
  }
  return out;
}