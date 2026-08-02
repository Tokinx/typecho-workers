import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/pages/admin/plugins.astro'), 'utf-8');
const css = readFileSync(join(process.cwd(), 'public/css/admin.css'), 'utf-8');

describe('Typecho 1.3 plugin management layout', () => {
  it('separates active and inactive plugins into Typecho list tables', () => {
    expect(source).toContain('<div class="col-mb-12 typecho-list">');
    expect(source).toContain('启用的插件');
    expect(source).toContain('禁用的插件');
    expect(source).toContain('<table class="typecho-list-table deactivate">');
    expect(source).not.toContain('typecho-table-wrap');
    expect(source).not.toContain('已发现 {pluginCount} 个插件');
  });

  it('uses the 1.3.0 five-column responsive table structure', () => {
    expect(source).toContain('<col width="25%" />');
    expect(source).toContain('<col width="45%" />');
    expect(source).toContain('<col width="8%" class="kit-hidden-mb" />');
    expect(source).toContain('<col width="10%" class="kit-hidden-mb" />');
    expect(source).toContain('<th class="kit-hidden-mb">作者</th>');
    expect(source).toContain('没有安装插件');
    expect(source).toContain('此插件文件已经损坏或者被不安全移除');
  });

  it('keeps plugin actions POST-backed while presenting link-style controls', () => {
    expect(source).toContain('class="plugin-action-form"');
    expect(source).toContain('name="action" value="activate"');
    expect(source).toContain('name="action" value="deactivate"');
    expect(source).toContain('class="plugin-action-link"');
    expect(source).toContain('encodeURIComponent(plugin.id)');
    expect(css).toContain('.plugin-action-form { display: inline; margin: 0; }');
    expect(css).toContain('.plugin-action-link { appearance: none;');
  });
});
