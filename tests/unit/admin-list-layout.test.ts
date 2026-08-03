import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const listPages = [
  'manage-posts',
  'manage-pages',
  'manage-comments',
  'manage-categories',
  'manage-tags',
  'manage-users',
  'manage-medias',
];

describe('admin list layout', () => {
  it('removes legacy clearfix and table wrappers from Typecho 1.3 list pages', () => {
    for (const page of listPages) {
      const source = readProjectFile(`src/pages/admin/${page}.astro`);

      expect(source, page).not.toContain('typecho-list-operate clearfix');
      expect(source, page).not.toContain('typecho-table-wrap');
      expect(source, page).toContain('class="none"');
    }
  });

  it('places filter and bottom operation bars directly on their forms', () => {
    for (const page of ['manage-posts', 'manage-pages', 'manage-users', 'manage-medias']) {
      const source = readProjectFile(`src/pages/admin/${page}.astro`);

      expect(source, page).toContain('<form method="get" class="typecho-list-operate">');
      expect(source, page).not.toContain('<div class="typecho-list-operate">\n      <form method="get">');
      expect(source, page).not.toContain('operate-toolbar');
    }
  });

  it('keeps Typecho 1.3 category and tag bulk controls inside the POST form', () => {
    for (const page of ['manage-categories', 'manage-tags']) {
      const source = readProjectFile(`src/pages/admin/${page}.astro`);

      expect(source, page).toContain('<form method="post" name="manage_');
      expect(source, page).toContain('<div class="typecho-list-operate">');
    }
  });

  it('uses upstream operation spacing without legacy wrapper compatibility rules', () => {
    const css = readProjectFile('public/css/admin.css');

    expect(css).toContain('.typecho-list-operate .operate > * { margin-right: 5px; }');
    expect(css).toContain('.typecho-list-operate > *:nth-child(2).search > * { margin-left: 5px; }');
    expect(css).toContain('.typecho-list-operate { flex-flow: column; }');
    expect(css).not.toContain('operate-toolbar:only-child');
    expect(css).not.toContain('form:only-child');
    expect(css).not.toContain('.typecho-table-wrap');
  });

  it('keeps selection scoped to the direct POST form where no typecho-list wrapper exists', () => {
    const layout = readProjectFile('src/layouts/Admin.astro');

    expect(layout).toContain("root.is('form.operate-form')");
    expect(layout).toContain("root.find('.typecho-list-table tbody input[type=checkbox]')");
    expect(layout).toContain("inputNode.closest('form.typecho-list-operate').parent()");
    expect(layout).toContain("siblings('form.operate-form').first()");
  });

  it('uses the same list operation structure in the WebDAV management page', () => {
    const source = readProjectFile('src/plugins/typecho-plugin-webdav/index.ts');

    expect(source).toContain('<form method="get" class="typecho-list-operate" onsubmit="return false">');
    expect(source).not.toContain('typecho-list-operate clearfix');
    expect(source).not.toContain('class="typecho-table-wrap"');
  });

  it('keeps Typecho 1.3 page hierarchy and drag-order markup', () => {
    const source = readProjectFile('src/pages/admin/manage-pages.astro');
    const layout = readProjectFile('src/layouts/Admin.astro');

    expect(source).toContain("const rawParent = Astro.url.searchParams.get('parent') || ''");
    expect(source).toContain(": '管理独立页面'");
    expect(source).toContain('addLink={parentId > 0 ? `/admin/write-page?parent=${parentId}` : \'/admin/write-page\'}');
    expect(source).toContain('data-page-parent={String(parentId)}');
    expect(source).toContain('<th>子页面</th>');
    expect(source).toContain('id={`${pg.type}-${pg.cid}`}');
    expect(source).toContain('/admin/manage-pages?parent=${pg.cid}');
    expect(source).toContain('/admin/write-page?parent=${pg.cid}');
    expect(source).toContain("document.addEventListener('DOMContentLoaded', function () {");
    expect(source).toContain("$('.typecho-list-table').tableDnD({");
    expect(source).toContain("/api/admin/content-batch?do=sort&type=page");
    expect(source).toContain('{!keywords && (');
    expect(layout).toContain('addLink?: string;');
    expect(layout).toContain('{addLink && <a href={addLink}>新增</a>}');
  });
});
