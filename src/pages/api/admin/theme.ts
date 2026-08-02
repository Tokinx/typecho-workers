/**
 * Theme management API
 * POST: Activate a theme
 */
import type { APIRoute } from 'astro';
import { deleteOption, setOption } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { getThemeConfigDefaults, themeExists, themeHasConfig } from '@/lib/theme';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: auth.status === 401 ? 401 : 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json() as { theme?: string };
    const themeId = body.theme;

    if (!themeId || typeof themeId !== 'string') {
      return new Response(JSON.stringify({ error: '请指定主题标识' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify the theme exists
    if (!themeExists(themeId)) {
      return new Response(JSON.stringify({ error: `主题 "${themeId}" 不存在，请先通过 npm 安装` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const previousThemeId = String(auth.options.theme || 'typecho-theme-minimal');
    if (previousThemeId !== themeId) {
      // Match Typecho's lifecycle: switching themes removes the old theme's
      // settings while keeping any settings already saved for the target.
      await deleteOption(auth.db, `theme:${previousThemeId}`);
    }
    await setOption(auth.db, 'theme', themeId);
    if (previousThemeId !== themeId && themeHasConfig(themeId) && !auth.options[`theme:${themeId}`]) {
      await setOption(auth.db, `theme:${themeId}`, JSON.stringify(getThemeConfigDefaults(themeId)));
    }

    // Theme change affects all pages
    await bumpCacheVersion(auth.db);
    await purgeSiteCache(auth.options.siteUrl || '');

    return new Response(JSON.stringify({ 
      success: true, 
      message: `主题已切换为 "${themeId}"`,
      theme: themeId,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: '请求格式错误' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
