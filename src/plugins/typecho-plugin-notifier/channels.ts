/**
 * Notification channel adapters — every channel is a plain HTTP POST:
 * Email (5 providers) and WebHook share one postJson engine; they differ
 * only in URL construction, required fields and response checks.
 * Works on Cloudflare Workers out of the box.
 */

import { fetchWithTimeout } from 'typecho/plugin-sdk';
import type { MailProvider } from './config';

export interface EmailPayload {
  to: string;
  toName?: string;
  fromName?: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface ChannelResult {
  sent: boolean;
  channel: string;
  error?: string;
}

const SEND_TIMEOUT_MS = 15_000;

const PROVIDER_LABELS: Record<MailProvider, string> = {
  resend: 'Resend',
  mailersend: 'MailerSend',
  brevo: 'Brevo',
  plunk: 'Plunk',
  maileroo: 'Maileroo',
};

interface SendPlan {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function buildPlan(provider: MailProvider, apiKey: string, from: string, payload: EmailPayload): SendPlan {
  const to: { email: string; name?: string } = { email: payload.to, ...(payload.toName ? { name: payload.toName } : {}) };
  const sender: { email: string; name?: string } = { email: from, ...(payload.fromName ? { name: payload.fromName } : {}) };

  switch (provider) {
    case 'resend':
      return {
        url: 'https://api.resend.com/emails',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: {
          from: payload.fromName ? `"${payload.fromName}" <${from}>` : from,
          to: [payload.to],
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          reply_to: payload.replyTo,
        },
      };
    case 'mailersend':
      return {
        url: 'https://api.mailersend.com/v1/email',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: {
          from: sender,
          to: [to],
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          reply_to: payload.replyTo,
        },
      };
    case 'brevo':
      return {
        url: 'https://api.brevo.com/v3/smtp/email',
        headers: { 'api-key': apiKey },
        body: {
          sender,
          to: [to],
          subject: payload.subject,
          htmlContent: payload.html,
          textContent: payload.text,
          replyTo: payload.replyTo ? sender : undefined,
        },
      };
    case 'plunk':
      return {
        url: 'https://api.useplunk.com/v1/email/send',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: {
          from: payload.fromName ? { name: payload.fromName, email: from } : from,
          to: payload.to,
          subject: payload.subject,
          body: payload.html,
          reply_to: payload.replyTo,
        },
      };
    case 'maileroo':
      return {
        url: 'https://smtp.maileroo.com/api/v2/emails',
        headers: { 'X-Api-Key': apiKey },
        body: {
          from: { address: from, ...(payload.fromName ? { display_name: payload.fromName } : {}) },
          to: [{ address: payload.to }],
          subject: payload.subject,
          html: payload.html,
          plain: payload.text,
          reply_to: payload.replyTo ? [{ address: payload.replyTo }] : undefined,
        },
      };
  }
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as Record<string, unknown> | null;
    if (!data) return `HTTP ${response.status}`;
    const msg =
      data.message ?? data.description ?? data.error ?? data.errors ?? data.reason ?? data.detail
      ?? (data.data && typeof data.data === 'object' && 'message' in data.data ? String((data.data as any).message) : undefined);
    if (msg) {
      const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
      return `HTTP ${response.status}: ${text.slice(0, 300)}`;
    }
  } catch {
    // Not JSON — fall through
  }
  return `HTTP ${response.status}`;
}

/** POST a JSON body to url. Never throws — always resolves to a ChannelResult. */
async function postJson(url: string, headers: Record<string, string>, body: unknown, channel: string): Promise<ChannelResult> {
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }, SEND_TIMEOUT_MS, '请求渠道 API 超时');
    if (response.ok) {
      return { sent: true, channel };
    }
    const error = await extractErrorMessage(response);
    return { sent: false, channel, error };
  } catch (err) {
    return {
      sent: false,
      channel,
      error: err instanceof Error ? err.message : '网络请求失败',
    };
  }
}

/** Send an email through the configured provider. */
export async function sendEmail(
  provider: MailProvider,
  apiKey: string,
  from: string,
  payload: EmailPayload,
): Promise<ChannelResult> {
  const plan = buildPlan(provider, apiKey, from, payload);
  return postJson(plan.url, plan.headers, plan.body, PROVIDER_LABELS[provider]);
}

/** POST a rendered JSON payload to a user-configured webhook. */
export async function sendWebhook(
  url: string,
  token: string,
  payloadJson: string,
): Promise<ChannelResult> {
  let payload: string;
  try {
    // Guard against placeholders rendered outside JSON quotes.
    payload = JSON.stringify(JSON.parse(payloadJson));
  } catch {
    return { sent: false, channel: 'WebHook', error: '渲染后的 payload 不是合法 JSON（占位符需放在双引号内）' };
  }
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return postJson(url, headers, payload, 'WebHook');
}