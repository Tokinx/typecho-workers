import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(join(process.cwd(), 'src/pages/admin/manage-comments.astro'), 'utf8');
const adminCss = readFileSync(join(process.cwd(), 'public/css/admin.css'), 'utf8');

describe('admin manage comments page', () => {
  it('uses the Typecho 1.3 list operation and table structure', () => {
    expect(pageSource).toContain('<div class="typecho-list-operate">');
    expect(pageSource).toContain('<form method="get" class="typecho-list-operate">');
    expect(pageSource).toContain('<form method="post" name="manage_comments" class="operate-form">');
    expect(pageSource).toContain('<table class="typecho-list-table">');
    expect(pageSource).not.toContain('typecho-table-wrap');
    expect(pageSource).toContain('<td colspan="4" class="none">没有评论</td>');
    expect(pageSource).toContain('class="kit-hidden"');
    expect(pageSource).toContain("import { renderCommentText } from '@/lib/markdown';");
    expect(pageSource).toContain('set:html={commentHtml.get(comment.coid) || \'\'}');
  });

  it('keeps a comment row in place until its full edit data is loaded', () => {
    const requestIndex = pageSource.indexOf('loaded = await loadComment(coid);');
    const hideIndex = pageSource.indexOf('row.hidden = true;', requestIndex);

    expect(requestIndex).toBeGreaterThan(-1);
    expect(hideIndex).toBeGreaterThan(requestIndex);
    expect(pageSource).toContain("edit.setAttribute('data-id', row.id);");
    expect(pageSource).toContain("var id = row.getAttribute('data-id');");
    expect(pageSource).toContain("infoForm.className = 'comment-edit-info';");
    expect(pageSource).toContain("contentForm.className = 'comment-edit-content';");
  });

  it('uses the Typecho 1.3 flex operation-bar styles', () => {
    expect(adminCss).toContain('.typecho-list-operate { display: flex; margin: 1em 0; }');
    expect(adminCss).toContain('.typecho-list-operate + .typecho-list-operate { margin-top: 0; }');
    expect(adminCss).toContain('.typecho-pager { display: flex; align-items: center; justify-content: flex-end;');
    expect(adminCss).toContain('.comment-action button.operate-edit { color: #007700; }');
    expect(adminCss).toContain('.comment-action button.operate-reply { color: #545c30; }');
    expect(adminCss).toContain('.comment-action button.operate-delete { color: #B94A48; }');
  });
});
