import { shouldUseSecureCookie } from '@/lib/auth';

const DEFAULT_MAX_AGE = 60;
const DEFAULT_PATH = '/';
const MAX_FLASH_LENGTH = 500;

export const LOGIN_ERROR_FLASH_COOKIE = '__typecho_login_error';
export const REGISTER_NOTICE_FLASH_COOKIE = '__typecho_register_notice';
// Keep the names used by Typecho 1.3.0 so admin notices remain compatible
// with the existing backend convention.
export const ADMIN_NOTICE_FLASH_COOKIE = '__typecho_notice';
export const ADMIN_NOTICE_TYPE_FLASH_COOKIE = '__typecho_notice_type';
export const ADMIN_NOTICE_LINK_TEXT_COOKIE = '__typecho_notice_link_text';
export const ADMIN_NOTICE_LINK_URL_COOKIE = '__typecho_notice_link_url';

export type AdminNoticeType = 'success' | 'notice' | 'error';

export interface AdminNoticeLink {
  text: string;
  href: string;
}

export function createFlashCookieHeader(
  name: string,
  value: string,
  options: { maxAge?: number; path?: string; request?: Request } = {},
): string {
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
  const path = options.path ?? DEFAULT_PATH;
  const encoded = encodeURIComponent(value.slice(0, MAX_FLASH_LENGTH));
  const secureFlag = shouldUseSecureCookie(options.request) ? '; Secure' : '';
  return `${name}=${encoded}; Path=${path}; HttpOnly${secureFlag}; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearFlashCookieHeader(
  name: string,
  options: { path?: string; request?: Request } = {},
): string {
  const path = options.path ?? DEFAULT_PATH;
  const secureFlag = shouldUseSecureCookie(options.request) ? '; Secure' : '';
  return `${name}=; Path=${path}; HttpOnly${secureFlag}; SameSite=Lax; Max-Age=0`;
}

export function getFlashCookieValue(cookieHeader: string | null, name: string): string {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rawValue.join('='));
    } catch {
      return '';
    }
  }
  return '';
}

export function createFlashRedirectHeaders(location: string, name: string, value: string, path = '/', request?: Request): Headers {
  const headers = new Headers();
  headers.set('Location', location);
  headers.append('Set-Cookie', createFlashCookieHeader(name, value, { path, request }));
  return headers;
}

export function createAdminNoticeRedirectHeaders(
  location: string,
  message: string,
  type: AdminNoticeType = 'notice',
  path = '/',
  request?: Request,
  link?: AdminNoticeLink,
): Headers {
  const headers = new Headers({ Location: location });
  headers.append('Set-Cookie', createFlashCookieHeader(ADMIN_NOTICE_FLASH_COOKIE, message, { path, request }));
  headers.append('Set-Cookie', createFlashCookieHeader(ADMIN_NOTICE_TYPE_FLASH_COOKIE, type, { path, request }));
  if (link) {
    headers.append('Set-Cookie', createFlashCookieHeader(ADMIN_NOTICE_LINK_TEXT_COOKIE, link.text, { path, request }));
    headers.append('Set-Cookie', createFlashCookieHeader(ADMIN_NOTICE_LINK_URL_COOKIE, link.href, { path, request }));
  } else {
    headers.append('Set-Cookie', clearFlashCookieHeader(ADMIN_NOTICE_LINK_TEXT_COOKIE, { path, request }));
    headers.append('Set-Cookie', clearFlashCookieHeader(ADMIN_NOTICE_LINK_URL_COOKIE, { path, request }));
  }
  return headers;
}
