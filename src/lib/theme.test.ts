import { describe, expect, it } from 'vitest';
import {
  getActiveTheme,
  getThemeConfigDefinition,
  getThemeConfigDefaults,
  getThemeStylesheets,
  loadThemeConfig,
  parseThemeConfigFormData,
  registerTheme,
  getAvailableThemes,
  themeHasConfig,
  themeExists,
} from './theme';

describe('theme appearance configuration', () => {
  it('exposes the Warm theme configuration when no loader registry exists', () => {
    expect(themeExists('typecho-theme-warm')).toBe(true);
    expect(themeHasConfig('typecho-theme-warm')).toBe(true);
    expect(getThemeConfigDefaults('typecho-theme-warm').commentComponentLoadMode).toBe('manual');
  });

  it('merges saved settings over manifest defaults', () => {
    const values = loadThemeConfig({
      'theme:typecho-theme-warm': JSON.stringify({ githubUrl: 'https://github.com/example' }),
    }, 'typecho-theme-warm');
    expect(values.githubUrl).toBe('https://github.com/example');
    expect(values.commentInitialLoadMode).toBe('manual');
  });

  it('uses the shared Typecho form parser for multi-value fields', () => {
    const form = new FormData();
    form.append('sidebarBlock[]', 'ShowCategory');
    form.append('sidebarBlock[]', 'ShowArchive');
    form.set('logoUrl', 'https://example.com/logo.png');
    expect(parseThemeConfigFormData({
      logoUrl: { type: 'text', label: 'Logo' },
      sidebarBlock: {
        type: 'checkbox',
        label: 'Sidebar',
        options: { ShowCategory: 'Category', ShowArchive: 'Archive' },
      },
    }, form)).toEqual({
      logoUrl: 'https://example.com/logo.png',
      sidebarBlock: ['ShowCategory', 'ShowArchive'],
    });
  });

  it('keeps the default theme settings when a running registry predates its manifest config', () => {
    registerTheme('typecho-theme-warm', {
      id: 'typecho-theme-warm',
      name: 'Typecho Warm',
    }, '/themes/typecho-theme-warm/style.css');
    expect(themeHasConfig('typecho-theme-warm')).toBe(true);
    expect(getThemeConfigDefaults('typecho-theme-warm').githubUrl).toBe('');
    expect(getThemeConfigDefinition('typecho-theme-warm')?.commentInitialLoadMode.default).toBe('manual');
    expect(getActiveTheme('typecho-theme-warm').manifest.commentsMode).toBe('api');
    expect(getActiveTheme('typecho-theme-warm').manifest.publicHtml).toBe(true);
    expect(getAvailableThemes('typecho-theme-warm').find(theme => theme.id === 'typecho-theme-warm')?.isDefault).toBe(true);
  });

  it('appends the theme asset version to every stylesheet URL', () => {
    registerTheme('cache-busted-theme', {
      id: 'cache-busted-theme',
      name: 'Cache Busted',
      version: '2.0.0',
      assetVersion: 'a1b2c3d4',
      stylesheets: ['extra.css'],
    }, '/themes/cache-busted-theme/style.css');

    expect(getThemeStylesheets('cache-busted-theme')).toEqual([
      '/themes/cache-busted-theme/extra.css?v=a1b2c3d4',
      '/themes/cache-busted-theme/style.css?v=a1b2c3d4',
    ]);
  });
});
