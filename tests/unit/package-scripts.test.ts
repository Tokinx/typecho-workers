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
    expect(pkg.scripts['db:migrate:typecho']).toBe('tsx scripts/migrate.ts');
    expect(pkg.scripts['db:migrate']).toBeUndefined();
    expect(pkg.scripts['db:migrate:local']).toBeUndefined();
    expect(pkg.scripts['db:migrate:cloudflare']).toBeUndefined();
    expect(pkg.scripts['db:migrate:dry-run']).toBeUndefined();
  });
});
