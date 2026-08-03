/**
 * Mail abstraction layer.
 *
 * This module defines the interface for sending email from Typecho-CF.
 * No built-in SMTP / API adapter is provided — actual delivery MUST be
 * handled by a plugin that registers a `mail:send` filter hook.
 *
 * Enablement and sender-address decisions live inside the adapter plugin
 * (e.g. typecho-plugin-mailer); without an email plugin, sendMail() returns
 * { sent: false } and all email-dependent features (password reset,
 * comment notifications) will degrade gracefully.
 */

import { applyFilterUntil, type HookContext } from '@/lib/plugin';

export interface MailPayload {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface MailContext {
  request?: Request;
  options: Record<string, unknown>;
  reason: 'password-reset' | 'comment' | 'comment-reply' | 'test' | string;
}

export interface MailResult {
  sent: boolean;
  provider: string;
  error?: string;
}

/** Loose RFC 5322 addr-spec check — avoids typos, not a full validator. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/**
 * Send an email through any registered mail:send plugin.
 *
 * Returns a MailResult even when no adapter is installed — callers
 * should treat `sent === false` as a graceful degradation.
 */
export async function sendMail(
  pluginCtx: HookContext,
  payload: MailPayload,
  ctx: MailContext,
): Promise<MailResult> {
  // Try every registered mail:send handler (filter chain).
  // The first handler that returns `sent: true` wins.
  // Gate decisions (enabled / sender address) are owned by the adapter
  // plugin itself, not by global options.
  const result = await applyFilterUntil(
    pluginCtx,
    'mail:send',
    null,
    value => !!value && typeof value === 'object' && value.sent === true,
    { payload, ctx },
  );
  if (result && typeof result === 'object' && 'sent' in result) {
    return result as MailResult;
  }

  return { sent: false, provider: 'none', error: 'no-adapter' };
}
