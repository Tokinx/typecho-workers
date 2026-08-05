import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeCommentComponentLoadMode,
  normalizeCommentInitialLoadMode,
  normalizeContinuousLoadMode,
  plainExcerpt,
  readingMinutes,
  safeEmail,
  safeExternalUrl,
} from '../../src/themes/typecho-theme-warm/components/warm';

const themeRoot = join(process.cwd(), 'src/themes/typecho-theme-warm');

describe('typecho-theme-warm', () => {
  it('declares a complete Typecho theme package', () => {
    const pkg = JSON.parse(readFileSync(join(themeRoot, 'package.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(themeRoot, 'theme.json'), 'utf8'));
    expect(pkg.keywords).toEqual(expect.arrayContaining(['typecho', 'theme']));
    expect(manifest.id).toBe('typecho-theme-warm');
    expect(manifest.stylesheet).toBe('style.css');
    expect(manifest.publicHtml).toBe(true);
    expect(manifest.config).not.toHaveProperty('tagline');
    expect(manifest.config).not.toHaveProperty('footerDescription');
    expect(manifest.config.continuousLoadMode).toMatchObject({
      type: 'select', label: '内容列表', default: 'manual',
      options: {
        manual: '手动加载',
        'auto-2': '滚动加载 2 次',
        infinite: '无限滚动加载',
      },
    });
    expect(manifest.config.commentComponentLoadMode).toMatchObject({
      type: 'select', label: '评论组件', default: 'manual',
      options: {
        manual: '手动加载',
        dwell: '停留 3 秒加载',
        auto: '自动加载',
      },
    });
    expect(manifest.config.commentInitialLoadMode).toMatchObject({
      type: 'select', label: '评论列表', default: 'manual',
      options: {
        manual: '手动加载',
        'auto-first': '加载第一页',
        'auto-2': '滚动加载 2 次',
        infinite: '无限滚动加载',
      },
    });
  });

  it('keeps the five required templates and Notes integration', () => {
    for (const name of ['Index', 'Post', 'Page', 'Archive', 'NotFound']) {
      expect(readFileSync(join(themeRoot, 'components', `${name}.astro`), 'utf8')).toBeTruthy();
    }
    const index = readFileSync(join(themeRoot, 'components/Index.astro'), 'utf8');
    expect(index).toContain('getNotesStreamForTheme');
    expect(index).toContain('result.items');
    expect(index).not.toContain('getNotesForTheme');
    expect(index).toContain('isNotesStreamOutOfRange');
    expect(index).toContain('Astro.response.status = 404');
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
    expect(index).toContain('WarmStreamPagination');
    expect(index).toContain('data-warm-stream');
    expect(archive).toContain('WarmStreamPagination');
    const streamPagination = readFileSync(join(themeRoot, 'components/WarmStreamPagination.astro'), 'utf8');
    expect(streamPagination).toContain('data-warm-stream-pagination');
    expect(streamPagination).toContain('DOMParser');
    expect(streamPagination).toContain('IntersectionObserver');
    expect(streamPagination).toContain('automaticLoads < limit');
    expect(streamPagination).toContain('userHasScrolled');
    expect(streamPagination).toContain("window.addEventListener('scroll', onUserScroll");
    expect(streamPagination).toContain('automaticCooldown');
    expect(streamPagination).toContain('}, 1_000);');
    expect(streamPagination).not.toContain('link.hidden');
    expect(streamPagination).toContain('已加载全部内容');
    expect(streamPagination).toContain('aria-disabled="true"');
    expect(streamPagination).toContain("if (loading) {");
    expect(streamPagination).toContain("link.setAttribute('aria-disabled', 'true');");
    expect(streamPagination).toContain('automaticPaused = true;');
    expect(streamPagination).toContain('data-no-instant');
    expect(streamPagination).not.toContain('aria-hidden="true">→');
    expect(streamPagination).not.toContain('加载更多 <span');
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
    expect(post).not.toContain('continuousLoadMode={settings.continuousLoadMode}');
    expect(post).toContain('componentLoadMode={settings.commentComponentLoadMode}');
    expect(post).toContain('initialLoadMode={settings.commentInitialLoadMode}');
    const page = readFileSync(join(themeRoot, 'components/Page.astro'), 'utf8');
    expect(page).not.toContain('continuousLoadMode={settings.continuousLoadMode}');
    expect(page).toContain('componentLoadMode={settings.commentComponentLoadMode}');
    expect(page).toContain('initialLoadMode={settings.commentInitialLoadMode}');
    const css = readFileSync(join(themeRoot, 'style.css'), 'utf8');
    expect(css).not.toContain('.warm-list-heading');
    expect(css).not.toContain('.warm-back');
    expect(readFileSync(join(themeRoot, 'components/instantclick.ts'), 'utf8')).toContain('InstantClick 3.1.0');
    const comments = readFileSync(join(themeRoot, 'components/WarmComments.astro'), 'utf8');
    expect(comments).toContain('/api/comments');
    expect(comments).toContain('includeComments: \'0\'');
    expect(comments).not.toContain('commentOptions: CommentOptions');
    expect(comments).toContain('data-comment-loading');
    expect(comments).not.toContain('data-comment-total');
    expect(comments).toContain('data-comment-component-load');
    expect(comments).toContain('data-comment-load-component');
    expect(comments).toContain('>加载评论组件</button>');
    expect(comments).toContain('data-comment-initial-load');
    expect(comments).not.toContain('continuousLoadMode');
    expect(comments).not.toContain('data-comment-load-mode');
    expect(comments).toContain('data-comment-load-initial');
    expect(comments).toContain('data-comment-load-more');
    expect(comments).toContain('data-comment-load-status');
    expect(comments).toContain('data-comment-load-sentinel');
    expect(comments).toContain('已加载全部内容');
    expect(comments).toContain('if (!hasNext) {');
    expect(comments).not.toContain('nav?.remove()');
    expect(comments).not.toContain('button.hidden = canAutomaticallyLoad()');
    expect(comments).toContain("setPaginationStatus('正在加载...')");
    expect(comments).toContain("initialMode === 'auto-first'");
    expect(comments).toContain('loadComments(1)');
    expect(comments).toContain("initialMode === 'auto-2' ? 2");
    expect(comments).toContain("initialMode === 'infinite' ? Infinity");
    expect(comments).toContain("componentMode === 'auto'");
    expect(comments).toContain('componentMode === \'manual\'');
    expect(comments).toContain('commentsLoaded = true');
    expect(comments.indexOf('commentsLoaded = true')).toBeLessThan(comments.indexOf('renderPagination(activePagination)'));
    expect(comments).toContain('3_000');
    expect(comments).toContain('dwellTimer');
    expect(comments).toContain('setupPaginationObserver');
    expect(comments).not.toContain('WarmCommentList');
    expect(comments).not.toContain('{comments.length');
    const deferredStyles = css.slice(
      css.indexOf('.warm-comment-deferred {'),
      css.indexOf('.warm-comment-deferred.is-loading'),
    );
    expect(deferredStyles).not.toContain('border-top');
    expect(deferredStyles).not.toContain('border-bottom');
    expect(css).toContain('.warm-comment-deferred button[data-comment-load-initial][hidden]');
    expect(index).not.toContain('warm-comment-count');
    expect(index).not.toContain('comments: post.commentsNum');
    expect(index).not.toContain('comments: item.comments');
  });

  it('normalizes excerpts, reading time, and configurable links', () => {
    expect(plainExcerpt('## 标题\n[链接](https://example.com) **正文**')).toBe('标题 链接 正文');
    expect(readingMinutes(`<p>${'字'.repeat(421)}</p>`)).toBe(2);
    expect(safeExternalUrl('javascript:alert(1)')).toBe('');
    expect(safeExternalUrl('https://example.com')).toBe('https://example.com/');
    expect(safeEmail('hello@example.com')).toBe('hello@example.com');
    expect(safeEmail('not-an-email')).toBe('');
    expect(normalizeCommentComponentLoadMode('dwell')).toBe('dwell');
    expect(normalizeCommentComponentLoadMode('manual')).toBe('manual');
    expect(normalizeCommentComponentLoadMode('invalid')).toBe('manual');
    expect(normalizeContinuousLoadMode('auto-2')).toBe('auto-2');
    expect(normalizeContinuousLoadMode('invalid')).toBe('manual');
    expect(normalizeCommentInitialLoadMode('dwell')).toBe('auto-first');
    expect(normalizeCommentInitialLoadMode('auto-first')).toBe('auto-first');
    expect(normalizeCommentInitialLoadMode('auto-2')).toBe('auto-2');
    expect(normalizeCommentInitialLoadMode('dwell-auto-2')).toBe('auto-2');
    expect(normalizeCommentInitialLoadMode('infinite')).toBe('infinite');
    expect(normalizeCommentInitialLoadMode('auto')).toBe('auto-first');
    expect(normalizeCommentInitialLoadMode('invalid')).toBe('manual');
  });
});
