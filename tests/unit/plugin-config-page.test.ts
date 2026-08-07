import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin plugin config page', () => {
  it('filters R2 binding choices to bucket-like bindings when possible', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
      'utf-8',
    );

    expect(source).toContain("typeof (value as any).get === 'function'");
    expect(source).toContain("typeof (value as any).put === 'function'");
    expect(source).toContain("typeof (value as any).delete === 'function'");
    expect(source).toContain("typeof (value as any).head === 'function'");
    expect(source).toContain("typeof (value as any).list === 'function'");
  });

  it('renumbers repeatable legends after add or remove actions', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
      'utf-8',
    );

    expect(source).toContain('data-label={field.label}');
    expect(source).toContain('function renumberRepeatableItems(root)');
    expect(source).toContain("legend.textContent = label + ' #' + String(index + 1)");
    expect(source.match(/renumberRepeatableItems\(root\)/g)).toHaveLength(3);
  });

  it('renders normalized root repeatable paths as slash values', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
      'utf-8',
    );

    expect(source).toContain('function displayRepeatableValue');
    expect(source).toContain("field.type === 'text' && field.default === '/' && value === ''");
    expect(source).toContain("value && !value.startsWith('/')");
  });

  it('masks stored secrets before rendering the SSR form', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
      'utf-8',
    );

    expect(source).toContain('maskPluginConfigSecrets');
    expect(source).toContain('restorePluginConfigSecrets');
    expect(source).toContain('let displayConfigValues');
    expect(source).toContain('const value = displayConfigValues[key]');
  });

  it('renders boolean select values as manifest option strings', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
      'utf-8',
    );

    expect(source).toContain('function fieldValueForOption');
    expect(source).toContain('function selectedAttr');
    expect(source).toContain("typeof value === 'boolean'");
    expect(source).toContain('data-current-value={fieldValueForOption(value)}');
    expect(source).toContain('selected={selectedAttr(value, optVal)}');
    expect(source).toContain("document.querySelectorAll('select[data-current-value]')");
    expect(source).toContain("select.value = select.getAttribute('data-current-value') || ''");
  });

  it('registers plugin route handlers via lazy init, not hardcoded import', () => {
    const middlewareSource = readFileSync(
      join(process.cwd(), 'src/middleware.ts'),
      'utf-8',
    );
    const pluginSource = readFileSync(
      join(process.cwd(), 'src/lib/plugin.ts'),
      'utf-8',
    );

    // middleware.ts must NOT hardcode any plugin route import
    expect(middlewareSource).not.toContain("from '@/plugins/typecho-plugin-notes/index'");
    expect(middlewareSource).not.toContain("from 'typecho-plugin-notes");

    // middleware.ts uses setActivatedPlugins which triggers lazy init
    expect(middlewareSource).toContain('setActivatedPlugins');

    // plugin.ts filters hooks by ctx.activatedPlugins (lazy-init safety net)
    expect(pluginSource).toContain('ctx.activatedPlugins.has(reg.pluginId)');
  });

  it('uses batched option writes and lifecycle sync in legacy Astro admin pages', () => {
    const pluginConfigSource = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
      'utf-8',
    );
    const pluginsSource = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugins.astro'),
      'utf-8',
    );
    const themesSource = readFileSync(
      join(process.cwd(), 'src/pages/admin/themes.astro'),
      'utf-8',
    );

    expect(pluginConfigSource).toContain('notifyEarlyRequestLifecycle(pluginId');
    expect(pluginConfigSource).not.toContain('bumpCacheVersion(ctx.db)');
    expect(pluginsSource).toContain('mutateOptionsBatch(db');
    expect(pluginsSource).toContain("type: 'deactivate'");
    expect(pluginsSource).toContain("type: 'activate'");
    expect(pluginsSource).not.toContain('bumpCacheVersion(db)');
    expect(themesSource).toContain('mutateOptionsBatch(ctx.db');
    expect(themesSource).not.toContain('bumpCacheVersion(ctx.db)');
  });

});
