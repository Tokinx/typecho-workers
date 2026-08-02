import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf-8');
}

describe('page-specific theme templates', () => {
  it('loads declared page template components into the generated theme module', () => {
    const loader = source('src/integrations/theme-loader.ts');

    expect(loader).toContain('function scanPageTemplates(');
    expect(loader).toContain('manifest.pageTemplates');
    expect(loader).toContain('PageTemplates: {');
    expect(loader).toContain("component.endsWith('.astro')");
  });

  it('uses a selected template for public pages and admin preview', () => {
    for (const path of [
      'src/pages/[slug].astro',
      'src/pages/archives/[cid].astro',
      'src/pages/admin/preview.astro',
    ]) {
      expect(source(path), path).toContain('PageTemplates?.[');
    }
  });
});
