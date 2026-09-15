/**
 * GitHub-style markdown alerts (`> [!NOTE]` / `> [!任意标题]` …).
 *
 * Applied as an HTML post-process so both `marked` (SSR) and HyperDown
 * (admin / plugin preview) produce the same alert markup.
 *
 * The text inside `[!…]` is shown as the alert title. Border accent
 * colors are only applied for NOTE / TIP / WARNING (case-insensitive).
 */

import { escapeHtml } from '@/lib/escape';

/** Labels that receive a colored left border (others keep the default). */
export const ALERT_COLOR_VARIANTS = ['note', 'tip', 'warning'] as const;
export type AlertColorVariant = (typeof ALERT_COLOR_VARIANTS)[number];

/** HyperDown injects empty `<span class="line" …>` markers for scroll sync. */
const LINE_SPAN_RE = /<span\b[^>]*\bclass=(["'])line\1[^>]*>\s*<\/span>/gi;
const MARKER_TAIL_RE = '(?:[ \\t]*<br\\s*\\/?>|[ \\t]*\\n|[ \\t]+)?';
/** Capture any non-empty label up to 64 chars (no nested `]`). */
const LABEL_CAPTURE = '([^\\]]{1,64}?)';
const HAS_ALERT_MARKER_RE = /\[![^\]]+\]/;

/**
 * Rewrite blockquotes that begin with `[!label]` into alert blockquotes
 * with the extracted label shown as a title.
 *
 * Non-alert blockquotes are left unchanged.
 */
export function transformGithubAlerts(html: string): string {
  if (!html || !HAS_ALERT_MARKER_RE.test(html)) {
    return html;
  }

  return html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (full, inner: string) => {
    const cleaned = String(inner).replace(LINE_SPAN_RE, '').trim();

    // marked: <p>[!label]\nbody</p>  (+ optional sibling blocks)
    const pMatch = cleaned.match(
      new RegExp(
        `^<p(?:\\s[^>]*)?>\\s*\\[!${LABEL_CAPTURE}\\]${MARKER_TAIL_RE}([\\s\\S]*?)<\\/p>([\\s\\S]*)$`,
        'i',
      ),
    );
    if (pMatch) {
      const label = pMatch[1].trim();
      if (!label) return full;
      const first = pMatch[2].trim();
      const rest = pMatch[3].trim();
      const body = [first ? `<p>${first}</p>` : '', rest].filter(Boolean).join('\n');
      return renderAlert(label, body);
    }

    // HyperDown: [!label]<br>body  (no wrapping <p>)
    const rawMatch = cleaned.match(
      new RegExp(`^\\[!${LABEL_CAPTURE}\\]${MARKER_TAIL_RE}([\\s\\S]*)$`, 'i'),
    );
    if (rawMatch) {
      const label = rawMatch[1].trim();
      if (!label) return full;
      return renderAlert(label, wrapAlertBody(rawMatch[2].trim()));
    }

    return full;
  });
}

function wrapAlertBody(body: string): string {
  if (!body) return '';
  if (/^<(?:p|div|ul|ol|pre|h[1-6]|table|blockquote)\b/i.test(body)) return body;
  return `<p>${body}</p>`;
}

export function alertColorVariant(label: string): AlertColorVariant | null {
  const key = label.trim().toLowerCase();
  if (key === 'note' || key === 'tip' || key === 'warning') return key;
  return null;
}

function renderAlert(label: string, body: string): string {
  const variant = alertColorVariant(label);
  const classes = variant
    ? `markdown-alert markdown-alert-${variant}`
    : 'markdown-alert';
  const safeLabel = escapeHtml(label);
  return (
    `<blockquote class="${classes}" data-alert="${safeLabel}">` +
    `<p class="markdown-alert-title">${safeLabel}</p>` +
    (body ? body : '') +
    `</blockquote>`
  );
}
