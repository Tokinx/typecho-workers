/**
 * Regression tests for package lifecycle scripts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package scripts', () => {
  it('keeps build as a pure build command without installing dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.scripts.build).toBe('astro build');
    expect(pkg.scripts.build).not.toContain('install');
  });

  it('uses one parameterized command for PHP Typecho migrations', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.scripts['db:migrate:typecho']).toBe('bun run scripts/migrate.ts');
    expect(pkg.scripts['db:migrate']).toBeUndefined();
    expect(pkg.scripts['db:migrate:local']).toBeUndefined();
    expect(pkg.scripts['db:migrate:cloudflare']).toBeUndefined();
    expect(pkg.scripts['db:migrate:dry-run']).toBeUndefined();
  });

  it('declares local plugins and themes as bun workspace packages', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    const workspaces = pkg.workspaces ?? [];

    expect(workspaces).toContain('src/plugins/*');
    expect(workspaces).toContain('src/themes/*');
  });

  it('provides a dedicated Git build and deploy path for an ignored Worker config', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

    expect(pkg.scripts['build:cloudflare']).toContain('generate:cloudflare-config');
    expect(pkg.scripts['deploy:cloudflare-build']).toBe('wrangler deploy --config dist/server/wrangler.json');
  });
});
