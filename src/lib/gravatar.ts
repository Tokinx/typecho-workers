import { applyFilterSafely, type HookContext } from '@/lib/plugin';

export interface GravatarUrlOptions {
  defaultImage?: string;
  size?: number;
  rating?: string;
}

export interface GravatarFilterExtra {
  options?: Record<string, unknown>;
  request?: Request;
}

export async function createGravatarHash(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function buildGravatarUrl(
  email: string | null | undefined,
  { defaultImage = 'identicon', size = 40, rating }: GravatarUrlOptions = {},
): Promise<string> {
  const hash = email ? await createGravatarHash(email) : '';
  const params = new URLSearchParams();
  params.set('d', defaultImage);
  params.set('s', String(size));
  if (rating) params.set('r', rating);
  return `https://www.gravatar.com/avatar/${hash}?${params.toString()}`;
}

/**
 * Build a Gravatar URL and pass it through the `gravatar:url` filter hook
 * (e.g. Edge Cache plugin Avatar CDN rewrite).
 */
export async function resolveGravatarUrl(
  ctx: HookContext,
  email: string | null | undefined,
  opts: GravatarUrlOptions = {},
  extra?: GravatarFilterExtra,
): Promise<string> {
  const url = await buildGravatarUrl(email, opts);
  const filtered = await applyFilterSafely(ctx, 'gravatar:url', url, extra);
  return typeof filtered === 'string' ? filtered : url;
}
