import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/pages/admin/write-post.astro'),
  'utf-8',
);

describe('Typecho 1.3 post editor layout', () => {
  it('only renders an editable slug when the permalink format contains {slug}', () => {
    expect(source).toContain('renderPermalinkPattern');
    expect(source).toContain("const allowsSlugEdit = postPermalinkPattern.includes('{slug}')");
    expect(source).toContain('const siteUrl = urls.siteUrl.replace(');
    expect(source).not.toContain('new URL(permalinkPath');
    expect(source).toContain('id="slug" name="slug"');
    expect(source).toContain('{allowsSlugEdit ? (');
    expect(source).not.toContain('edit-slug-btn');
  });

  it('places custom fields below the editor rather than in the right sidebar', () => {
    const editor = source.indexOf('id="text" name="text"');
    const customField = source.indexOf('id="custom-field"');
    const sidebar = source.indexOf('id="edit-secondary"');

    expect(editor).toBeGreaterThan(-1);
    expect(customField).toBeGreaterThan(editor);
    expect(customField).toBeLessThan(sidebar);
  });

  it('uses the Typecho 1.3 details-based custom field layout', () => {
    expect(source).toContain('<details id="custom-field" class="typecho-post-option"');
    expect(source).toContain('<summary>自定义字段</summary>');
    expect(source).toContain('<ul class="fields mono">');
    expect(source).toContain('<li class="field">');
    expect(source).toContain('class="field-name"');
    expect(source).toContain('class="field-value"');
    expect(source).toContain('+添加字段');
    expect(source).toContain('{customFields.length === 0 && (');
    expect(source).toContain('placeholder="字段名称"');
    expect(source).toContain('name="fieldTypes[newfield_0]"');
    expect(source).not.toContain('custom-fields-table');
  });

  it('selects the configured default category when writing a new post', () => {
    expect(source).toContain('const defaultCategory = Number(options.defaultCategory);');
    expect(source).toContain('postCategories = [defaultCategory];');
  });

  it('orders the right-side modules like Typecho 1.3 and includes Trackback', () => {
    const date = source.indexOf('发布日期');
    const category = source.indexOf('>分类<');
    const tags = source.indexOf('>标签<');
    const advanced = source.indexOf('<details id="advance-panel">');

    expect(date).toBeLessThan(category);
    expect(category).toBeLessThan(tags);
    expect(tags).toBeLessThan(advanced);
    expect(source).toContain('id="trackback"');
    expect(source).toContain('name="trackback"');
  });

  it('uses the Typecho date-time picker instead of a browser datetime input', () => {
    expect(source).toContain('class="typecho-date w-100" type="text" name="date" id="date"');
    expect(source).toContain('/vendor/timepicker.js');
    expect(source).toContain("dateInput.mask('9999-99-99 99:99').datetimepicker({");
    expect(source).toContain("currentText: '现在'");
    expect(source).toContain("closeText: '完成'");
    expect(source).not.toContain('datetime-local');
  });

  it('includes the preview icon and persistent editor resize handle', () => {
    expect(source).toContain('<i class="i-exlink"></i> 预览文章');
    expect(source).toContain('/api/admin/editor-size');
    expect(source).toContain('class="resize"');
    expect(source).toContain("textarea.blur().css('opacity', 0.25)");
    expect(source).toContain("textarea.css('opacity', 1)");
  });
});
