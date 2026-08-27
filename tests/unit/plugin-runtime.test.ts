/**
 * Tests for the plugin runtime helpers introduced in Group 6.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addHook,
  doHook,
  applyFilter,
  hasHook,
  getPluginForAdminPage,
  getPluginAdminPageTitle,
  getPluginSettingsHref,
  registerPlugin,
  setActivatedPlugins,
  registerPluginInit,
  registerPluginLoaders,
  type HookContext,
} from '@/lib/plugin';

function mockCtx(): HookContext {
  return { activatedPlugins: new Set<string>() };
}

describe('addHook deduplication (G6-1)', () => {
  let ctx: HookContext;
  beforeEach(async () => {
    ctx = mockCtx();
    await setActivatedPlugins(ctx, ['p-dedupe']);
  });

  it('does not register the same handler twice for the same plugin', async () => {
    const calls: string[] = [];
    const handler = () => { calls.push('hit'); };
    addHook('post:finishPublish', 'p-dedupe', handler);
    addHook('post:finishPublish', 'p-dedupe', handler);
    expect(hasHook(ctx, 'post:finishPublish')).toBe(true);
    await doHook(ctx, 'post:finishPublish', { cid: 1 });
    expect(calls).toEqual(['hit']);
  });

  it('still registers different handlers from the same plugin', async () => {
    const calls: string[] = [];
    addHook('post:finishSave', 'p-dedupe', () => calls.push('a'));
    addHook('post:finishSave', 'p-dedupe', () => calls.push('b'));
    await doHook(ctx, 'post:finishSave', {});
    expect(calls.sort()).toEqual(['a', 'b']);
  });
});

describe('lazy plugin init (G6-3)', () => {
  it('only runs init for plugins listed as active', async () => {
    const inits = {
      'lazy-a': vi.fn(),
      'lazy-b': vi.fn(),
    };
    registerPluginInit(inits, { addHook, HookPoints: {} as any });

    const ctx = mockCtx();
    await setActivatedPlugins(ctx, ['lazy-a']);
    expect(inits['lazy-a']).toHaveBeenCalledTimes(1);
    expect(inits['lazy-b']).not.toHaveBeenCalled();

    // Reactivating the same plugin must not run init twice — the
    // module is already side-effected.
    await setActivatedPlugins(ctx, ['lazy-a']);
    expect(inits['lazy-a']).toHaveBeenCalledTimes(1);

    // Activating a previously dormant plugin runs its init now.
    await setActivatedPlugins(ctx, ['lazy-a', 'lazy-b']);
    expect(inits['lazy-b']).toHaveBeenCalledTimes(1);
  });

  it('isolates init failures per plugin', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    const bad = vi.fn(() => { throw new Error('boom'); });
    registerPluginInit({ 'lazy-good': good, 'lazy-bad': bad }, { addHook, HookPoints: {} as any });
    const ctx = mockCtx();
    await expect(setActivatedPlugins(ctx, ['lazy-bad', 'lazy-good'])).resolves.toBeUndefined();
    expect(good).toHaveBeenCalled();
    expect(bad).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('waits for async init before hooks are used', async () => {
    const handler = vi.fn();
    registerPluginInit({
      'lazy-async': async ({ addHook: register, pluginId }) => {
        await Promise.resolve();
        register('post:finishSave', pluginId, handler);
      },
    }, { addHook, HookPoints: {} as any });
    const ctx = mockCtx();

    await setActivatedPlugins(ctx, ['lazy-async']);
    await doHook(ctx, 'post:finishSave', {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it('loads an active plugin module once and keeps inactive modules unloaded', async () => {
    const activeInit = vi.fn();
    const activeLoader = vi.fn(async () => activeInit);
    const inactiveLoader = vi.fn(async () => vi.fn());
    registerPluginLoaders({
      'dynamic-active': activeLoader,
      'dynamic-inactive': inactiveLoader,
    }, { addHook, HookPoints: {} as any });
    const ctx = mockCtx();

    await setActivatedPlugins(ctx, ['dynamic-active']);
    await setActivatedPlugins(ctx, ['dynamic-active']);

    expect(activeLoader).toHaveBeenCalledOnce();
    expect(activeInit).toHaveBeenCalledOnce();
    expect(inactiveLoader).not.toHaveBeenCalled();
  });
});

describe('plugin admin pages', () => {
  it('resolves an admin page slug to the manifest display name', () => {
    registerPlugin('typecho-plugin-admin-page-test', {
      id: 'typecho-plugin-admin-page-test',
      name: 'Plugin Admin Page Test',
      adminPage: 'admin-page-test',
    });

    expect(getPluginForAdminPage('admin-page-test')?.manifest.name).toBe('Plugin Admin Page Test');
    expect(getPluginForAdminPage('missing-page')).toBeUndefined();
  });

  it('builds settings href and admin page title for custom settings UIs', () => {
    registerPlugin('typecho-plugin-settings-page', {
      id: 'typecho-plugin-settings-page',
      name: 'Notifier',
      adminPage: 'notifier-settings',
      adminPageTitle: 'Notifier 设置页面',
      adminPageIsSettings: true,
    });
    registerPlugin('typecho-plugin-ops-page', {
      id: 'typecho-plugin-ops-page',
      name: 'Notes',
      adminPage: 'notes',
    });
    registerPlugin('typecho-plugin-form-config', {
      id: 'typecho-plugin-form-config',
      name: 'Form Config',
      config: { enabled: { type: 'checkbox', label: 'On' } },
    });

    expect(getPluginSettingsHref('typecho-plugin-settings-page')).toBe('/admin/plugin/notifier-settings');
    expect(getPluginSettingsHref('typecho-plugin-ops-page')).toBeNull();
    expect(getPluginSettingsHref('typecho-plugin-form-config')).toBe(
      '/admin/plugin-config?id=typecho-plugin-form-config',
    );

    const settingsPlugin = getPluginForAdminPage('notifier-settings')!;
    expect(getPluginAdminPageTitle(settingsPlugin)).toBe('Notifier 设置页面');
    const opsPlugin = getPluginForAdminPage('notes')!;
    expect(getPluginAdminPageTitle(opsPlugin)).toBe('Notes');
  });
});
