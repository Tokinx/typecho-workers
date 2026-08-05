import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { hashPassword, generateRandomString } from '@/lib/auth';
import { PASSWORD_MIN_LENGTH } from '@/lib/constants';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { normalizeHttpUrl } from '@/lib/url';
import { and, eq, ne, sql } from 'drizzle-orm';
import { invalidatePublicCache } from '@/lib/cache';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return auth;
  const db = auth.db;

  const formData = await request.formData();
  const action = formData.get('do')?.toString() || 'create';
  const uid = parseInt(formData.get('uid')?.toString() || '0', 10);
  const name = formData.get('name')?.toString()?.trim() || '';
  const mail = formData.get('mail')?.toString()?.trim() || '';
  const screenName = formData.get('screenName')?.toString()?.trim() || '';
  const url = formData.get('url')?.toString()?.trim() || '';
  const groupInput = formData.get('group')?.toString() || 'subscriber';
  const VALID_GROUPS = ['administrator', 'editor', 'contributor', 'subscriber'];
  const group = VALID_GROUPS.includes(groupInput) ? groupInput : 'subscriber';
  const password = formData.get('password')?.toString() || '';
  const confirm = formData.get('confirm')?.toString() || '';

  if (action === 'create') {
    if (!name || !mail || !password) {
      return new Response('请填写完整信息', { status: 400 });
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return new Response(`密码长度至少${PASSWORD_MIN_LENGTH}位`, { status: 400 });
    }
    if (password !== confirm) {
      return new Response('两次输入的密码不一致', { status: 400 });
    }

    const [[[existingName], [existingMail]], hashedPassword] = await Promise.all([
      db.batch([
        db.select({ uid: schema.users.uid }).from(schema.users)
          .where(eq(schema.users.name, name)).limit(1),
        db.select({ uid: schema.users.uid }).from(schema.users)
          .where(eq(schema.users.mail, mail)).limit(1),
      ]),
      hashPassword(password),
    ]);
    if (existingName) {
      return new Response('用户名已被使用', { status: 409 });
    }
    if (existingMail) {
      return new Response('邮箱已被使用', { status: 409 });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return new Response('邮箱格式不正确', { status: 400 });
    }

    let normalizedUrl: string | null = null;
    if (url) {
      const parsed = normalizeHttpUrl(url);
      if (parsed === null) return new Response('个人主页地址格式不正确', { status: 400 });
      normalizedUrl = parsed;
    }

    const authCode = generateRandomString(32);
    const now = Math.floor(Date.now() / 1000);

    await db.insert(schema.users).values({
      name,
      password: hashedPassword,
      mail,
      url: normalizedUrl,
      screenName: screenName || name,
      created: now,
      activated: now,
      logged: 0,
      group,
      authCode,
    });
    await invalidatePublicCache(db, {
      reason: 'user-create',
      domains: [],
      sharedDomains: ['admin-users', 'admin-dashboard'],
    });

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/manage-users' },
    });
  }

  if (action === 'update' && uid) {
    const [[existing], [existingMail], adminCounts] = await db.batch([
      db.select().from(schema.users).where(eq(schema.users.uid, uid)).limit(1),
      db.select({ uid: schema.users.uid }).from(schema.users)
        .where(and(eq(schema.users.mail, mail), ne(schema.users.uid, uid))).limit(1),
      db.select({ count: sql<number>`count(*)` }).from(schema.users)
        .where(eq(schema.users.group, 'administrator')),
    ]);
    if (!existing) {
      return new Response('用户不存在', { status: 404 });
    }

    if (!mail) {
      return new Response('邮箱不能为空', { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return new Response('邮箱格式不正确', { status: 400 });
    }

    if (existingMail) {
      return new Response('邮箱已被使用', { status: 409 });
    }

    if (existing.group === 'administrator' && group !== 'administrator' && (adminCounts[0]?.count || 0) <= 1) {
      return new Response('不能降级最后一个管理员', { status: 400 });
    }

    let normalizedUrl: string | null = null;
    if (url) {
      const parsed = normalizeHttpUrl(url);
      if (parsed === null) return new Response('个人主页地址格式不正确', { status: 400 });
      normalizedUrl = parsed;
    }

    const updateData: Record<string, unknown> = {
      mail,
      screenName: screenName || existing.name,
      url: normalizedUrl,
      group,
    };

    if (password) {
      if (password.length < PASSWORD_MIN_LENGTH) {
        return new Response(`密码长度至少${PASSWORD_MIN_LENGTH}位`, { status: 400 });
      }
      if (password !== confirm) {
        return new Response('两次输入的密码不一致', { status: 400 });
      }
      updateData.password = await hashPassword(password);
      // Password changes revoke every existing session for this user.
      updateData.authCode = generateRandomString(32);
    }

    await db.update(schema.users).set(updateData).where(eq(schema.users.uid, uid));
    await invalidatePublicCache(db, {
      reason: 'user-update',
      domains: [],
      sharedDomains: ['admin-users', 'admin-dashboard', 'admin-content', 'admin-comments', 'admin-media'],
    });

    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/user?uid=${uid}` },
    });
  }

  return new Response('Invalid action', { status: 400 });
};
