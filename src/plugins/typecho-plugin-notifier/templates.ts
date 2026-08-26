/**
 * Template rendering with placeholder substitution.
 * HTML body: user-provided values must be escaped before substitution.
 * Plain-text body: derived by stripping HTML from the rendered template.
 */

import { escapeHtml } from 'typecho/plugin-sdk';

export type TemplateVars = Record<string, string | number | null | undefined>;

export const TEMPLATE_PLACEHOLDERS = [
  '{site.name}', '{site.url}', '{site.description}',
  '{post.title}', '{post.url}',
  '{reply.author}', '{reply.content}', '{reply.mail}', '{reply.avatarUrl}',
  '{comment.author}', '{comment.content}', '{comment.mail}', '{comment.avatarUrl}',
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
