import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMENT_WRITE_PATHS = [
  'src/pages/api/comment.ts',
  'src/pages/api/admin/comment-action.ts',
  'src/pages/api/admin/comment-batch.ts',
  'src/pages/api/admin/comment-edit.ts',
  'src/lib/comment-moderation.ts',
];

describe('API-backed comments and page cache', () => {
  it('invalidates public comment and Notes projections from comment write paths', () => {
    for (const path of COMMENT_WRITE_PATHS) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source, path).not.toContain('purgeCommentModerationCache');
      expect(source, path).not.toMatch(/domains:\s*\['all'\]/);
      if (source.includes('invalidatePublicCache')) {
        expect(source, path).toContain('domains: []');
        expect(source, path).toContain("sharedDomains: ['sidebar', 'comments', 'notes']");
      }
    }
  });

  it('invalidates Notes and public comments after note mutations', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/plugins/typecho-plugin-notes/service.ts'),
      'utf8',
    );
    expect(source).toContain("reason: 'note-create'");
    expect(source).toContain("reason: 'note-update'");
    expect(source).toContain("reason: 'note-delete'");
    expect(source).toContain("reason: 'note-comment'");
    expect(source).toContain("sharedDomains: ['sidebar', 'comments', 'notes']");
  });
});
