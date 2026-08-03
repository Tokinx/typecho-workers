import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf-8');
}

describe('production output formatting', () => {
  it('preserves whitespace in Astro and Vite build output', () => {
    const config = source('astro.config.mjs');

    expect(config).toContain('compressHTML: false');
    expect(config).toMatch(/build:\s*\{\s*minify:\s*false,\s*cssMinify:\s*false/);
  });

  it('does not minify independently bundled browser scripts', () => {
    expect(source('src/integrations/client-loader.ts')).toContain('minify: false');
  });
});
