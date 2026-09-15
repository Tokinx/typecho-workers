import { describe, expect, it, afterEach } from 'vitest';
import { buildGravatarUrl, createGravatarHash, resolveGravatarUrl } from '@/lib/gravatar';
import { addHook, removePluginHooks, type HookContext } from '@/lib/plugin';

describe('gravatar helpers', () => {
  it('hashes trimmed lowercase email addresses with SHA-256', async () => {
    await expect(createGravatarHash(' MyEmailAddress@example.com ')).resolves.toBe(
      '84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee',
    );
  });

  it('builds avatar URLs with the email hash in the path', async () => {
    const url = await buildGravatarUrl(' MyEmailAddress@example.com ', {
      defaultImage: 'identicon',
      size: 40,
      rating: 'G',
    });

    expect(url).toBe(
      'https://www.gravatar.com/avatar/84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee?d=identicon&s=40&r=G',
    );
  });

  it('keeps the default avatar URL valid when no email exists', async () => {
    await expect(buildGravatarUrl('', { defaultImage: 'mp', size: 220 })).resolves.toBe(
      'https://www.gravatar.com/avatar/?d=mp&s=220',
    );
  });
});

describe('resolveGravatarUrl', () => {
  const pluginId = 'test-gravatar-cdn';

  afterEach(() => {
    removePluginHooks(pluginId);
  });

  it('returns the official Gravatar URL when no filter is active', async () => {
    const ctx: HookContext = { activatedPlugins: new Set() };
    const url = await resolveGravatarUrl(ctx, 'a@example.com', { size: 40 });
    expect(url).toBe(await buildGravatarUrl('a@example.com', { size: 40 }));
  });

  it('applies the gravatar:url filter when an activated plugin rewrites it', async () => {
    addHook('gravatar:url', pluginId, (url: string) => url.replace('www.gravatar.com', 'cdn.example.com'));
    const ctx: HookContext = { activatedPlugins: new Set([pluginId]) };
    const url = await resolveGravatarUrl(ctx, 'a@example.com', { size: 40 }, {
      options: { siteUrl: 'https://example.com' },
    });
    expect(url).toContain('https://cdn.example.com/avatar/');
    expect(url).not.toContain('www.gravatar.com');
  });

  it('keeps the original URL when the filter returns a non-string', async () => {
    addHook('gravatar:url', pluginId, () => ({ broken: true }));
    const ctx: HookContext = { activatedPlugins: new Set([pluginId]) };
    const official = await buildGravatarUrl('a@example.com', { size: 40 });
    await expect(resolveGravatarUrl(ctx, 'a@example.com', { size: 40 })).resolves.toBe(official);
  });
});
