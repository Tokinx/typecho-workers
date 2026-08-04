import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { plainExcerpt, readingMinutes, safeEmail, safeExternalUrl } from '../../src/themes/typecho-theme-warm/components/warm';

const themeRoot = join(process.cwd(), 'src/themes/typecho-theme-warm');

describe('typecho-theme-warm', () => {
  it('declares a complete Typecho theme package', () => {
    const pkg = JSON.parse(readFileSync(join(themeRoot, 'package.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(themeRoot, 'theme.json'), 'utf8'));
    expect(pkg.keywords).toEqual(expect.arrayContaining(['typecho', 'theme']));
    expect(manifest.id).toBe('typecho-theme-warm');
    expect(manifest.stylesheet).toBe('style.css');
    expect(manifest.config).not.toHaveProperty('tagline');
    expect(manifest.config).not.toHaveProperty('footerDescription');
  });

  it('keeps the five required templates and Notes integration', () => {
    for (const name of ['Index', 'Post', 'Page', 'Archive', 'NotFound']) {
      expect(readFileSync(join(themeRoot, 'components', `${name}.astro`), 'utf8')).toBeTruthy();
    }
    const index = readFileSync(join(themeRoot, 'components/Index.astro'), 'utf8');
    expect(index).toContain('getNotesForTheme');
    expect(index).toContain('variables.mixed');
    expect(index).toContain('mixedCategories');
    expect(index).toContain('inArray(schema.relationships.cid, mixedPostIds)');
    expect(index).not.toContain('categories: [],');
    expect(index).toContain('data-content-type="note"');
    expect(index).not.toContain('warm-list-heading');
    expect(index.indexOf('class="warm-category"')).toBeLessThan(index.indexOf('formatWarmDate(item.created)'));
    expect(index).not.toContain('item.categories[0] &&');
    const archive = readFileSync(join(themeRoot, 'components/Archive.astro'), 'utf8');
    expect(archive).not.toContain('warm-list-heading');
    expect(archive.indexOf('class="warm-category"')).toBeLessThan(archive.indexOf('formatWarmDate(post.created)'));
    expect(archive).not.toContain('post.categories[0] &&');
    const shell = readFileSync(join(themeRoot, 'components/WarmShell.astro'), 'utf8');
    expect(shell).toContain('options.description');
    expect(shell).not.toContain('settings.tagline');
    expect(shell).not.toContain('settings.footerDescription');
    expect(shell).toContain('warm-footer__statement');
    expect(shell).toContain('instantClickSource');
    expect(shell).toContain("init('mousedown')");
    expect(shell).toContain('data-instant-track');
    expect(shell).toContain('data-no-instant');
    const post = readFileSync(join(themeRoot, 'components/Post.astro'), 'utf8');
    expect(post).not.toContain('warm-back');
    const css = readFileSync(join(themeRoot, 'style.css'), 'utf8');
    expect(css).not.toContain('.warm-list-heading');
    expect(css).not.toContain('.warm-back');
    expect(readFileSync(join(themeRoot, 'components/instantclick.ts'), 'utf8')).toContain('InstantClick 3.1.0');
    const comments = readFileSync(join(themeRoot, 'components/WarmComments.astro'), 'utf8');
    expect(comments).toContain('/api/comments');
    expect(comments).toContain('data-comment-loading');
    expect(comments).not.toContain('WarmCommentList');
    expect(comments).not.toContain('{comments.length');
  });

  it('uses at most eight-pixel component radii', () => {
    const css = readFileSync(join(themeRoot, 'style.css'), 'utf8');
    const radii = [...css.matchAll(/border-radius:\s*(\d+)px/g)].map(match => Number(match[1]));
    expect(radii.length).toBeGreaterThan(0);
    expect(Math.max(...radii)).toBeLessThanOrEqual(8);
    expect(css).toContain('.warm-note__images.has-2');
    expect(css).toContain('.warm-note__images.has-3');
    expect(css).toContain('.warm-note__images.has-4');
  });

  it('normalizes excerpts, reading time, and configurable links', () => {
    expect(plainExcerpt('## 标题\n[链接](https://example.com) **正文**')).toBe('标题 链接 正文');
    expect(readingMinutes(`<p>${'字'.repeat(421)}</p>`)).toBe(2);
    expect(safeExternalUrl('javascript:alert(1)')).toBe('');
    expect(safeExternalUrl('https://example.com')).toBe('https://example.com/');
    expect(safeEmail('hello@example.com')).toBe('hello@example.com');
    expect(safeEmail('not-an-email')).toBe('');
  });
});
