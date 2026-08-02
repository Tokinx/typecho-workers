import { describe, expect, it } from 'vitest';
import {
  getActiveTheme,
  getThemeConfigDefinition,
  getThemeConfigDefaults,
  loadThemeConfig,
  parseThemeConfigFormData,
  registerTheme,
  themeHasConfig,
  themeExists,
} from './theme';

describe('theme appearance configuration', () => {
  it('exposes the built-in theme configuration when no loader registry exists', () => {
    expect(themeExists('typecho-theme-minimal')).toBe(true);
    expect(themeHasConfig('typecho-theme-minimal')).toBe(true);
    expect(getThemeConfigDefaults('typecho-theme-minimal').sidebarBlock).toContain('ShowArchive');
  });

  it('merges saved settings over manifest defaults', () => {
    const values = loadThemeConfig({
      'theme:typecho-theme-minimal': JSON.stringify({ logoUrl: 'https://example.com/logo.png' }),
    }, 'typecho-theme-minimal');
    expect(values.logoUrl).toBe('https://example.com/logo.png');
    expect(values.sidebarBlock).toContain('ShowRecentPosts');
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
    registerTheme('typecho-theme-minimal', {
      id: 'typecho-theme-minimal',
      name: 'Typecho Minimal',
    }, '/themes/typecho-theme-minimal/style.css');
    expect(themeHasConfig('typecho-theme-minimal')).toBe(true);
    expect(getThemeConfigDefaults('typecho-theme-minimal').logoUrl).toBe('');
    expect(getThemeConfigDefinition('typecho-theme-minimal')?.sidebarBlock.multiline).toBe(true);
    expect(getActiveTheme('typecho-theme-minimal').manifest.screenshot).toBe('screenshot.png');
  });
});
