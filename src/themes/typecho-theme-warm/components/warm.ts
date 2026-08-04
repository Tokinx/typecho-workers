import type { ThemeBaseProps } from '@/lib/theme-props';
import { loadThemeConfig } from '@/lib/theme';

export const WARM_THEME_ID = 'typecho-theme-warm';

export type WarmSection = 'home' | 'articles' | 'notes' | 'about' | 'none';

export interface WarmSettings {
  githubUrl: string;
  socialUrl: string;
  email: string;
}

export function warmSettings(options: ThemeBaseProps['options']): WarmSettings {
  const settings = loadThemeConfig(options, WARM_THEME_ID);
  return {
    githubUrl: safeExternalUrl(settings.githubUrl),
    socialUrl: safeExternalUrl(settings.socialUrl),
    email: safeEmail(settings.email),
  };
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

export function formatWarmDate(timestamp: number, includeTime = false): string {
  const date = new Date(timestamp * 1000);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: includeTime ? '2-digit' : undefined,
    minute: includeTime ? '2-digit' : undefined,
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return includeTime
    ? `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`
    : `${values.year}.${values.month}.${values.day}`;
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
