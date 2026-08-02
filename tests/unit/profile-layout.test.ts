import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/pages/admin/profile.astro'), 'utf-8');

describe('Typecho 1.3 personal settings layout', () => {
  it('shows the latest login in the profile sidebar', () => {
    expect(source).toContain('最后登录: {lastLogin}');
    expect(source).toContain("formatDate(user!.logged, 'Y-m-d H:i'");
  });

  it('keeps profile, writing, and password settings in the Typecho order', () => {
    const profile = source.indexOf('<h3>个人资料</h3>');
    const writing = source.indexOf('<section id="writing-option">');
    const password = source.indexOf('<section id="change-password">');
    expect(profile).toBeLessThan(writing);
    expect(writing).toBeLessThan(password);
    expect(source).toContain('{isContributor && (');
  });

  it('includes every user writing preference and the profile extension hook', () => {
    expect(source).toContain('name="markdown"');
    expect(source).toContain('name="xmlrpcMarkdown"');
    expect(source).toContain('name="autoSave"');
    expect(source).toContain('name="defaultAllow[]"');
    expect(source).toContain("applyFilterSafely(ctx, 'admin:profile:bottom'");
  });

  it('renders each Form element as its own Typecho option list', () => {
    for (const id of [
      'screenName-0', 'url-1', 'mail-2', 'do-3', 'submit-4',
      'markdown-5', 'xmlrpcMarkdown-6', 'autoSave-7', 'defaultAllow-8',
      'do-9', 'submit-10', 'password-11', 'confirm-12', 'do-13', 'submit-14',
    ]) {
      expect(source).toContain(`id="typecho-option-item-${id}"`);
    }

    const optionBlocks = [...source.matchAll(/<ul class="typecho-option[^\"]*" id="typecho-option-item-[^"]+"[^>]*>([\s\S]*?)<\/ul>/g)];
    expect(optionBlocks).toHaveLength(15);
    for (const [, block] of optionBlocks) {
      expect(block.match(/<li>/g)).toHaveLength(1);
    }
    expect(source).toContain('class="typecho-option typecho-option-submit"');
  });

  it('uses separate action-scoped forms', () => {
    expect(source).toContain('name="do" value="profile"');
    expect(source).toContain('name="do" value="options"');
    expect(source).toContain('name="do" value="password"');
    expect(source).not.toContain('name="mail" value={user!.mail || \'\'}');
  });
});
