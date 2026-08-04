import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const frontRoutes = [
  'src/pages/[slug].astro',
  'src/pages/archives/[cid].astro',
  'src/pages/note/[cid].astro',
  'src/pages/category/[slug].astro',
  'src/pages/tag/[slug].astro',
  'src/pages/author/[uid].astro',
];

describe('front route 404 rendering', () => {
  it('renders the themed NotFound template instead of returning plain Not Found text', () => {
    for (const route of frontRoutes) {
      const source = readFileSync(join(process.cwd(), route), 'utf8');

      expect(source, route).toContain('prepareNotFoundData');
      expect(source, route).toContain('Astro.response.status = 404');
      expect(source, route).toContain('templates.NotFound ?? defaultTemplates.NotFound');
      expect(source, route).not.toContain("return new Response('Not Found'");
      expect(source, route).not.toContain('if (result instanceof Response) return result');
    }
  });
});

it('keeps note details on their own route without changing archive URLs', () => {
  const noteRoute = readFileSync(join(process.cwd(), 'src/pages/note/[cid].astro'), 'utf8');
  const archiveRoute = readFileSync(join(process.cwd(), 'src/pages/archives/[cid].astro'), 'utf8');

  expect(noteRoute).toContain("eq(schema.contents.type, 'note')");
  expect(noteRoute).toContain('result.post.permalink = `${ctx.urls.siteUrl.replace(/\\/$/, \'\')}/note/${cidNum}`');
  expect(archiveRoute).not.toContain("contentRow.type === 'note'");
});
