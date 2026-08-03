import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('admin navigation', () => {
  it('uses the Typecho 1.3 header, menu, and details DOM structure', () => {
    const source = readProjectFile('src/layouts/Admin.astro');

    expect(source).toContain('<header class="typecho-head-nav" role="navigation">');
    expect(source).toContain('<details class="menu-bar">');
    expect(source).toContain('<summary>菜单</summary>');
    expect(source).toContain('<menu>');
    expect(source).toContain('<li class:list={{ focus: isFocus }}>');
    expect(source).toContain('<li class="operate">');
    expect(source).not.toContain('typecho-nav-list');
    expect(source).not.toContain("'root'");
    expect(source).not.toContain('class="child"');
  });

  it('retains a POST logout control inside the 1.3 operate menu', () => {
    const source = readProjectFile('src/layouts/Admin.astro');

    expect(source).toContain('<form method="post" action={urls.logoutUrl} class="logout-form">');
    expect(source).toContain('<button type="submit" class="exit">登出</button>');
  });

  it('uses the Typecho 1.3 sticky and responsive navigation rules', () => {
    const css = readProjectFile('public/css/admin.css');

    expect(css).toContain('.typecho-head-nav { padding: 0 10px; background: #292D33; position: sticky; top: 0; display: flex; z-index: 100; }');
    expect(css).toContain('.typecho-head-nav nav > menu { display: flex; position: relative; width: 100%; }');
    expect(css).toContain('.typecho-head-nav nav:has(.menu-bar[open]) { width: 70vw; height: 100%; }');
    expect(css).toContain('body:has(.menu-bar[open]) { overflow: hidden; }');
    expect(css).not.toContain('#typecho-nav-list');
  });

  it('inserts plugin navigation entries into the Typecho 1.3 menu structure', () => {
    const webdav = readProjectFile('src/plugins/typecho-plugin-webdav/index.ts');
    const notes = readProjectFile('src/plugins/typecho-plugin-notes/index.ts');

    expect(webdav).toContain(".typecho-head-nav nav > menu > li:nth-child(3) > menu");
    expect(notes).toContain(".typecho-head-nav nav > menu > li:nth-child('+rootIndex+')");
    expect(notes).toContain("':scope > menu a[href=\"'+afterHref+'\"]'");
    expect(webdav).not.toContain('typecho-nav-list');
    expect(notes).not.toContain('typecho-nav-list');
  });
});
