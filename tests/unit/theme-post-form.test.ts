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
});
