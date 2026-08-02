/**
 * Active theme appearance settings API.
 * GET  /api/admin/theme-config
 * POST /api/admin/theme-config { settings: { ... } }
 */
import type { APIRoute } from 'astro';
import { setOption } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import {
  getActiveTheme,
  getThemeConfigDefinition,
  getThemeConfigDefaults,
  loadThemeConfig,
  themeHasConfig,
} from '@/lib/theme';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, 'administrator', { csrf: false });
  if (isAdminActionResponse(auth)) return errorResponse('权限不足', auth.status === 401 ? 401 : 403);

  const theme = getActiveTheme(String(auth.options.theme || 'typecho-theme-minimal'));
  const config = getThemeConfigDefinition(theme.id);
  if (!themeHasConfig(theme.id) || !config) return errorResponse('当前外观没有设置项', 404);

  return new Response(JSON.stringify({
    theme: theme.id,
    name: theme.manifest.name,
    fields: config,
    values: loadThemeConfig(auth.options, theme.id),
  }), { headers: { 'Content-Type': 'application/json' } });
};

export const POST: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return errorResponse('权限不足', auth.status === 401 ? 401 : 403);

  const theme = getActiveTheme(String(auth.options.theme || 'typecho-theme-minimal'));
  const config = getThemeConfigDefinition(theme.id);
  if (!themeHasConfig(theme.id) || !config) return errorResponse('当前外观没有设置项', 404);

  let body: { settings?: Record<string, unknown> };
  try {
    body = await request.json() as { settings?: Record<string, unknown> };
  } catch {
    return errorResponse('请求格式错误', 400);
  }

  if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
    return errorResponse('请提供配置数据', 400);
  }

  const defaults = getThemeConfigDefaults(theme.id);
  const settings: Record<string, unknown> = {};
  for (const key of Object.keys(config)) {
    settings[key] = key in body.settings ? body.settings[key] : defaults[key];
  }

  await setOption(auth.db, `theme:${theme.id}`, JSON.stringify(settings));
  await bumpCacheVersion(auth.db);
  await purgeSiteCache(auth.options.siteUrl || '');

  return new Response(JSON.stringify({
    success: true,
    message: '外观设置已经保存',
    theme: theme.id,
    settings,
  }), { headers: { 'Content-Type': 'application/json' } });
};
