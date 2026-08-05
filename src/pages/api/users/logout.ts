import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import {
  clearAuthCookieHeaders,
  generateRandomString,
  getAuthCookies,
  validateAuthToken,
} from '@/lib/auth';
import { loadOptions } from '@/lib/options';
import { getRequestCoreContextFromLocals } from '@/lib/context';

/**
 * Logout — POST only to actually clear cookies. The CSRF risk of clearing
 * cookies on GET (image-tag forced logout) is real, so the GET handler
 * is preserved as a no-op redirect for backwards compatible link targets
 * but never modifies session state.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const requestOrigin = new URL(request.url).origin;
  const source = request.headers.get('origin') || request.headers.get('referer');
  if (source) {
    try {
      if (new URL(source).origin !== requestOrigin) {
        return new Response('Forbidden', { status: 403 });
      }
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  const { token } = getAuthCookies(request.headers.get('cookie'));

  // Logout is idempotent for missing/stale cookies, but a valid session must
  // rotate its authCode before clearing the browser token.
  if (token && options.secret) {
    const auth = await validateAuthToken(token, String(options.secret), db);
    if (auth) {
      await db.update(schema.users)
        .set({ authCode: generateRandomString(32) })
        .where(eq(schema.users.uid, auth.uid));
    }
  }

  const cookieHeaders = clearAuthCookieHeaders(request);
  const headers = new Headers();
  headers.set('Location', '/');
  for (const cookie of cookieHeaders) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
};

export const GET: APIRoute = async () => {
  // GET logout kept for backward compat — DOES NOT clear cookies to prevent
  // CSRF logout via <img src=...>. Use POST /api/users/logout for actual logout.
  return new Response(null, {
    status: 302,
    headers: { Location: '/' },
  });
};
