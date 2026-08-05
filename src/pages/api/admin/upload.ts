import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { canManageResource } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { uploadToR2, deleteFromR2 } from '@/lib/upload';
import { applyFilter, doHook } from '@/lib/plugin';
import { trackSlidingWindow } from '@/lib/login-rate-limit';
import { UPLOAD_RATE_LIMIT } from '@/lib/constants';
import { jsonError, jsonOk } from '@/lib/http';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { invalidatePublicCache } from '@/lib/cache';

/**
 * R2 attachment metadata JSON persisted in contents.text for type='attachment'.
 * Written by POST /api/admin/upload; consumed by DELETE for cleanup.
 */
interface AttachmentMeta {
  name: string;
  path: string;
  size: number;
  type: string;
  url: string;
}

/**
 * Per-user upload rate limit (G5-4). See `src/lib/constants.ts` for values.
 * Human editors won't hit this; it bounds the blast radius of a stolen admin
 * token.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.ceil(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isImageType(mime: string): boolean {
  return mime.startsWith('image/');
}

function jsonAuthError(response: Response): Response {
  return jsonError(response.status, response.status === 401 ? 'Unauthorized' : 'Forbidden');
}

export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(ctx)) return jsonAuthError(ctx);
  const { db, options, pluginCtx } = ctx;

  // G5-4: cap per-user upload rate. Self-signed admin tokens that get
  // exfiltrated can otherwise rapidly exhaust the R2 bucket quota.
  if (!trackSlidingWindow(`upload:${ctx.uid}`, UPLOAD_RATE_LIMIT)) {
    return jsonError(429, '上传频率过高，请稍后再试', { 'Retry-After': String(UPLOAD_RATE_LIMIT.windowSeconds) });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return jsonError(400, '没有上传文件');
    }

    // G5-5: upload:beforeUpload — plugins can reject the upload by
    // returning { rejected: 'reason' } in the filter result.
    const beforeResult = await applyFilter(pluginCtx, 'upload:beforeUpload', { rejected: null as string | null }, {
      file, request, options, user: ctx.user,
    });
    if (beforeResult?.rejected) {
      return jsonError(403, String(beforeResult.rejected));
    }

    const bucket = env.BUCKET;
    const result = await uploadToR2(bucket, file, options.siteUrl, options.attachmentTypes);

    // Create attachment content record
    const now = Math.floor(Date.now() / 1000);
    const inserted = await db.insert(schema.contents).values({
      title: file.name,
      slug: `attachment-${Date.now().toString(36)}`,
      created: now,
      modified: now,
      text: JSON.stringify({
        name: result.name,
        path: result.path,
        size: result.size,
        type: result.type,
        url: result.url,
      }),
      authorId: ctx.uid,
      type: 'attachment',
      status: 'publish',
      parent: parseInt(formData.get('cid')?.toString() || '0', 10),
    }).returning({ cid: schema.contents.cid });

    // Return format compatible with Typecho's file-upload-js.php
    // [url, {cid, title, url, bytes, isImage}]
    // G5-3: trust the server-derived result.type, not the spoofable
    // file.type from the multipart upload.
    const cid = inserted[0]?.cid;
    await invalidatePublicCache(db, {
      reason: 'media-upload',
      domains: [],
      sharedDomains: ['admin-media', 'admin-content'],
    });

    // G5-5: upload:upload — fire-and-forget post-upload notification.
    await doHook(pluginCtx, 'upload:upload', { ...result, cid }, { request, options, user: ctx.user });

    return jsonOk([
      result.url,
      {
        cid,
        title: file.name,
        url: result.url,
        bytes: formatBytes(result.size),
        isImage: isImageType(result.type),
      },
    ]);
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : '上传失败');
  }
};

/**
 * DELETE /api/admin/upload?cid=xxx - Delete an attachment
 */
export const DELETE: APIRoute = async ({ request, locals, url }) => {
  const ctx = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(ctx)) return jsonAuthError(ctx);
  const { db, pluginCtx } = ctx;

  const cid = parseInt(url.searchParams.get('cid') || '0', 10);
  if (!cid) {
    return jsonError(400, '缺少 cid 参数');
  }

  try {
    const attachment = await db.query.contents.findFirst({
      where: eq(schema.contents.cid, cid),
    });

    if (!attachment || attachment.type !== 'attachment') {
      return jsonError(404, '附件不存在');
    }

    // Check ownership: non-admins can only delete their own attachments
    if (!canManageResource(ctx.user, attachment)) {
      return jsonError(403, '无权删除此附件');
    }

    // Delete file from R2
    let meta: AttachmentMeta | null = null;
    try {
      meta = JSON.parse(attachment.text || '{}') as AttachmentMeta;
      if (meta.path) {
        const bucket = env.BUCKET;
        await deleteFromR2(bucket, meta.path);
      }
    } catch (err) {
      // Malformed metadata means we can't reach the R2 object → it will
      // orphan when the DB row goes away. Surface it in logs so operators
      // can reconcile, but still allow the DB row to be removed (blocking
      // the delete would leave the admin unable to clean up either).
      console.warn(`[upload] failed to reach R2 for attachment cid=${cid}; DB row will be removed but R2 object may orphan:`, err);
    }

    // G5-5: upload:delete fires before the DB row vanishes so plugins
    // can mirror the deletion (e.g. CDN purge, external storage).
    await doHook(pluginCtx, 'upload:delete', { cid, ...(meta || {}) }, { request, options: ctx.options, user: ctx.user });

    // Delete DB record
    await db.delete(schema.contents).where(eq(schema.contents.cid, cid));
    await invalidatePublicCache(db, {
      reason: 'media-upload-delete',
      domains: [],
      sharedDomains: ['admin-media', 'admin-content'],
    });

    return jsonOk({ success: true });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : '删除失败');
  }
};
