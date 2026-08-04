import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('home route', () => {
  it('reads Notes activation from the request context itself', () => {
    const source = readFileSync(join(process.cwd(), 'src/pages/index.astro'), 'utf8');

    expect(source).toContain("ctx.activatedPlugins.has('typecho-plugin-notes')");
    expect(source).not.toContain('ctx.pluginCtx.activatedPlugins');
  });
});
