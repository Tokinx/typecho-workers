import { describe, expect, it } from 'vitest';
import {
  normalizeSearchScope,
  normalizeSettings,
  validateSettings,
  maskSecretFormValues,
  restoreSecretFormValues,
  toFormValues,
  MASKED_SECRET,
  SETTINGS_DEFAULTS,
} from '@/plugins/typecho-plugin-engine/config';
import { resolveSearchScope } from '@/lib/search-scope';

describe('engine config', () => {
  it('normalizes searchScope and autoSummary', () => {
    expect(normalizeSearchScope('title_summary')).toBe('title_summary');
    expect(normalizeSearchScope('nope')).toBe('default');
    expect(normalizeSettings({ autoSummary: '1', searchScope: 'title' }).autoSummary).toBe('1');
    expect(normalizeSettings({ autoSummary: true }).autoSummary).toBe('1');
    expect(normalizeSettings({}).autoSummary).toBe('0');
  });

  it('validates LLM settings', () => {
    expect(() => validateSettings({
      endpoint: 'https://example.com/v1/',
      apiKey: 'k',
      model: 'm',
      temperature: '0.5',
      maxTokens: '1024',
      autoSummary: '1',
      searchScope: 'title',
    })).not.toThrow();

    expect(() => validateSettings({
      ...SETTINGS_DEFAULTS,
      endpoint: '',
      apiKey: 'k',
      model: 'm',
    })).toThrow(/接口地址/);
  });

  it('masks and restores apiKey', () => {
    const masked = maskSecretFormValues(toFormValues({
      ...SETTINGS_DEFAULTS,
      apiKey: 'secret-key',
    }));
    expect(masked.apiKey).toBe(MASKED_SECRET);
    const restored = restoreSecretFormValues(
      { ...masked, model: 'new-model' },
      { ...masked, apiKey: 'secret-key' },
    );
    expect(restored.apiKey).toBe('secret-key');
    expect(restored.model).toBe('new-model');
  });
});

describe('resolveSearchScope', () => {
  it('falls back to default when Engine is inactive', () => {
    expect(resolveSearchScope({
      [`plugin:typecho-plugin-engine`]: JSON.stringify({ searchScope: 'title' }),
    }, new Set())).toBe('default');
  });

  it('reads scope from plugin config when active', () => {
    const options = {
      [`plugin:typecho-plugin-engine`]: JSON.stringify({ searchScope: 'title_summary' }),
    };
    expect(resolveSearchScope(options, new Set(['typecho-plugin-engine']))).toBe('title_summary');
    expect(resolveSearchScope({
      [`plugin:typecho-plugin-engine`]: JSON.stringify({ searchScope: 'title' }),
    }, ['typecho-plugin-engine'])).toBe('title');
  });
});
