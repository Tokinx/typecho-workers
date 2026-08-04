/**
 * Theme management API
 * POST: Activate a theme
 */
import type { APIRoute } from 'astro';
import { mutateOptionsBatch } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { getThemeConfigDefaults, themeExists, themeHasConfig } from '@/lib/theme';

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
    const optionSets: Record<string, string> = { theme: themeId };
    const optionDeletes: string[] = [];
    if (previousThemeId !== themeId) optionDeletes.push(`theme:${previousThemeId}`);
    if (previousThemeId !== themeId && themeHasConfig(themeId) && !auth.options[`theme:${themeId}`]) {
      optionSets[`theme:${themeId}`] = JSON.stringify(getThemeConfigDefaults(themeId));
    }
    await mutateOptionsBatch(auth.db, { set: optionSets, delete: optionDeletes });

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
