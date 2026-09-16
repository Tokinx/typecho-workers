/**
 * GitHub-style markdown alerts for HyperDown / admin preview.
 * Keep in sync with src/lib/markdown-alerts.ts.
 *
 * HyperDown with enableLine(true) merges consecutive `>` blocks into one
 * <blockquote> with multiple <p> children — those are split so each
 * `[!label]` paragraph becomes its own alert.
 */
(function (root) {
  'use strict';

  var LINE_SPAN_RE = /<span\b[^>]*\bclass=(["'])line\1[^>]*>\s*<\/span>/gi;
  var MARKER_TAIL_RE = '(?:[ \\t]*<br\\s*\\/?>|[ \\t]*\\n|[ \\t]+)?';
  var LABEL_CAPTURE = '([^\\]]{1,64}?)';
  var HAS_ALERT_MARKER_RE = /\[![^\]]+\]/;
  var PARAGRAPH_RE = /<p\b[^>]*>[\s\S]*?<\/p>/gi;

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

  function pushQuote(segments, html) {
    var last = segments[segments.length - 1];
    if (last && last.kind === 'quote') {
      last.html += html;
      return;
    }
    segments.push({ kind: 'quote', html: html });
  }

  function splitMergedBlockquote(cleaned, paragraphs) {
    var alertParaRe = new RegExp(
      '^<p(?:\\s[^>]*)?>\\s*\\[!' + LABEL_CAPTURE + '\\]' + MARKER_TAIL_RE + '([\\s\\S]*?)<\\/p>$',
      'i'
    );
    var segments = [];
    var cursor = 0;
    var i;

    for (i = 0; i < paragraphs.length; i++) {
      var para = paragraphs[i];
      var index = cleaned.indexOf(para, cursor);
      if (index === -1) continue;
      var before = cleaned.slice(cursor, index).trim();
      if (before) pushQuote(segments, before);
      cursor = index + para.length;

      var match = para.match(alertParaRe);
      if (match) {
        var label = match[1].trim();
        if (label) {
          var body = match[2].trim();
          segments.push({ kind: 'alert', label: label, body: body ? '<p>' + body + '</p>' : '' });
          continue;
        }
      }
      pushQuote(segments, para);
    }

    var after = cleaned.slice(cursor).trim();
    if (after) pushQuote(segments, after);

    var hasAlert = false;
    for (i = 0; i < segments.length; i++) {
      if (segments[i].kind === 'alert') { hasAlert = true; break; }
    }
    if (!hasAlert) return '<blockquote>' + cleaned + '</blockquote>';

    return segments.map(function (seg) {
      if (seg.kind === 'alert') return renderAlert(seg.label, seg.body);
      return '<blockquote>' + seg.html + '</blockquote>';
    }).join('');
  }

  function transformGithubAlerts(html) {
    if (!html || !HAS_ALERT_MARKER_RE.test(html)) {
      return html;
    }

    return String(html).replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, function (_full, inner) {
      var cleaned = String(inner).replace(LINE_SPAN_RE, '').trim();
      if (!HAS_ALERT_MARKER_RE.test(cleaned)) {
        return '<blockquote>' + inner + '</blockquote>';
      }

      var paragraphs = cleaned.match(PARAGRAPH_RE);
      if (paragraphs && paragraphs.length > 0) {
        return splitMergedBlockquote(cleaned, paragraphs);
      }

      var rawRe = new RegExp(
        '^\\[!' + LABEL_CAPTURE + '\\]' + MARKER_TAIL_RE + '([\\s\\S]*)$',
        'i'
      );
      var rawMatch = cleaned.match(rawRe);
      if (rawMatch) {
        var rawLabel = rawMatch[1].trim();
        if (rawLabel) return renderAlert(rawLabel, wrapAlertBody(rawMatch[2].trim()));
      }

      return '<blockquote>' + inner + '</blockquote>';
    });
  }

  root.transformGithubAlerts = transformGithubAlerts;
})(typeof window !== 'undefined' ? window : this);
