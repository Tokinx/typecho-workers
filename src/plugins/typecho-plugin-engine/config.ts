/**
 * Engine plugin persisted settings (options key: plugin:typecho-plugin-engine).
 */
import { parsePluginOption } from 'typecho/plugin-sdk';

export const PLUGIN_ID = 'typecho-plugin-engine';
export const ENGINE_SUMMARY_FIELD = 'engine_summary';
export const SUMMARY_EXCERPT_LENGTH = 300;

export const SEARCH_SCOPES = ['default', 'title', 'title_summary'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const MASKED_SECRET = '********';

export interface EngineSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: string;
  maxTokens: string;
  /** "0" | "1" — generate AI summary on publish */
  autoSummary: string;
  /** default | title | title_summary */
  searchScope: SearchScope;
}

export const SETTINGS_DEFAULTS: EngineSettings = {
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/',
  apiKey: '',
  model: 'glm-4.7-flash',
  temperature: '0.7',
  maxTokens: '128000',
  autoSummary: '0',
  searchScope: 'default',
};

const MAX_OUTPUT_TOKENS = 512_000;

export function normalizeSearchScope(value: unknown): SearchScope {
  const scope = String(value || 'default').trim();
  return (SEARCH_SCOPES as readonly string[]).includes(scope)
    ? (scope as SearchScope)
    : 'default';
}

export function normalizeAutoSummary(value: unknown): string {
  if (value === true || value === 1 || value === '1') return '1';
  return '0';
}

export function normalizeSettings(settings?: Record<string, unknown>): EngineSettings {
  return {
    endpoint: String(settings?.endpoint || '').trim(),
    apiKey: String(settings?.apiKey || '').trim(),
    model: String(settings?.model || '').trim(),
    temperature: String(settings?.temperature || SETTINGS_DEFAULTS.temperature).trim(),
    maxTokens: String(settings?.maxTokens || SETTINGS_DEFAULTS.maxTokens).trim(),
    autoSummary: normalizeAutoSummary(settings?.autoSummary),
    searchScope: normalizeSearchScope(settings?.searchScope),
  };
}

export function loadSettings(options?: Record<string, unknown>): EngineSettings {
  const raw = parsePluginOption(options?.[`plugin:${PLUGIN_ID}`] as string | undefined);
  return {
    ...SETTINGS_DEFAULTS,
    ...normalizeSettings(raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}),
  };
}

/** Validate LLM + Engine settings for save. Does not hit the provider. */
export function validateSettings(settings?: Record<string, unknown>): EngineSettings {
  const config = normalizeSettings(settings);
  if (!config.endpoint || !config.apiKey || !config.model) {
    throw new Error('请填写接口地址、API Key 和模型名称');
  }

  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    throw new Error('接口地址格式不正确');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('接口地址必须使用 http 或 https');
  }

  const temperature = Number(config.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error('temperature 必须是 0 到 2 之间的数字');
  }

  const maxTokens = Number(config.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > MAX_OUTPUT_TOKENS) {
    throw new Error(`max tokens 必须是 128 到 ${MAX_OUTPUT_TOKENS} 之间的整数`);
  }

  return config;
}

export function toFormValues(config: EngineSettings): Record<string, string> {
  return {
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    autoSummary: config.autoSummary,
    searchScope: config.searchScope,
  };
}

export function maskSecretFormValues(values: Record<string, string>): Record<string, string> {
  return {
    ...values,
    apiKey: values.apiKey ? MASKED_SECRET : '',
  };
}

export function restoreSecretFormValues(
  incoming: Record<string, unknown>,
  previous: Record<string, string>,
): Record<string, unknown> {
  const next = { ...incoming };
  if (String(next.apiKey || '') === MASKED_SECRET) {
    next.apiKey = previous.apiKey || '';
  }
  return next;
}

export function isAutoSummaryEnabled(config: EngineSettings): boolean {
  return config.autoSummary === '1';
}
