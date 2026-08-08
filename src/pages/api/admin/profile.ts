import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { generateAuthToken, generateRandomString, hasPermission, hashPassword, setAuthCookieHeaders } from '@/lib/auth';
import { PASSWORD_MIN_LENGTH } from '@/lib/constants';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { normalizeHttpUrl } from '@/lib/url';
import { eq, and, ne } from 'drizzle-orm';
import { invalidatePublicCache } from '@/lib/cache';
import { createAdminNoticeRedirectHeaders } from '@/lib/flash';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'visitor');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await request.formData();
  const action = formData.get('do')?.toString() || 'profile';

  if (action === 'profile') {
    const screenName = formData.get('screenName')?.toString()?.trim() || auth.user.name;
    const mail = formData.get('mail')?.toString()?.trim() || '';
    const url = formData.get('url')?.toString()?.trim() || '';

    if (!mail) return new Response('邮箱不能为空', { status: 400 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return new Response('邮箱格式不正确', { status: 400 });
    }

    const existingMail = await auth.db.query.users.findFirst({
      where: and(eq(schema.users.mail, mail), ne(schema.users.uid, auth.uid)),
    });
    if (existingMail) return new Response('邮箱已被其他用户使用', { status: 409 });

    let normalizedUrl: string | null = null;
    if (url) {
      normalizedUrl = normalizeHttpUrl(url);
      if (normalizedUrl === null) return new Response('个人主页地址格式不正确', { status: 400 });
    }

    await auth.db.update(schema.users).set({ screenName, mail, url: normalizedUrl })
      .where(eq(schema.users.uid, auth.uid));
    await invalidatePublicCache(auth.db, {
      reason: 'profile-update',
      domains: [],
      sharedDomains: ['admin-users', 'admin-dashboard', 'admin-content', 'admin-comments', 'admin-media'],
    });
    return redirectToProfile('您的档案已经更新', request);
  }

  if (action === 'options') {
    if (!hasPermission(auth.user.group || 'visitor', 'contributor')) {
      return new Response('Forbidden', { status: 403 });
    }

    // Typecho's Checkbox element submits array-style names; retain support for
    // the un-suffixed name used by older clients and existing integrations.
    const defaultAllow = new Set([
      ...formData.getAll('defaultAllow'),
      ...formData.getAll('defaultAllow[]'),
    ].map((value) => value.toString()));
    const settings: Record<string, string> = {
      markdown: formData.get('markdown')?.toString() === '1' ? '1' : '0',
      autoSave: formData.get('autoSave')?.toString() === '1' ? '1' : '0',
      defaultAllowComment: defaultAllow.has('comment') ? '1' : '0',
      defaultAllowFeed: defaultAllow.has('feed') ? '1' : '0',
    };
    await auth.db.batch(Object.entries(settings).map(([name, value]) =>
      auth.db.insert(schema.options).values({ name, user: auth.uid, value }).onConflictDoUpdate({
        target: [schema.options.name, schema.options.user],
        set: { value },
      }),
    ) as [any, ...any[]]);
    return redirectToProfile('设置已经保存', request);
  }

  if (action === 'password') {
    const password = formData.get('password')?.toString() || '';
    const passwordConfirm = formData.get('passwordConfirm')?.toString() || '';
    if (!password) return new Response('必须填写密码', { status: 400 });
    if (password !== passwordConfirm) return new Response('两次输入的密码不一致', { status: 400 });
    if (password.length < PASSWORD_MIN_LENGTH) {
      return new Response(`密码长度至少${PASSWORD_MIN_LENGTH}位`, { status: 400 });
    }

    const newAuthCode = generateRandomString(32);
    const passwordHash = await hashPassword(password);
    await auth.db.update(schema.users).set({ password: passwordHash, authCode: newAuthCode })
      .where(eq(schema.users.uid, auth.uid));
    await invalidatePublicCache(auth.db, {
      reason: 'profile-password',
      domains: [],
      sharedDomains: ['admin-users'],
    });

    // Rotate every session after a credential change, then keep this browser signed in.
    const token = await generateAuthToken(auth.uid, newAuthCode, auth.options.secret);
    const [, tokenHash] = token.split(':');
    const headers = createAdminNoticeRedirectHeaders('/admin/profile', '密码已经成功修改', 'success', '/', request);
    for (const cookie of setAuthCookieHeaders(auth.uid, tokenHash, 0, request)) {
      headers.append('Set-Cookie', cookie);
    }
    return new Response(null, { status: 302, headers });
  }

  return new Response('Invalid action', { status: 400 });
};

function redirectToProfile(message: string, request: Request): Response {
  return new Response(null, {
    status: 302,
    headers: createAdminNoticeRedirectHeaders('/admin/profile', message, 'success', '/', request),
  });
}
