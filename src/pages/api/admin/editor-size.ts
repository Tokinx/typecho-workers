import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/http';

const MIN_EDITOR_HEIGHT = 100;
const MAX_EDITOR_HEIGHT = 2_000;

export const POST: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const rawSize = (await request.formData()).get('size')?.toString() || '';
  const size = Number(rawSize);
  if (!Number.isInteger(size) || size < MIN_EDITOR_HEIGHT || size > MAX_EDITOR_HEIGHT) {
    return jsonError(400, `编辑器高度必须在 ${MIN_EDITOR_HEIGHT}-${MAX_EDITOR_HEIGHT} 像素之间`);
  }

  await auth.db.insert(schema.options).values({
    name: 'editorSize',
    user: auth.uid,
    value: String(size),
  }).onConflictDoUpdate({
    target: [schema.options.name, schema.options.user],
    set: { value: String(size) },
  });

  return jsonOk({ size });
};
