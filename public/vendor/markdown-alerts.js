/**
 * GitHub-style markdown alerts for HyperDown / admin preview.
 * Keep in sync with src/lib/markdown-alerts.ts.
 *
 * Transforms `> [!任意标题]` into a blockquote whose title is the
 * extracted label. Border accents: NOTE blue / TIP green / WARNING yellow.
 */
(function (root) {
  'use strict';

  var LINE_SPAN_RE = /<span\b[^>]*\bclass=(["'])line\1[^>]*>\s*<\/span>/gi;
  var MARKER_TAIL_RE = '(?:[ \\t]*<br\\s*\\/?>|[ \\t]*\\n|[ \\t]+)?';
  var LABEL_CAPTURE = '([^\\]]{1,64}?)';
  var HAS_ALERT_MARKER_RE = /\[![^\]]+\]/;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function wrapAlertBody(body) {
    if (!body) return '';
    if (/^<(?:p|div|ul|ol|pre|h[1-6]|table|blockquote)\b/i.test(body)) return body;
    return '<p>' + body + '</p>';
  }

  function alertColorVariant(label) {
    var key = String(label || '').trim().toLowerCase();
    if (key === 'note' || key === 'tip' || key === 'warning') return key;
    return null;
  }

  function renderAlert(label, body) {
    var variant = alertColorVariant(label);
    var classes = variant
      ? 'markdown-alert markdown-alert-' + variant
      : 'markdown-alert';
    var safeLabel = escapeHtml(label);
    return (
      '<blockquote class="' + classes + '" data-alert="' + safeLabel + '">' +
      '<p class="markdown-alert-title">' + safeLabel + '</p>' +
      (body || '') +
      '</blockquote>'
    );
  }

  function transformGithubAlerts(html) {
    if (!html || !HAS_ALERT_MARKER_RE.test(html)) {
      return html;
    }

    return String(html).replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, function (full, inner) {
      var cleaned = String(inner).replace(LINE_SPAN_RE, '').trim();

      var pRe = new RegExp(
        '^<p(?:\\s[^>]*)?>\\s*\\[!' + LABEL_CAPTURE + '\\]' + MARKER_TAIL_RE + '([\\s\\S]*?)<\\/p>([\\s\\S]*)$',
        'i'
      );
      var pMatch = cleaned.match(pRe);
      if (pMatch) {
        var pLabel = pMatch[1].trim();
        if (!pLabel) return full;
        var first = pMatch[2].trim();
        var rest = pMatch[3].trim();
        var pBody = [first ? '<p>' + first + '</p>' : '', rest].filter(Boolean).join('\n');
        return renderAlert(pLabel, pBody);
      }

      var rawRe = new RegExp(
        '^\\[!' + LABEL_CAPTURE + '\\]' + MARKER_TAIL_RE + '([\\s\\S]*)$',
        'i'
      );
      var rawMatch = cleaned.match(rawRe);
      if (rawMatch) {
        var rawLabel = rawMatch[1].trim();
        if (!rawLabel) return full;
        return renderAlert(rawLabel, wrapAlertBody(rawMatch[2].trim()));
      }

      return full;
    });
  }

  root.transformGithubAlerts = transformGithubAlerts;
})(typeof window !== 'undefined' ? window : this);
