import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/pages/admin/write-page.astro'),
  'utf-8',
);

describe('Typecho 1.3 page editor layout', () => {
  it('only renders an editable slug when the page URL pattern contains {slug}', () => {
    expect(source).toContain('renderPermalinkPattern');
    expect(source).toContain("const allowsSlugEdit = pagePermalinkPattern.includes('{slug}')");
    expect(source).toContain('id="slug" name="slug"');
    expect(source).toContain('{allowsSlugEdit ? (');
    expect(source).not.toContain('edit-slug-btn');
  });

  it('does not report the slug width initialization as an edit', () => {
    const slugSection = source.slice(source.indexOf('// 缩略名'), source.indexOf('// ========== 自定义字段'));

    expect(slugSection).toContain('}).each(function () {');
    expect(slugSection).not.toContain(".trigger('input')");
  });

  it('places custom fields below the editor using the Typecho details layout', () => {
    const editor = source.indexOf('id="text" name="text"');
    const customField = source.indexOf('id="custom-field"');
    const sidebar = source.indexOf('id="edit-secondary"');

    expect(customField).toBeGreaterThan(editor);
    expect(customField).toBeLessThan(sidebar);
    expect(source).toContain('<details id="custom-field" class="typecho-post-option"');
    expect(source).toContain('<ul class="fields mono">');
    expect(source).toContain('class="field-name"');
    expect(source).toContain('class="field-value"');
    expect(source).toContain('{customFields.length === 0 && (');
    expect(source).toContain('placeholder="字段名称"');
    expect(source).toContain('name="fieldTypes[newfield_0]"');
    expect(source).not.toContain('custom-fields-table');
  });

  it('orders the page options like Typecho 1.3', () => {
    const date = source.indexOf('发布日期');
    const order = source.indexOf('页面顺序');
    const template = source.indexOf('自定义模板');
    const parent = source.indexOf('父级页面');
    const advanced = source.indexOf('<details id="advance-panel">');

    expect(date).toBeLessThan(order);
    expect(order).toBeLessThan(template);
    expect(template).toBeLessThan(parent);
    expect(parent).toBeLessThan(advanced);
    expect(source).toContain('type="number" id="order"');
    expect(source).toContain('<select name="template" id="template">');
    expect(source).toContain('<option value="" selected={!page?.template}>不选择</option>');
    expect(source).not.toContain('<input type="text" id="template"');
    expect(source).toContain('name="parent" id="parent"');
  });

  it('preselects the requested parent when creating a child page', () => {
    expect(source).toContain("const rawRequestedParent = Astro.url.searchParams.get('parent') || ''");
    expect(source).toContain('const initialParentId = parentPageOptions.some');
    expect(source).toContain('const selectedParentId = page?.parent ?? initialParentId');
    expect(source).toContain('title={pageEditorTitle}');
    expect(source).toContain('selected={selectedParentId === parent.cid}');
  });

  it('uses the Typecho date picker, preview icon, and persisted resize handle', () => {
    expect(source).toContain('class="typecho-date w-100" type="text" name="date" id="date"');
    expect(source).toContain('/vendor/timepicker.js');
    expect(source).toContain("dateInput.mask('9999-99-99 99:99').datetimepicker({");
    expect(source).toContain('<i class="i-exlink"></i> 预览页面');
    expect(source).toContain('form[name="write_page"]');
    expect(source).toContain('/api/admin/editor-size');
    expect(source).toContain("textarea.blur().css('opacity', 0.25)");
    expect(source).toContain("textarea.css('opacity', 1)");
  });

  it('opens the saved draft in a full-theme preview iframe', () => {
    expect(source).toContain("$(document.body).addClass('fullscreen preview')");
    expect(source).toContain(".attr('src', '/admin/preview?cid=' + encodeURIComponent(cid))");
    expect(source).toContain(".attr('sandbox', 'allow-same-origin allow-scripts')");
    expect(source).toContain("window.confirm('修改后的内容需要保存后才能预览, 是否保存?')");
    expect(source).toContain('previewData(draftId || cid)');
    expect(source).toContain("$(window).on('message.writePagePreview'");
    expect(source).not.toContain("$('.wmd-edittab a[href=\"#wmd-preview\"]').trigger('click')");
  });

  it('sends the CSRF header with attachment upload and deletion requests', () => {
    const attachmentSection = source.slice(source.indexOf('// ========== 文件上传 =========='));
    const csrfHeader = "headers: { 'X-CSRF-Token': String($('form[name=\"write_page\"] input[name=\"_\"]').val() || '') },";

    expect(attachmentSection).toContain("url: '/api/admin/upload'");
    expect(attachmentSection).toContain("url: '/api/admin/upload?cid=' + attachCid");
    expect(attachmentSection.match(new RegExp(csrfHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('uses personal writing preferences for defaults and autosave', () => {
    expect(source).toContain("inArray(schema.options.name, ['markdown', 'autoSave'");
    expect(source).toContain("userPreference('markdown'");
    expect(source).toContain("userPreference('defaultAllowComment'");
    expect(source).toContain('data-auto-save={autoSave ? \'1\' : \'0\'}');
    expect(source).toContain("data.set('autosave', '1')");
    expect(source).toContain('name="autosaveDraftId"');
  });

  it('does not warn about leaving after a publish or draft save is submitted', () => {
    expect(source).toContain('submitting = false');
    expect(source).toContain('submitting = true;');
    expect(source).toContain('changed = false;');
    expect(source).toContain("if (!submitting && changed) return '内容已经改变尚未保存, 您确认要离开此页面吗?';");
  });
});
