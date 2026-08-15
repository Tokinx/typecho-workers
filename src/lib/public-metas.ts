import { asc, eq, or } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { loadEarlyRequestSharedData } from '@/lib/early-request';

export type PublicMeta = Pick<
  typeof schema.metas.$inferSelect,
  'mid' | 'name' | 'slug' | 'type' | 'description' | 'count' | 'order'
>;

export async function loadPublicMetaDictionary(db: Pick<Database, 'select'>): Promise<PublicMeta[]> {
  return loadEarlyRequestSharedData('metas', 'category-tag', async () => db
    .select({
      mid: schema.metas.mid,
      name: schema.metas.name,
      slug: schema.metas.slug,
      type: schema.metas.type,
      description: schema.metas.description,
      count: schema.metas.count,
      order: schema.metas.order,
    })
    .from(schema.metas)
    .where(or(eq(schema.metas.type, 'category'), eq(schema.metas.type, 'tag')))
    .orderBy(asc(schema.metas.type), asc(schema.metas.order)));
}

export async function findPublicMeta(
  db: Pick<Database, 'select'>,
  type: 'category' | 'tag',
  slug: string,
): Promise<PublicMeta | null> {
  const metas = await loadPublicMetaDictionary(db);
  return metas.find(meta => meta.type === type && meta.slug === slug) || null;
}
