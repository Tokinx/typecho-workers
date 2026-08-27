/**
 * Template rendering with placeholder substitution.
 * HTML body: user-provided values must be escaped before substitution.
 * Plain-text body: derived by stripping HTML from the rendered template.
 * WebHook payload: values must be JSON-escaped before substitution.
 */

import { escapeHtml } from 'typecho/plugin-sdk';

export type TemplateVars = Record<string, string | number | null | undefined>;

/** Placeholders shared by every comment notification template. */
export const TEMPLATE_PLACEHOLDERS = [
  '{site.name}', '{site.url}', '{site.description}',
  '{post.title}', '{post.url}',
  '{reply.author}', '{reply.content}', '{reply.mail}', '{reply.avatarUrl}',
  '{comment.author}', '{comment.content}', '{comment.mail}', '{comment.avatarUrl}',
] as const;

/** Extra placeholders available in system notification templates (mail:send events). */
export const SYSTEM_PLACEHOLDERS = [
  '{subject}', '{body}', '{text}', '{reason}', '{to}',
] as const;

/** Replace {placeholders}; unknown keys become empty strings. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Escape every value so the result is safe to embed in an HTML email. */
export function escapeVars(vars: TemplateVars): TemplateVars {
  const out: TemplateVars = {};
  for (const [key, value] of Object.entries(vars)) {
    out[key] = value === undefined || value === null ? value : escapeHtml(String(value));
  }
  return out;
}

/** Escape every value so the result is safe inside a JSON string literal. */
export function jsonEscapeVars(vars: TemplateVars): TemplateVars {
  const out: TemplateVars = {};
  for (const [key, value] of Object.entries(vars)) {
    out[key] = value === undefined || value === null ? value : jsonEscapeString(String(value));
  }
  return out;
}

function jsonEscapeString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u001f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Check that a WebHook payload template is structurally valid JSON.
 * Placeholders sit inside the user's own quotes, so a bare dummy token is
 * substituted before parsing — an unquoted placeholder makes JSON.parse fail.
 */
export function isValidJsonTemplate(template: string): boolean {
  try {
    JSON.parse(template.replace(/\{([a-zA-Z0-9_.]+)\}/g, 'x'));
    return true;
  } catch {
    return false;
  }
}

/** Derive a plain-text version from an HTML email body. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return withBreaks
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}