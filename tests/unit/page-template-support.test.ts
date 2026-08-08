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

  it('hashes theme static assets for CDN cache busting at build time', () => {
    const loader = source('src/integrations/theme-loader.ts');
    expect(loader).toContain("import { createHash } from 'node:crypto';");
    expect(loader).toContain('assetVersion');
    expect(loader).toContain("hash.digest('hex').slice(0, 8)");
  });

  it('renders preview rows through the matching page-data helper and closes the parent preview on exit', () => {
    const preview = source('src/pages/admin/preview.astro');

    expect(preview).toContain('preparePageData, preparePostData');
    expect(preview).toContain("row.type === 'page' || row.type === 'page_draft'");
    expect(preview).toContain('{ previewMode: true }');
    expect(preview).toContain("Astro.response.headers.set('X-Robots-Tag', 'noindex, nofollow')");
    expect(preview).not.toContain("import Base from '@/layouts/Base.astro'");
    expect(preview).toContain("window.parent.postMessage('cancelPreview', parentOrigin)");
  });
});
