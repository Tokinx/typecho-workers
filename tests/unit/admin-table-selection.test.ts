import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const adminLayout = readFileSync(join(process.cwd(), 'src/layouts/Admin.astro'), 'utf8');
const adminCss = readFileSync(join(process.cwd(), 'public/css/admin.css'), 'utf8');

describe('admin table selection', () => {
  it('implements the Typecho 1.3 selectable-row interaction', () => {
    expect(adminLayout).toContain("$('.typecho-list-table tbody').on('click', 'tr', function (event) {");
    expect(adminLayout).toContain("target.closest('input, textarea, select, a, button, i, label').length");
    expect(adminLayout).toContain("checkbox.prop('checked', !checkbox.prop('checked')).trigger('change');");
    expect(adminLayout).toContain("checkbox.closest('tr').toggleClass('checked', this.checked);");
    expect(adminLayout).toContain("$('.typecho-table-select-all').on('change', function () {");
  });

  it('highlights checkbox-selected rows with the Typecho 1.3 selector', () => {
    expect(adminCss).toContain('.typecho-list-table tbody tr:has(input[type="checkbox"]:checked)');
    expect(adminCss).toContain('background-color: #FFF9E8;');
  });
});
