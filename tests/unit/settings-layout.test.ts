import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readPage(name: string): string {
  return readFileSync(join(process.cwd(), `src/pages/admin/${name}.astro`), 'utf8');
}

function readAdminCss(): string {
  return readFileSync(join(process.cwd(), 'public/css/admin.css'), 'utf8');
}

function optionBlocks(source: string): RegExpMatchArray[] {
  return [...source.matchAll(/<ul (?=[^>]*class="typecho-option[^\"]*")(?=[^>]*id="typecho-option-item-[^\"]+")[^>]*>([\s\S]*?)<\/ul>/g)];
}

describe('Typecho 1.3 settings option layout', () => {
  it('gives every basic setting its own option list', () => {
    const source = readPage('options-general');
    expect(optionBlocks(source)).toHaveLength(11);
    expect(source).not.toContain('<ul class="typecho-option">');
    expect(source).toContain('typecho-option-item-title-0');
    expect(source).toContain('typecho-option-item-siteUrl-1');
    expect(source).toContain('typecho-option-item-allowXmlRpc-5');
    expect(source).toContain('name="attachmentTypes[]"');
    expect(source).toContain('name="attachmentTypesOther"');
    expect(source).toContain('typecho-option-item-submit-10');
    expect(source).toContain('name="cacheEnabled"');
    expect(source).toContain('name="robotsTxt"');
    expect(source).not.toContain('name="mailEnabled"');
  });

  it('gives every reading setting its own option list', () => {
    const source = readPage('options-reading');
    expect(optionBlocks(source)).toHaveLength(6);
    expect(source).not.toContain('<ul class="typecho-option">');
    expect(source).toContain('<ul class="typecho-option" id="typecho-option-item-frontPage-1">');
    expect(source).toContain('<ul class="typecho-option" id="typecho-option-item-feedFullText-4">');
    expect(source).toContain('postDateFormat-0-1" name="postDateFormat" type="text" class="w-40 mono"');
    expect(source).toContain('postsListSize-0-3" name="postsListSize" type="number" class="w-20"');
    expect(source).toContain('pageSize-0-4" name="pageSize" type="number" class="w-20"');
    expect(source).not.toContain('style="width: 40px;"');
    expect(source).not.toContain('其他设置');
    expect(source).not.toContain('editorSize');
  });

  it('keeps discussion groups as independent Form elements without nested lists', () => {
    const source = readPage('options-discussion');
    expect(optionBlocks(source)).toHaveLength(6);
    expect(source).not.toContain('<ul class="typecho-option">');
    expect(source).not.toContain('<ul>\n            <li>');
    expect(source).toContain('typecho-option-item-commentDateFormat-0');
    expect(source).toContain('typecho-option-item-commentsShow-2');
    expect(source).toContain('typecho-option-item-commentsPost-3');
    expect(source).toContain('不显示 Pingback 和 Trackback');
    expect(source).toContain('commentsShow-commentsAvatarRating">的头像</label>');
    expect(source).toContain('commentsShow-commentsPageSize" name="commentsPageSize" class="text num text-s"');
    expect(source).toContain('commentsShow-commentsMaxNestingLevels" name="commentsMaxNestingLevels" type="number"');
    expect(source).toContain('<span class="multiline">将');
    expect(source).toContain('commentsPost-commentsRequireUrl" name="commentsRequireUrl"');
    expect(source).toContain('commentsPost-commentsPostTimeout" name="commentsPostTimeout" class="text num text-s"');
    // Mail settings moved to the typecho-plugin-mailer plugin — the discussion
    // page no longer carries mail toggles or sender fields.
    expect(source).not.toContain('name="mailEnabled"');
    expect(source).not.toContain('name="mailFrom"');
    expect(source).not.toContain('name="mailFromName"');
    expect(source).not.toContain('name="commentEmailEnabled"');
    expect(source).not.toContain('name="commentEmailReplyEnabled"');
    expect(source).not.toContain('data-mail-settings="true"');
    expect(source).toContain('typecho-option-item-submit-10');
  });

  it('keeps permalink controls in separate option lists', () => {
    const source = readPage('options-permalink');
    expect(optionBlocks(source)).toHaveLength(4);
    expect(source).not.toContain('<ul class="typecho-option">');
    expect(source).toContain('typecho-option-item-permalinkPattern-0');
    expect(source).toContain('typecho-option-item-pagePattern-1');
    expect(source).toContain('typecho-option-item-categoryPattern-2');
  });

  it('renders each dynamic plugin config field as an option list', () => {
    const source = readPage('plugin-config');
    expect(source).not.toContain('<ul class="typecho-option">');
    expect(source).toContain('<ul class="typecho-option" id={`typecho-option-item-${key}-${fieldIndex}`}>');
    expect(source).toContain('style="display:none"');
    expect(source).toContain('typecho-option-item-submit');
  });

  it('uses Typecho Form attribute ordering in the profile page', () => {
    const source = readPage('profile');
    expect(source).not.toMatch(/<ul id="[^"]+" class="typecho-option/);
    expect(source).not.toMatch(/<label for="[^"]+" class="typecho-label"/);
    expect(source).toContain('<ul class="typecho-option" id="typecho-option-item-screenName-0">');
    expect(source).toContain('<label class="typecho-label" for="screenName-0-1">');
  });

  it('uses the global Typecho option selectors and dimensions', () => {
    const css = readAdminCss();
    expect(css).toContain('.typecho-option input.text { width: 100%; }');
    expect(css).toContain('.typecho-option input.num { width: 60px; }');
    expect(css).toContain('.typecho-option textarea { width: 100%; height: 100px; }');
    expect(css).not.toContain('.typecho-page-main .typecho-option input.text');
    expect(css).not.toContain('.typecho-page-main .typecho-option input.num');
  });
});
