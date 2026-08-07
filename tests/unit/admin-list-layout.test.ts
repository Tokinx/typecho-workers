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

  it('uses the Typecho 1.3 tag cloud and keeps its merge target in the operation menu', () => {
    const source = readProjectFile('src/pages/admin/manage-tags.astro');

    expect(source).toContain('class="typecho-list-notable tag-list"');
    expect(source).not.toContain('<table class="typecho-list-table">');
    expect(source).toContain('<span rel={`/admin/manage-tags?mid=${tag.mid}`}>{tag.name}</span>');
    expect(source).toContain('class="tag-edit-link"');
    expect(source).not.toContain('<h4>');
    expect(source).toContain('class="btn merge btn-s"');
    expect(source).toContain('name="merge"');
    expect(source).toContain('/api/admin/meta?action=merge&type=tag');
    expect(source).toContain('编辑标签 ${editTag.name');
    expect(source).toContain("editTag ? '更新标签' : '增加标签'");
    expect(source).toContain('编辑标签 ${editTag.name || \'未命名标签\'}');
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
    expect(layout).toContain("root.find('.typecho-list-notable input[type=checkbox]')");
    expect(layout).toContain("inputNode.closest('form.typecho-list-operate').parent()");
    expect(layout).toContain("siblings('form.operate-form').first()");
  });

  it('keeps native controls inside an operation menu open for interaction', () => {
    const layout = readProjectFile('src/layouts/Admin.astro');

    expect(layout).toContain("$('.dropdown-menu').on('click', function (event) {");
    expect(layout).toContain('event.stopPropagation();');
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

  it('keeps Typecho 1.3 category hierarchy, merge, and separate editor markup', () => {
    const list = readProjectFile('src/pages/admin/manage-categories.astro');
    const editor = readProjectFile('src/pages/admin/category.astro');

    expect(list).toContain("addLink={parentId > 0 ? `/admin/category?parent=${parentId}` : '/admin/category'}");
    expect(list).toContain("? `管理 ${parentCategory.name || '未命名分类'} 的子分类`");
    expect(list).toContain('data-category-parent={String(parentId)}');
    expect(list).toContain('<th class="kit-hidden-mb">子分类</th>');
    expect(list).toContain('id={`mid-${category.mid}`}');
    expect(list).toContain('/admin/manage-categories?parent=${category.mid}');
    expect(list).toContain('/admin/category?parent=${category.mid}');
    expect(list).toContain('<li class="multiline">');
    expect(list).toContain('class="btn merge btn-s"');
    expect(list).toContain('table.tableDnD({');
    expect(list).toContain('/api/admin/meta?action=sort&type=category');
    expect(list).not.toContain('typecho-mini-panel');

    expect(editor).toContain('col-tb-6 col-tb-offset-3');
    expect(editor).toContain('name="parent"');
    expect(editor).toContain('excludedParentIds');
    expect(editor).toContain('name="description"');
    expect(editor).toContain("editCategory ? '编辑分类' : '增加分类'");
  });
});
