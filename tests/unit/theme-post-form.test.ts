/**
 * Regression tests for Warm's client-rendered comment component.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const warmRoot = join(process.cwd(), 'src/themes/typecho-theme-warm');

describe('Warm post comments', () => {
  it('keeps the SSR comment area free of form identity and CSRF data', () => {
    const source = readFileSync(
      join(warmRoot, 'components/Post.astro'),
      'utf-8',
    );
    const comments = readFileSync(join(warmRoot, 'components/WarmComments.astro'), 'utf-8');
    const ssrPlaceholder = comments.slice(0, comments.indexOf('<script is:inline>'));

    expect(source).toContain('<WarmComments');
    expect(source).not.toContain('<form');
    expect(source).not.toContain('commentOptions.securityToken');
    expect(ssrPlaceholder).toContain('data-comments-root');
    expect(ssrPlaceholder).not.toContain('<form');
    expect(ssrPlaceholder).not.toContain('name="_"');
    expect(ssrPlaceholder).not.toContain('__typecho_uid');
  });

  it('keeps moderation status rendering in the dynamic component', () => {
    const source = readFileSync(
      join(warmRoot, 'components/WarmComments.astro'),
      'utf-8',
    );

    expect(source).toContain("comment.status !== 'approved'");
    expect(source).toContain('warm-comment__status');
  });

  it('uses the action hint as the comment status message', () => {
    const source = readFileSync(
      join(warmRoot, 'components/WarmComments.astro'),
      'utf-8',
    );

    expect(source).toContain('class="warm-comment-form__message" data-comment-message');
    expect(source).toContain('data-default-message="${escapeHtml(defaultMessage)}"');
    expect(source).toContain("value || element.dataset.defaultMessage || ''");
    expect(source).not.toContain('<p class="warm-comment-form__message"');
  });

  it('passes comment page context to frontend plugin snippets', () => {
    const post = readFileSync(join(warmRoot, 'components/Post.astro'), 'utf-8');
    const page = readFileSync(join(warmRoot, 'components/Page.astro'), 'utf-8');
    const shell = readFileSync(join(warmRoot, 'components/WarmShell.astro'), 'utf-8');

    expect(post).toContain("pageContext={{ hasComments: post.allowComment, pageType: 'post' }}");
    expect(page).toContain("pageContext={{ hasComments: page.allowComment, pageType: 'page' }}");
    expect(shell).toContain('pageContext={pageContext}');
  });
});
