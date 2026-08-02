import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readPage(name: string): string {
  return readFileSync(join(process.cwd(), `src/pages/admin/${name}.astro`), 'utf8');
}

describe('admin theme pages', () => {
  it('uses the Typecho 1.3 theme list structure without an editor tab', () => {
    const source = readPage('themes');
    expect(source).toContain('typecho-list-table typecho-theme-list');
    expect(source).toContain('typecho-option-tabs fix-tabs');
    expect(source).toContain('可以使用的外观');
    expect(source).toContain('设置外观');
    expect(source).not.toContain('编辑当前外观');
    expect(source).not.toContain('主题详情');
    expect(source).not.toContain('当前使用');
    expect(source).toContain("return '/img/noscreen.png'");
  });

  it('renders each appearance field as its own Typecho option list', () => {
    const source = readPage('options-theme');
    expect(source).toContain('col-mb-12 col-tb-8 col-tb-offset-2');
    expect(source).toContain('<ul class="typecho-option" id={`typecho-option-item-${key}-${index}`}>');
    expect(source).toContain('typecho-option-submit');
    expect(source).toContain('parseThemeConfigFormData');
    expect(source).toContain('class:list={{ multiline: field.multiline }}');
    expect(source).toContain('name={`${key}[]`}');
  });

  it('ships the Typecho default theme preview asset', () => {
    expect(existsSync(join(process.cwd(), 'src/themes/typecho-theme-minimal/screenshot.png'))).toBe(true);
  });
});
