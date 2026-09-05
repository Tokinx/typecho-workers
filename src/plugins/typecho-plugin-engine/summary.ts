/**
 * Engine summary persistence helpers (typecho_fields.name = engine_summary).
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { schema } from 'typecho/db';
import { generateExcerpt } from '@/lib/markdown';
import { ENGINE_SUMMARY_FIELD, SUMMARY_EXCERPT_LENGTH } from './config';

export { ENGINE_SUMMARY_FIELD, SUMMARY_EXCERPT_LENGTH };

export function fallbackSummaryFromText(text: string): string {
  return generateExcerpt(text || '', SUMMARY_EXCERPT_LENGTH).trim();
}

export async function readSummary(db: any, cid: number): Promise<string | null> {
  const row = await db.query.fields.findFirst({
    where: and(eq(schema.fields.cid, cid), eq(schema.fields.name, ENGINE_SUMMARY_FIELD)),
    columns: { str_value: true },
  });
  const value = row?.str_value?.trim();
  return value || null;
}

export async function upsertSummary(db: any, cid: number, summary: string): Promise<void> {
  const value = summary.trim();
  if (!value) return;

  const existing = await db.query.fields.findFirst({
    where: and(eq(schema.fields.cid, cid), eq(schema.fields.name, ENGINE_SUMMARY_FIELD)),
    columns: { cid: true },
  });

  if (existing) {
    await db.update(schema.fields)
      .set({ str_value: value, type: 'str' })
      .where(and(eq(schema.fields.cid, cid), eq(schema.fields.name, ENGINE_SUMMARY_FIELD)));
    return;
  }

  await db.insert(schema.fields).values({
    cid,
    name: ENGINE_SUMMARY_FIELD,
    type: 'str',
    str_value: value,
  });
}

export interface SummaryListItem {
  cid: number;
  title: string;
  type: string;
  hasSummary: boolean;
}

/** Published posts + pages eligible for batch summarization. */
export async function listPublishedForSummary(db: any): Promise<SummaryListItem[]> {
  const rows = await db
    .select({
      cid: schema.contents.cid,
      title: schema.contents.title,
      type: schema.contents.type,
    })
    .from(schema.contents)
    .where(and(
      eq(schema.contents.status, 'publish'),
      or(eq(schema.contents.type, 'post'), eq(schema.contents.type, 'page')),
    ))
    .orderBy(schema.contents.created);

  const cids = (rows as Array<{ cid: number | null }>).map((r) => r.cid).filter((cid): cid is number => cid != null);
  const summarySet = new Set<number>();
  if (cids.length > 0) {
    const fields = await db
      .select({ cid: schema.fields.cid, str_value: schema.fields.str_value })
      .from(schema.fields)
      .where(and(
        inArray(schema.fields.cid, cids),
        eq(schema.fields.name, ENGINE_SUMMARY_FIELD),
      )) as Array<{ cid: number | null; str_value: string | null }>;
    for (const field of fields) {
      if (field.cid != null && field.str_value?.trim()) summarySet.add(field.cid);
    }
  }

  return (rows as Array<{ cid: number | null; title: string | null; type: string | null }>)
    .filter((r): r is { cid: number; title: string | null; type: string | null } => r.cid != null)
    .map((r) => ({
      cid: r.cid,
      title: r.title || '',
      type: r.type || 'post',
      hasSummary: summarySet.has(r.cid),
    }));
}
