/**
 * Notifier plugin configuration: loading, normalization and validation.
 */

export const PLUGIN_ID = 'typecho-plugin-notifier';

/** Legacy Mailer plugin id — config stored under this key is read as a fallback. */
export const LEGACY_PLUGIN_ID = 'typecho-plugin-mailer';

export const SECRET_PLACEHOLDER = '__PLUGIN_CONFIG_SECRET__';

export const DEFAULT_SUBJECT = '[{site.name}] 新的通知';
export const DEFAULT_BODY =
  '<p>{site.name} 有新动态：</p><p>《{post.title}》收到来自 {reply.author} 的新内容：</p>'
  + '<blockquote>{reply.content}</blockquote>'
  + '<p><a href="{post.url}">查看详情</a></p>';

export const VALID_PROVIDERS = ['resend', 'mailersend', 'brevo', 'plunk', 'maileroo'] as const;
export type MailProvider = (typeof VALID_PROVIDERS)[number];

export interface MailPluginConfig {
  enabled: boolean;
  provider: MailProvider;
  apiKey: string;
  from: string;
  fromName: string;
  commentNotifyEnabled: boolean;
  replyNotifyEnabled: boolean;
  subject: string;
  body: string;
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

/** Build a normalized config from raw (possibly partial) settings. */
export function normalizeConfig(raw: Record<string, unknown> | null | undefined): MailPluginConfig {
  const src = raw || {};
  return {
    enabled: parseBoolean(src.enabled, false),
    provider: isMailProvider(src.provider) ? src.provider : 'resend',
    apiKey: String(src.apiKey || '').trim(),
    from: String(src.from || '').trim(),
    fromName: String(src.fromName || '').trim(),
    commentNotifyEnabled: parseBoolean(src.commentNotifyEnabled, false),
    replyNotifyEnabled: parseBoolean(src.replyNotifyEnabled, true),
    subject: String(src.subject ?? DEFAULT_SUBJECT),
    body: String(src.body ?? DEFAULT_BODY),
  };
}

/** Read the plugin config from the request options map (merge defaults). */
export function loadConfig(options?: Record<string, unknown>): MailPluginConfig {
  let raw: Record<string, unknown> = readPluginOption(options, PLUGIN_ID);
  if (Object.keys(raw).length === 0) {
    // Legacy fallback: pre-2.0 Mailer config uses the same flat field names.
    raw = readPluginOption(options, LEGACY_PLUGIN_ID);
  }
  return normalizeConfig(raw);
}

function readPluginOption(options?: Record<string, unknown>, pluginId?: string): Record<string, unknown> {
  if (!pluginId) return {};
  try {
    return JSON.parse(String(options?.[`plugin:${pluginId}`] || '{}')) as Record<string, unknown>;
  } catch {
    // Invalid JSON — fall through to defaults
  }
  return {};
}

/** True when the transport adapter can actually deliver mail. */
export function isReady(config: MailPluginConfig): boolean {
  return config.enabled && Boolean(config.apiKey) && isValidEmail(config.from);
}

/** Serialize settings back to form values for beforeSave round-trip. */
export function toFormValues(config: MailPluginConfig): Record<string, string> {
  return {
    enabled: config.enabled ? '1' : '0',
    provider: config.provider,
    apiKey: config.apiKey,
    from: config.from,
    fromName: config.fromName,
    commentNotifyEnabled: config.commentNotifyEnabled ? '1' : '0',
    replyNotifyEnabled: config.replyNotifyEnabled ? '1' : '0',
    subject: config.subject,
    body: config.body,
  };
}
