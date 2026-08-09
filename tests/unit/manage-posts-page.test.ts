import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(join(process.cwd(), 'src/pages/admin/manage-posts.astro'), 'utf8');

describe('admin manage posts page', () => {
  it('passes raw post/author ID lists to sqlInChunks instead of a -1 sentinel', () => {
    // Regression: the empty-list fallback `: [-1]` hit sqlInChunks'
    // positive-integer guard and threw "D1 ID list contains an invalid
    // value", 500ing every empty list — e.g. /admin/manage-posts?status=waiting
    // with no waiting posts, or a brand-new site with no published posts.
    // sqlInChunks returns `1 = 0` for an empty list, so no sentinel is needed.
    expect(pageSource).not.toMatch(/:\s*\[-1\]/);
    expect(pageSource).not.toMatch(/safeAuthorIds|safePostIds/);
    expect(pageSource).toMatch(/sqlInChunks\(schema\.users\.uid, authorIds\)/);
    expect(pageSource).toMatch(/sqlInChunks\(schema\.relationships\.cid, postIds\)/);
  });
});
