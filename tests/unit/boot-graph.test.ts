/**
 * Boot-graph purity guard.
 *
 * The middleware module graph is evaluated on every isolate's first request
 * (including page-cache hits, which never enter the render chain). Render-only
 * heavyweights — markdown pulls in marked + sanitize-html (~460KB built) —
 * must therefore stay out of it via dynamic imports. This regression actually
 * happened once: a static markdown import added to early-request.ts tripled
 * the first-request module graph. These tests pin the invariant.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const RENDER_ONLY_MODULES = ['@/lib/markdown', '@/lib/page-data', '@/lib/feed-helpers'];
/** Modules evaluated on every first request; must not statically pull render-only code. */
const BOOT_GRAPH_SOURCES = ['src/middleware.ts', 'src/lib/early-request.ts'];

function repoRoot(): string {
  return resolve(import.meta.dirname, '..', '..');
}

function staticImportsOf(source: string, specifier: string): string[] {
  // Line-start static imports only — `await import(specifier)` inside a
  // function body is exactly what the boot graph is allowed to use.
  const pattern = new RegExp(`^import\\s[^;]*from\\s*['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'gm');
  return source.match(pattern) ?? [];
}

describe('boot graph purity', () => {
  it.each(RENDER_ONLY_MODULES.map((specifier) => [specifier]))(
    'does not statically import %s into the boot graph',
    (specifier) => {
      for (const file of BOOT_GRAPH_SOURCES) {
        const source = readFileSync(resolve(repoRoot(), file), 'utf8');
        const matches = staticImportsOf(source, specifier);
        expect({ file, matches }).toEqual({ file, matches: [] });
      }
    },
  );
});
