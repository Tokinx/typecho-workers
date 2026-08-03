import { describe, it, expect, vi } from 'vitest';
import { sendMail, type MailPayload, type MailContext, type MailResult } from '@/lib/mail';

// mock the short-circuit plugin runner — the mail module delegates to it
vi.mock('@/lib/plugin', () => ({
  applyFilterUntil: vi.fn(),
}));

import { applyFilterUntil } from '@/lib/plugin';

function makeCtx(overrides: Partial<Record<string, unknown>> = {}): { ctx: MailContext; pluginCtx: any } {
  return {
    pluginCtx: { activatedPlugins: new Set<string>() },
    ctx: {
      options: { ...overrides },
      reason: 'test',
    },
  };
}

const payload: MailPayload = {
  to: 'user@example.com',
  subject: 'Test',
  html: '<p>Hello</p>',
};

describe('sendMail', () => {
  // Enablement and sender-address gates are owned by the adapter plugin —
  // sendMail() itself delegates unconditionally and degrades gracefully.
  it('returns no-adapter when no plugin handles mail:send', async () => {
    const { pluginCtx, ctx } = makeCtx();
    vi.mocked(applyFilterUntil).mockResolvedValue(null);
    const r = await sendMail(pluginCtx, payload, ctx);
    expect(r.sent).toBe(false);
    expect(r.error).toBe('no-adapter');
  });

  it('returns sent:true when a plugin handles successfully', async () => {
    const { pluginCtx, ctx } = makeCtx();
    const adapterResult: MailResult = { sent: true, provider: 'resend' };
    vi.mocked(applyFilterUntil).mockResolvedValue(adapterResult);
    const r = await sendMail(pluginCtx, payload, ctx);
    expect(r.sent).toBe(true);
    expect(r.provider).toBe('resend');
  });

  it('passes payload and ctx to the plugin filter', async () => {
    const { pluginCtx, ctx } = makeCtx();
    vi.mocked(applyFilterUntil).mockResolvedValue(null);
    await sendMail(pluginCtx, { ...payload, replyTo: 'noreply@x.com' }, ctx);
    expect(applyFilterUntil).toHaveBeenCalledWith(
      pluginCtx,
      'mail:send',
      null,
      expect.any(Function),
      expect.objectContaining({
        payload: expect.objectContaining({ replyTo: 'noreply@x.com' }),
        ctx: expect.objectContaining({ reason: 'test' }),
      }),
    );
  });

  it('forwards error from failing adapter', async () => {
    const { pluginCtx, ctx } = makeCtx();
    vi.mocked(applyFilterUntil).mockResolvedValue({ sent: false, provider: 'resend', error: 'rate-limited' });
    const r = await sendMail(pluginCtx, payload, ctx);
    expect(r.sent).toBe(false);
    expect(r.error).toBe('rate-limited');
  });
});
