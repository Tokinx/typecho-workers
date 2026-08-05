import { getCookieValue, shouldUseSecureCookie } from '@/lib/auth';
import { normalizeHttpUrl } from '@/lib/url';

export const COMMENTER_COOKIE_NAMES = {
  author: '__typecho_remember_author',
  mail: '__typecho_remember_mail',
  url: '__typecho_remember_url',
} as const;

export const COMMENTER_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

export interface CommenterIdentity {
  author: string;
  mail: string;
  url: string;
}

export interface RememberedCommenter {
  identity: CommenterIdentity;
  invalidNames: string[];
}

function decodeCookieValue(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeAuthor(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function normalizeMail(value: string): string | null {
  const normalized = value.trim();
  return normalized && normalized.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized
    : null;
}

function normalizeUrl(value: string): string | null {
  const normalized = normalizeHttpUrl(value.trim());
  return normalized && normalized.length <= 500 ? normalized : null;
}

export function readRememberedCommenter(cookieHeader: string | null): RememberedCommenter {
  const identity: CommenterIdentity = { author: '', mail: '', url: '' };
  const invalidNames: string[] = [];
  const fields: Array<[keyof CommenterIdentity, keyof typeof COMMENTER_COOKIE_NAMES, (value: string) => string | null]> = [
    ['author', 'author', normalizeAuthor],
    ['mail', 'mail', normalizeMail],
    ['url', 'url', normalizeUrl],
  ];

  for (const [field, nameKey, normalize] of fields) {
    const raw = getCookieValue(cookieHeader, COMMENTER_COOKIE_NAMES[nameKey]);
    if (raw === null) continue;
    const decoded = decodeCookieValue(raw);
    const value = decoded === null ? null : normalize(decoded);
    if (value === null) invalidNames.push(COMMENTER_COOKIE_NAMES[nameKey]);
    else identity[field] = value;
  }

  return { identity, invalidNames };
}

function cookieAttributes(request: Request, maxAge: number): string {
  const secure = shouldUseSecureCookie(request) ? '; Secure' : '';
  return `Path=/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Lax`;
}

function cookieHeader(name: string, value: string, request: Request, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; ${cookieAttributes(request, maxAge)}`;
}

export function appendRememberedCommenterCookies(
  headers: Headers,
  request: Request,
  identity: CommenterIdentity,
  remember: boolean,
): void {
  const values: Array<[keyof CommenterIdentity, keyof typeof COMMENTER_COOKIE_NAMES]> = [
    ['author', 'author'],
    ['mail', 'mail'],
    ['url', 'url'],
  ];
  for (const [field, nameKey] of values) {
    const name = COMMENTER_COOKIE_NAMES[nameKey];
    const value = remember ? identity[field].trim() : '';
    headers.append('Set-Cookie', cookieHeader(name, value, request, value ? COMMENTER_COOKIE_MAX_AGE : 0));
  }
}

export function appendClearedCommenterCookies(
  headers: Headers,
  request: Request,
  names: readonly string[] = Object.values(COMMENTER_COOKIE_NAMES),
): void {
  const attributes = cookieAttributes(request, 0);
  for (const name of names) headers.append('Set-Cookie', `${name}=; ${attributes}`);
}
