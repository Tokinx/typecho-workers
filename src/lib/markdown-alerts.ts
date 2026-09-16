/**
 * GitHub-style markdown alerts (`> [!NOTE]` / `> [!任意标题]` …).
 *
 * Applied as an HTML post-process so both `marked` (SSR) and HyperDown
 * (admin / plugin preview) produce the same alert markup.
 *
 * The text inside `[!…]` is shown as the alert title. Border accent
 * colors are only applied for NOTE / TIP / WARNING (case-insensitive).
 *
 * HyperDown with `enableLine(true)` merges consecutive `>` blocks into one
 * `<blockquote>` with multiple `<p>` children — those are split here so
 * each `[!label]` paragraph becomes its own alert.
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
const PARAGRAPH_RE = /<p\b[^>]*>[\s\S]*?<\/p>/gi;

/**
 * Rewrite blockquotes that begin with (or contain) `[!label]` into alert
 * blockquotes with the extracted label shown as a title.
 *
 * Non-alert blockquotes are left unchanged.
 */
export function transformGithubAlerts(html: string): string {
  if (!html || !HAS_ALERT_MARKER_RE.test(html)) {
    return html;
  }

  return html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_full, inner: string) => {
    const cleaned = String(inner).replace(LINE_SPAN_RE, '').trim();
    if (!HAS_ALERT_MARKER_RE.test(cleaned)) {
      return `<blockquote>${inner}</blockquote>`;
    }

    // HyperDown line-mode: several consecutive quotes merged into one
    // blockquote with multiple <p> children. Split per paragraph.
    const paragraphs = cleaned.match(PARAGRAPH_RE);
    if (paragraphs && paragraphs.length > 0) {
      return splitMergedBlockquote(cleaned, paragraphs);
    }

    // HyperDown single alert without a wrapping <p>: [!label]<br>body
    const rawMatch = cleaned.match(
      new RegExp(`^\\[!${LABEL_CAPTURE}\\]${MARKER_TAIL_RE}([\\s\\S]*)$`, 'i'),
    );
    if (rawMatch) {
      const label = rawMatch[1].trim();
      if (label) return renderAlert(label, wrapAlertBody(rawMatch[2].trim()));
    }

    return `<blockquote>${inner}</blockquote>`;
  });
}

/**
 * Turn a merged HyperDown / marked blockquote into a sequence of normal
 * quotes and alert quotes, keyed off paragraphs that start with `[!label]`.
 */
function splitMergedBlockquote(cleaned: string, paragraphs: string[]): string {
  const alertParaRe = new RegExp(
    `^<p(?:\\s[^>]*)?>\\s*\\[!${LABEL_CAPTURE}\\]${MARKER_TAIL_RE}([\\s\\S]*?)<\\/p>$`,
    'i',
  );

  type Segment =
    | { kind: 'quote'; html: string }
    | { kind: 'alert'; label: string; body: string };

  const segments: Segment[] = [];
  let cursor = 0;

  for (const para of paragraphs) {
    const index = cleaned.indexOf(para, cursor);
    if (index === -1) continue;
    const before = cleaned.slice(cursor, index).trim();
    if (before) pushQuote(segments, before);
    cursor = index + para.length;

    const match = para.match(alertParaRe);
    if (match) {
      const label = match[1].trim();
      if (label) {
        const body = match[2].trim();
        segments.push({ kind: 'alert', label, body: body ? `<p>${body}</p>` : '' });
        continue;
      }
    }
    pushQuote(segments, para);
  }

  const after = cleaned.slice(cursor).trim();
  if (after) pushQuote(segments, after);

  if (!segments.some(seg => seg.kind === 'alert')) {
    return `<blockquote>${cleaned}</blockquote>`;
  }

  return segments.map(seg => {
    if (seg.kind === 'alert') return renderAlert(seg.label, seg.body);
    return `<blockquote>${seg.html}</blockquote>`;
  }).join('');
}

function pushQuote(segments: Array<{ kind: 'quote'; html: string } | { kind: 'alert'; label: string; body: string }>, html: string): void {
  const last = segments[segments.length - 1];
  if (last?.kind === 'quote') {
    last.html += html;
    return;
  }
  segments.push({ kind: 'quote', html });
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
