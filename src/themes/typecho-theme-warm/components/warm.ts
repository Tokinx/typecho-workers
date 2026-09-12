import type { ThemeBaseProps, ThemePostProps } from '@/lib/theme-props';
import { loadThemeConfig } from '@/lib/theme';
import { normalizeOptimizeParams } from '@/lib/image-transform';
import { formatDate } from '@/lib/content';

export const WARM_THEME_ID = 'typecho-theme-warm';

export type WarmSection = 'home' | 'articles' | 'notes' | 'about' | 'none';
export type WarmContinuousLoadMode = 'manual' | 'auto-2' | 'infinite';
export type WarmCommentComponentLoadMode = 'auto' | 'dwell' | 'manual';
export type WarmCommentInitialLoadMode = 'manual' | 'auto-first' | 'auto-2' | 'infinite';

export interface WarmSettings {
  githubUrl: string;
  socialUrl: string;
  email: string;
  continuousLoadMode: WarmContinuousLoadMode;
  commentComponentLoadMode: WarmCommentComponentLoadMode;
  commentInitialLoadMode: WarmCommentInitialLoadMode;
  /** Query params appended to same-origin upload URLs in content bodies (EdgeOne). */
  imageOptimizeParams: string;
  /** Query params appended to thumbnail URLs; falls back to imageOptimizeParams when empty. */
  thumbOptimizeParams: string;
}

export function warmSettings(options: ThemeBaseProps['options']): WarmSettings {
  const settings = loadThemeConfig(options, WARM_THEME_ID);
  const savedSettings = readSavedWarmSettings(options);
  const legacyCommentMode = savedSettings?.commentInitialLoadMode;
  const componentLoadMode = Object.prototype.hasOwnProperty.call(savedSettings || {}, 'commentComponentLoadMode')
    ? settings.commentComponentLoadMode
    : legacyCommentMode === 'dwell' || legacyCommentMode === 'dwell-auto-2'
      ? 'dwell'
      : settings.commentComponentLoadMode;
  const imageOptimizeParams = normalizeOptimizeParams(settings.imageOptimizeParams);
  return {
    githubUrl: safeExternalUrl(settings.githubUrl),
    socialUrl: safeExternalUrl(settings.socialUrl),
    email: safeEmail(settings.email),
    continuousLoadMode: normalizeContinuousLoadMode(settings.continuousLoadMode),
    commentComponentLoadMode: normalizeCommentComponentLoadMode(componentLoadMode),
    commentInitialLoadMode: normalizeCommentInitialLoadMode(settings.commentInitialLoadMode),
    imageOptimizeParams,
    thumbOptimizeParams: normalizeOptimizeParams(settings.thumbOptimizeParams) || imageOptimizeParams,
  };
}

function readSavedWarmSettings(options: ThemeBaseProps['options']): Record<string, unknown> | null {
  const raw = options?.[`theme:${WARM_THEME_ID}`];
  if (!raw) return null;
  try {
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function normalizeContinuousLoadMode(value: unknown): WarmContinuousLoadMode {
  if (value === 'auto-2') return 'auto-2';
  return value === 'infinite' ? value : 'manual';
}

export function normalizeCommentComponentLoadMode(value: unknown): WarmCommentComponentLoadMode {
  return value === 'dwell' || value === 'auto' ? value : 'manual';
}

export function normalizeCommentInitialLoadMode(value: unknown): WarmCommentInitialLoadMode {
  if (value === 'auto-2' || value === 'dwell-auto-2') return 'auto-2';
  if (value === 'infinite') return 'infinite';
  if (value === 'manual') return 'manual';
  if (value === 'auto-first' || value === 'dwell' || value === 'auto') return 'auto-first';
  return 'manual';
}

export function safeExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function safeEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function formatWarmDate(
  timestamp: number,
  format: string | boolean = 'Y-m-d',
  timezoneOffset = 28800,
  includeTime = false,
): string {
  let dateFormat = typeof format === 'boolean'
    ? format ? 'Y-m-d H:i' : 'Y-m-d'
    : format || 'Y-m-d';
  if (includeTime && !hasTimeFormat(dateFormat)) dateFormat += ' H:i';
  return formatDate(timestamp, dateFormat, timezoneOffset);
}

function hasTimeFormat(format: string): boolean {
  return /[HhGgisaA]/.test(format.replace(/\\./g, ''));
}

export function plainExcerpt(value: string, length = 150): string {
  const plain = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > length ? `${plain.slice(0, length).trim()}...` : plain;
}

export function readingMinutes(html: string): number {
  const characters = html.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
  return Math.max(1, Math.ceil(characters / 420));
}

/** Hero summary: only Engine 智能摘要; empty when missing or password-locked. */
export function warmArticleSummary(
  post: Pick<ThemePostProps['post'], 'hasPassword' | 'passwordVerified'>,
  engineSummary: string | null | undefined,
): string {
  if (post.hasPassword && !post.passwordVerified) return '';
  return (engineSummary || '').trim();
}
