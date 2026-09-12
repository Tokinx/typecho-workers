import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  WARM_THEME_ID,
  normalizeCommentComponentLoadMode,
  normalizeCommentInitialLoadMode,
  normalizeContinuousLoadMode,
  plainExcerpt,
  prepareArticleToc,
  readingMinutes,
  safeEmail,
  safeExternalUrl,
  warmSettings,
  warmArticleSummary,
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
    expect(manifest.config.imageOptimizeParams).toMatchObject({
      type: 'text', label: '图片优化参数', default: '',
      description: '适用于站内所有图片，示例：?quality=80',
    });
    expect(manifest.config.thumbOptimizeParams).toMatchObject({
      type: 'text', label: '缩略图优化参数', default: '',
      description: '适用于主题所有缩略图位置，示例：?quality=80&width=500',
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
    expect(index.indexOf('class="warm-category"')).toBeGreaterThan(index.indexOf('formatWarmDate(item.created, options.postDateFormat, options.timezone)'));
    expect(index).toContain('formatWarmDate(item.created, options.postDateFormat, options.timezone, true)');
    expect(index).not.toContain('item.categories[0] &&');
    // Note bodies and note grids on the index carry EdgeOne optimization params.
    expect(index).toContain("optimizeContentImages(item.html, settings.imageOptimizeParams, urls.siteUrl)");
    expect(index).toContain('optimizeParams={settings.imageOptimizeParams}');
    expect(index).toContain('thumbParams={settings.thumbOptimizeParams}');
    expect(index).toContain('siteUrl={urls.siteUrl}');
    const archive = readFileSync(join(themeRoot, 'components/Archive.astro'), 'utf8');
    expect(archive).not.toContain('warm-list-heading');
    expect(archive.indexOf('class="warm-category"')).toBeGreaterThan(archive.indexOf('formatWarmDate(post.created, options.postDateFormat, options.timezone)'));
    expect(archive).not.toContain('post.categories[0] &&');
    expect(index).toContain('WarmStreamPagination');
    expect(index).toContain('data-warm-stream');
    expect(archive).toContain('WarmStreamPagination');
    const streamPagination = readFileSync(join(themeRoot, 'components/WarmStreamPagination.astro'), 'utf8');
    expect(streamPagination).toContain('data-warm-stream-pagination');
    expect(streamPagination).toContain('DOMParser');
    expect(streamPagination).toContain('IntersectionObserver');
    expect(streamPagination).toContain("{ rootMargin: '0px 0px -20% 0px' }");
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
    expect(shell).not.toContain('warm-footer__statement');
    expect(shell).toContain('warm-brand__description');
    expect(shell).toContain('warm-footer__tagline');
    expect(shell).toContain('instantClickSource');
    expect(shell).toContain("init('mousedown')");
    expect(shell).toContain('data-instant-track');
    expect(shell).toContain('data-no-instant');
    expect(shell).toContain('warmRepairNoteMedia');
    expect(shell).toContain("window.addEventListener('instantclick:newpage', () => repairNoteMedia(document));");
    expect(shell).toContain('.warm-note__media video, .warm-note__media audio');
    expect(shell).toContain("media.dataset.warmRepaired === '1'");
    expect(shell).toContain("media.dataset.warmRepaired = '1';");
    expect(shell).toContain('media.load()');
    expect(shell).toContain('viewImageSource');
    // iOS Safari can emit focusout with no relatedTarget before the synthetic
    // click for a touched dropdown link. The menu must remain open for it.
    expect(shell).toContain("if (event.relatedTarget && !dropdown.contains(event.relatedTarget)) dropdown.open = false;");
    // Lightbox targets are limited to image links and bare images; plain
    // text links must keep navigating, with a :has() capability fallback.
    expect(shell).toContain("CSS.supports('selector(a:has(> img))')");
    expect(shell).toContain("'[view-image] a:has(> img), [view-image] img:not(a img)'");
    expect(shell).toContain("'[view-image] img'");
    expect(shell).toContain('data-warm-images-more');
    expect(shell).toContain('data-warm-images-rest');
    expect(shell).toContain("grid.classList.add('is-expanded')");
    expect(streamPagination).toContain("if (typeof window.warmRepairNoteMedia === 'function') window.warmRepairNoteMedia(stream);");
    const post = readFileSync(join(themeRoot, 'components/Post.astro'), 'utf8');
    expect(post).not.toContain('warm-back');
    expect(post).not.toContain('continuousLoadMode={settings.continuousLoadMode}');
    expect(post).toContain('<span class="warm-note-label">笔记</span>');
    expect(post).toContain('formatWarmDate(post.created, options.postDateFormat, options.timezone, isNote)');
    expect(post).toContain('componentLoadMode={settings.commentComponentLoadMode}');
    expect(post).toContain('initialLoadMode={settings.commentInitialLoadMode}');
    // Article/note body images open the ViewImage lightbox too.
    expect(post).toContain('class:list={["warm-prose", { "warm-note-prose": isNote }]} view-image');
    // Content bodies carry EdgeOne optimization params on same-origin images.
    expect(post).toContain("optimizeContentImages(");
    expect(post).toContain('settings.imageOptimizeParams');
    expect(post).toContain("urls.siteUrl");
    const page = readFileSync(join(themeRoot, 'components/Page.astro'), 'utf8');
    expect(page).not.toContain('continuousLoadMode={settings.continuousLoadMode}');
    expect(page).toContain('<span class="warm-note-label">独立页面</span>');
    expect(page).toContain('formatWarmDate(page.created, options.postDateFormat, options.timezone)');
    expect(page).toContain('componentLoadMode={settings.commentComponentLoadMode}');
    expect(page).toContain('initialLoadMode={settings.commentInitialLoadMode}');
    expect(page).toContain('class="warm-prose" view-image');
    expect(page).toContain("optimizeContentImages(page.content, settings.imageOptimizeParams, urls.siteUrl)");
    const css = readFileSync(join(themeRoot, 'style.css'), 'utf8');
    expect(css).not.toContain('.warm-list-heading');
    expect(css).not.toContain('.warm-back');
    expect(css).toContain('.warm-comments {\n  margin: 40px 0;\n}');
    expect(readFileSync(join(themeRoot, 'components/instantclick.ts'), 'utf8')).toContain('InstantClick 3.1.0');
    const comments = readFileSync(join(themeRoot, 'components/WarmComments.astro'), 'utf8');
    const commentList = readFileSync(join(themeRoot, 'components/WarmCommentList.astro'), 'utf8');
    expect(comments).toContain('/api/comments');
    expect(comments).toContain("params.set('includeComments', '0')");
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
    expect(comments).toContain("{ rootMargin: '0px 0px -20% 0px' }");
    expect(comments).toContain('comment.date ||');
    expect(comments).not.toContain('formatCommentDate');
    expect(comments).not.toContain('new Intl.DateTimeFormat');
    expect(commentList).toContain('formatWarmDate(comment.created, commentOptions.dateFormat, commentOptions.timezone)');
    expect(commentList).toContain('class="warm-comment__content warm-prose"');
    expect(comments).toContain('class="warm-comment__content warm-prose">${comment.text}</div>');
    expect(comments).toContain('已加载全部内容');
    expect(comments).toContain('const renderComments = (data, list, append, automatic) => {');
    expect(comments).toContain('const loadInitialComments = async requestedPage => {');
    expect(comments).toContain('await loadMetadata(requestedPage, true);');
    expect(comments).toContain('renderComments(data, list, false, true);');
    expect(comments).toContain("if (!includeComments) params.set('includeComments', '0');");
    expect(comments).toContain("await loadInitialComments(initialMode === 'auto-first' ? 1 : page);");
    expect(comments).toContain('if (!hasNext) {');
    expect(comments).not.toContain('nav?.remove()');
    expect(comments).not.toContain('button.hidden = canAutomaticallyLoad()');
    expect(comments).toContain("setPaginationStatus('正在加载...')");
    expect(comments).toContain("initialMode === 'auto-first'");
    expect(comments).toContain("await loadInitialComments(initialMode === 'auto-first' ? 1 : page);");
    expect(comments).toContain("initialMode === 'auto-2' ? 2");
    expect(comments).toContain("initialMode === 'infinite' ? Infinity");
    expect(comments).toContain("componentMode === 'auto'");
    expect(comments).toContain('componentMode === \'manual\'');
    expect(comments).toContain("renderComponentPrompt(root, '', true, false);");
    expect(comments).toContain('componentScrollStarted');
    expect(comments).toContain('componentScrollHandler');
    expect(comments).toContain("window.addEventListener('scroll', componentScrollHandler");
    expect(comments).toContain('button.hidden = loadingState');
    expect(comments).toContain('if (!componentScrollStarted || dwellTimer || metadataLoaded || metadataRequest) return;');
    expect(comments).toContain('const cleanupStalePage = () => {');
    expect(comments).toContain('if (root.isConnected) return;');
    expect(comments).toContain("window.addEventListener('instantclick:newpage', cleanupStalePage);");
    expect(comments).not.toContain("window.addEventListener('instantclick:newpage', stopInitialLoader, { once: true });");
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
    expect(css).toContain('.warm-comment__content p:last-child {');
    expect(css).toContain('.warm-comment__content p:last-child {\n  margin: 0;\n}');
    expect(css).toContain('.warm-comment-deferred button[data-comment-load-initial][hidden]');
    expect(index).not.toContain('warm-comment-count');
    expect(index).not.toContain('comments: post.commentsNum');
    expect(index).not.toContain('comments: item.comments');
  });


  it('uses the reference reading hierarchy with hero and comment-form breakout', () => {
    const css = readFileSync(join(themeRoot, 'style.css'), 'utf8');
    const shell = readFileSync(join(themeRoot, 'components/WarmShell.astro'), 'utf8');
    const post = readFileSync(join(themeRoot, 'components/Post.astro'), 'utf8');
    const page = readFileSync(join(themeRoot, 'components/Page.astro'), 'utf8');
    const comments = readFileSync(join(themeRoot, 'components/WarmComments.astro'), 'utf8');
    expect(css).toContain('--warm-bg: #fff;');
    expect(css).toContain('--warm-page-width: 840px;');
    expect(css).toContain('--warm-breakout-width: 1040px;');
    expect(css).toContain('--warm-font: Inter, ui-sans-serif, system-ui');
    expect(css).toMatch(/\.warm-article__header h1 \{[^}]*font-family: var\(--warm-serif\)/);
    expect(css).not.toMatch(/\.warm-prose > :is\(pre, figure, table\)[^{]*,[^{]*\.warm-note/);
    expect(css).toContain('margin-inline: calc(-1 * var(--warm-gutter));');
    expect(css).toMatch(/\.warm-stream-item \{[^}]*padding: var\(--warm-gutter\)/);
    expect(css).toContain('@media (max-width: 639px)');
    expect(css).toContain('animation-iteration-count: 1 !important;');
    expect(css).toMatch(/\.warm-article__hero \{[^}]*width: min\(var\(--warm-breakout-width\), 100vw\)/);
    expect(css).toMatch(/\.warm-comment-form \{[^}]*width: min\(var\(--warm-breakout-width\), 100vw\)/);
    expect(css).toContain('.warm-comment-form__inner');
    expect(comments).toContain('class="warm-comment-form__inner"');
    expect(shell).toContain('class="warm-skip-link" href="#warm-content"');
    expect(shell).toContain('id="warm-content"');
    expect(shell).not.toContain('fonts.googleapis.com');
    expect(shell).not.toContain('@tailwindcss/browser');
    expect(shell).toContain('>全部文章</a>');
    expect(shell.match(/<summary>[\s\S]*?<\/summary>/)?.[0]).not.toContain('<a');
    expect(post).toContain('"warm-article__hero": !isNote');
    expect(post).toContain("const summary = isNote ? '' : warmArticleSummary(post, engineSummary);");
    expect(post).toContain("pluginCtx.activatedPlugins.has('typecho-plugin-engine')");
    expect(post).toContain('await readSummary(db, post.cid)');
    expect(post).toContain('{summary && <p class="warm-article__summary">{summary}</p>}');
    expect(post).not.toContain('warm-post-nav');
    expect(post).not.toContain('prevPost');
    expect(post).not.toContain('nextPost');
    expect(css).not.toContain('.warm-post-nav');
    expect(page).toContain('warm-article__header warm-article__hero');
    for (const template of ['Index', 'Archive']) {
      expect(readFileSync(join(themeRoot, `components/${template}.astro`), 'utf8')).not.toContain('warm-read-more');
    }
  });

  it('preserves note media columns, gaps, aspect ratio, mobile height and expansion', () => {
    const css = readFileSync(join(themeRoot, 'style.css'), 'utf8');
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = css.match(new RegExp(`^${escaped} \u007b`, 'm'));
      const start = match?.index ?? -1;
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('}', start) + 1);
    };
    expect(rule('.warm-note__images')).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    for (const columns of [2, 3, 4]) {
      expect(rule(`.warm-note__images.has-${columns}`)).toContain(`grid-template-columns: repeat(${columns}, minmax(0, 1fr));`);
    }
    for (const selector of ['.warm-note__images', '.warm-note__media', '.warm-note__attachments']) {
      expect(rule(selector)).toContain('gap: 8px;');
      expect(rule(selector)).toContain('margin-top: 15px;');
    }
    for (const selector of ['.warm-note__media', '.warm-note__attachments']) {
      expect(rule(selector)).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    }
    expect(rule('.warm-note__images img')).toContain('aspect-ratio: 4 / 3;');
    expect(rule('.warm-note__images img')).toContain('border-radius: 0;');
    expect(rule('.warm-note__images img')).toContain('object-fit: cover;');
    expect(rule('.warm-note__images-more')).toContain('border-radius: 0;');
    expect(rule('.warm-note__media-item video')).toContain('border-radius: 0;');
    expect(rule('.warm-note__attachment')).toContain('border-radius: 0;');
    expect(rule('.warm-note__attachment-ext')).toContain('border-radius: 0;');
    expect(rule('.warm-comment__avatar')).toContain('border-radius: 0;');
    expect(css).not.toContain('box-shadow:');
    expect(css).toMatch(/@media \(max-width: 680px\) \{\s*\.warm-note__images img \{\s*height: 125px;/);
    expect(rule('.warm-note__images--detail')).toContain('margin-top: 28px;');
    expect(rule('.warm-note__image--rest')).toContain('display: none;');
    expect(rule('.warm-note__images.is-expanded .warm-note__image--rest')).toContain('display: block;');
    expect(rule('.warm-note__images.is-expanded .warm-note__images-more')).toContain('display: none;');
  });

  it('shows hero summary only from Engine 智能摘要 when readable', () => {
    const post = { hasPassword: false, passwordVerified: false };
    expect(warmArticleSummary(post, '这是智能摘要。')).toBe('这是智能摘要。');
    expect(warmArticleSummary(post, '  ')).toBe('');
    expect(warmArticleSummary(post, null)).toBe('');
    expect(warmArticleSummary(post, undefined)).toBe('');
    expect(warmArticleSummary({ ...post, hasPassword: true }, '这是智能摘要。')).toBe('');
    expect(warmArticleSummary({ ...post, hasPassword: true, passwordVerified: true }, '这是智能摘要。')).toBe('这是智能摘要。');
  });

  it('renders every note image with a "+N" overlay and ViewImage lightbox', () => {
    const media = readFileSync(join(themeRoot, 'components/WarmNoteMedia.astro'), 'utf8');
    // All images are rendered; the fourth-cell overlay reveals the rest.
    expect(media).not.toContain('(note.images || []).slice(0, 4)');
    expect(media).toContain('images.slice(0, 4)');
    expect(media).toContain('images.slice(4)');
    expect(media).toContain('extraCount');
    expect(media).toContain('view-image');
    expect(media).toContain('data-warm-images-more');
    expect(media).toContain('data-warm-images-rest');
    expect(media).toContain('warm-note__image--more');
    expect(media).toContain('warm-note__image--rest');
    expect(media).toContain('aria-label={`展开剩余 ${extraCount} 张图片`}');
    expect(media).toContain('hidden');
    // Every thumbnail is wrapped in a lightbox link: the anchor opens the
    // optimized full-size image (href), the img shows the optimized thumbnail.
    expect(media).toContain('optimizeImageUrl');
    expect(media).toContain('optimizeParams?: string');
    expect(media).toContain('thumbParams?: string');
    expect(media).toContain('href={optimizeImageUrl(image.url, optimizeParams, siteUrl)}');
    expect(media).toContain('src={optimizeImageUrl(image.url, thumbParams, siteUrl)}');
    expect(media).toContain('warm-note__image-link');
    expect((media.match(/optimizeImageUrl\(image\.url, optimizeParams/g) || [])).toHaveLength(2);
    expect((media.match(/optimizeImageUrl\(image\.url, thumbParams/g) || [])).toHaveLength(2);
    // The overlay grid layout must stay self-contained in the theme stylesheet.
    const css = readFileSync(join(themeRoot, 'style.css'), 'utf8');
    expect(css).toContain('.warm-note__image {');
    expect(css).toContain('.warm-note__image-link {\n  display: block;\n}');
    expect(css).toContain('.warm-note__image--rest {');
    expect(css).toContain('.warm-note__images.is-expanded .warm-note__image--rest');
    expect(css).toContain('.warm-note__images-more {');
    // ViewImage source is vendored inside the theme like InstantClick.
    const viewImage = readFileSync(join(themeRoot, 'components/viewimage.ts'), 'utf8');
    expect(viewImage).toContain('ViewImage.js 2.0.2');
    expect(viewImage).toContain('export const viewImageSource');
    // The vendored source embeds `\n` escape sequences inside its injected
    // <style> string; inside the template literal they must be written as
    // `\\n` so the emitted script keeps literal backslash-n. Assert the
    // exported constant still parses as valid JavaScript (guards against
    // the same template-literal newline trap that broke the Engine modal).
    const sourceMatch = viewImage.match(/export const viewImageSource = `([\s\S]*)`;/);
    expect(sourceMatch).toBeTruthy();
    const templateBody = sourceMatch![1];
    // Parse the template literal with esbuild instead of eval/Function: the
    // same syntax guard without a dynamic code execution surface.
    expect(() => transformSync('`' + templateBody + '`', { loader: 'js' })).not.toThrow();
    expect(templateBody).toContain('window.ViewImage=new function');
    // Unescape one level (\\n → \n) like template evaluation would, then
    // assert the emitted script keeps literal backslash-n sequences.
    const evaluated = templateBody.replace(/\\\\n/g, '\\n');
    expect((evaluated.match(/\\n/g) || []).length).toBeGreaterThan(0);
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

  it('merges image optimization params with thumbnail fallback', () => {
    type WarmOptions = Parameters<typeof warmSettings>[0];
    const empty = warmSettings({} as unknown as WarmOptions);
    expect(empty.imageOptimizeParams).toBe('');
    expect(empty.thumbOptimizeParams).toBe('');

    const saved = JSON.stringify({
      imageOptimizeParams: '?quality=80',
      thumbOptimizeParams: '?quality=80&width=500',
    });
    const settings = warmSettings({ [`theme:${WARM_THEME_ID}`]: saved } as unknown as WarmOptions);
    expect(settings.imageOptimizeParams).toBe('quality=80');
    expect(settings.thumbOptimizeParams).toBe('quality=80&width=500');

    // Empty thumbnail params fall back to the image params.
    const thumbOnlyImage = warmSettings({ [`theme:${WARM_THEME_ID}`]: JSON.stringify({ imageOptimizeParams: '?quality=80' }) } as unknown as WarmOptions);
    expect(thumbOnlyImage.imageOptimizeParams).toBe('quality=80');
    expect(thumbOnlyImage.thumbOptimizeParams).toBe('quality=80');

    // Malicious input is filtered before it can reach a src attribute.
    const injected = warmSettings({ [`theme:${WARM_THEME_ID}`]: JSON.stringify({ imageOptimizeParams: '?quality=80" onerror="alert(1)' }) } as unknown as WarmOptions);
    expect(injected.imageOptimizeParams).toBe('quality=80onerror=alert1');
  });

  it('builds an article TOC from h2/h3 headings and injects unique ids', () => {
    const html = [
      '<p>intro</p>',
      '<h2>主题介绍</h2>',
      '<p>a</p>',
      '<h3>细节 <em>说明</em></h3>',
      '<h2 id="custom">主题特点</h2>',
      '<h2>主题介绍</h2>',
    ].join('');

    const { html: nextHtml, items } = prepareArticleToc(html);
    expect(items).toEqual([
      { id: '主题介绍', text: '主题介绍', level: 2 },
      { id: '细节-说明', text: '细节 说明', level: 3 },
      { id: 'custom', text: '主题特点', level: 2 },
      { id: '主题介绍-2', text: '主题介绍', level: 2 },
    ]);
    expect(nextHtml).toContain('<h2 id="主题介绍">主题介绍</h2>');
    expect(nextHtml).toContain('<h3 id="细节-说明">细节 <em>说明</em></h3>');
    expect(nextHtml).toContain('<h2 id="custom">主题特点</h2>');
    expect(nextHtml).toContain('<h2 id="主题介绍-2">主题介绍</h2>');
  });

  it('hides the article TOC when fewer than two headings exist', () => {
    const single = prepareArticleToc('<h2>Only one</h2><p>body</p>');
    expect(single.items).toEqual([]);
    expect(single.html).toContain('id="only-one"');

    const empty = prepareArticleToc('<p>no headings</p>');
    expect(empty.items).toEqual([]);
    expect(empty.html).toBe('<p>no headings</p>');
  });

  it('constrains top-level article media to the reading breakout width', () => {
    const css = readFileSync(join(themeRoot, 'style.css'), 'utf8');
    const selector = '.warm-article:not(.is-note) .warm-prose img,\n.warm-article:not(.is-note) .warm-prose table {';
    const ruleStart = css.indexOf(selector);
    const rule = css.slice(ruleStart, css.indexOf('}', ruleStart) + 1);

    expect(rule).toContain('position: relative;');
    expect(rule).toContain('left: 50%;');
    expect(rule).toContain('max-width: min(var(--warm-breakout-width), calc(100vw - 32px));');
    expect(rule).toContain('transform: translateX(-50%);');
  });

  it('wires Post.astro to the sticky TOC component', () => {
    const post = readFileSync(join(themeRoot, 'components/Post.astro'), 'utf8');
    const toc = readFileSync(join(themeRoot, 'components/WarmToc.astro'), 'utf8');
    const css = readFileSync(join(themeRoot, 'style.css'), 'utf8');

    expect(post).toContain('prepareArticleToc');
    expect(post).toContain('WarmToc');
    expect(post).toContain('warm-article__body--toc');
    expect(toc).toContain('data-warm-toc');
    expect(toc).toContain('aria-label="文章目录"');
    expect(toc).not.toContain('warm-toc__item--h');
    // InstantClick re-executes body scripts unless data-no-instant is set.
    expect(toc).toMatch(/<script is:inline>\s*\n\s*\(\(\) => \{/);
    expect(toc).not.toMatch(/<script[^>]*data-no-instant/);
    expect(css).toContain('position: sticky');
    expect(css).toContain('margin-right: -204px');
    expect(css).toContain('.warm-article__body--toc');
    expect(css).toContain('.warm-toc:hover .warm-toc__label');
    expect(css).toContain('max-width: 0');
    expect(css).not.toContain('.warm-toc__item--h3');
  });
});
