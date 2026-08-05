import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { eq, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { invalidatePublicCache } from '@/lib/cache';
import { parseBoundedIds, sqlInChunks } from '@/lib/d1-in';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'editor');
  if (isAdminActionResponse(auth)) return auth;

  const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
  const action = url.searchParams.get('do') || '';
  if (action !== 'delete') return new Response('Invalid action', { status: 400 });

  // Get selected cids from form body
  let cids: number[] = [];
  if (request.method === 'POST') {
    const formData = await request.formData();
    const parsed = parseBoundedIds(formData.getAll('cid[]'));
    if (parsed === null) return new Response('附件 ID 数据无效或超过 200 项', { status: 400 });
    cids = parsed;
  }

  if (cids.length === 0) {
    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      '/admin/manage-medias',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  if (action === 'delete') {
    // G4-2: bulk-fetch attachments, run R2 deletes in parallel, then
    // emit a single content delete in one round-trip.
    const attachments = await auth.db.select().from(schema.contents)
      .where(sqlInChunks(schema.contents.cid, cids));
    const targets = attachments.filter(a =>
      a.type === 'attachment' && (isAdmin || a.authorId === auth.uid),
    );

    if (targets.length > 0) {
      // R2 deletes in parallel — drizzle/d1 batch can't include them.
      await Promise.all(targets.map(async att => {
        try {
          const meta = JSON.parse(att.text || '{}');
          if (meta.path && env.BUCKET) {
            await env.BUCKET.delete(meta.path);
          }
        } catch { /* ignore */ }
      }));

      await auth.db.delete(schema.contents).where(sqlInChunks(schema.contents.cid, targets.map(t => t.cid)));
      await invalidatePublicCache(auth.db, {
        reason: 'media-batch-delete',
        domains: [],
        sharedDomains: ['admin-media', 'admin-content'],
      });
    }
  }

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/manage-medias',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
