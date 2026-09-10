import { describe, expect, it } from 'vitest';
import {
  loadSettings,
  isAutoSummaryEnabled,
  normalizeSearchProvider,
  normalizeSettings,
  validateSettings,
  maskSecretFormValues,
  restoreSecretFormValues,
  toFormValues,
  MASKED_SECRET,
  SETTINGS_DEFAULTS,
} from './config';

describe('engine config', () => {
  it('normalizes searchProvider and autoSummary', () => {
    expect(normalizeSearchProvider('google')).toBe('google');
    expect(normalizeSearchProvider('nope')).toBe('default');
    expect(normalizeSettings({ autoSummary: '1', searchProvider: 'bing' }).autoSummary).toBe('1');
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
      searchProvider: 'bing',
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

describe('legacy search settings', () => {
  it('ignores old searchScope instead of silently selecting an external engine', () => {
    expect(normalizeSettings({ searchScope: 'title_summary' }).searchProvider).toBe('default');
    expect(loadSettings({ 'plugin:typecho-plugin-engine': '{"searchScope":"title"}' }).searchProvider).toBe('default');
  });
  it('allows search-only configuration without an AI key', () => {
    expect(validateSettings({ ...SETTINGS_DEFAULTS, searchProvider: 'bing' }).searchProvider).toBe('bing');
    expect(() => validateSettings({ ...SETTINGS_DEFAULTS, autoSummary: '1' })).toThrow(/API Key/);
  });
});


it('keeps automatic AI generation off by default and requires AI credentials when enabled', () => {
  expect(isAutoSummaryEnabled(SETTINGS_DEFAULTS)).toBe(false);
  expect(() => validateSettings({ ...SETTINGS_DEFAULTS, autoSummary: '1' })).toThrow(/API Key/);
  expect(isAutoSummaryEnabled(validateSettings({ ...SETTINGS_DEFAULTS, apiKey: 'key', autoSummary: '1' }))).toBe(true);
});
