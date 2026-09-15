import { describe, expect, it } from 'vitest';
import { buildCommentTree } from '@/lib/page-data';
import type { CommentRow } from '@/lib/comment-page';
import type { SiteOptions } from '@/lib/options';

function comment(partial: Partial<CommentRow> & Pick<CommentRow, 'coid' | 'created' | 'parent'>): CommentRow {
  return {
    cid: 1,
    author: `user-${partial.coid}`,
    authorId: 0,
    ownerId: 0,
    mail: '',
    url: '',
    ip: '',
    agent: '',
    text: `comment-${partial.coid}`,
    type: 'comment',
    status: 'approved',
    ...partial,
  } as CommentRow;
}

const options = (overrides: Partial<SiteOptions> = {}) => ({
  commentsThreaded: 1,
  commentsOrder: 'ASC',
  commentsMarkdown: 0,
  commentsHTMLTagAllowed: '',
  ...overrides,
} as SiteOptions);

describe('buildCommentTree', () => {
  it('applies commentsOrder only to top-level comments and keeps replies chronological', () => {
    // Flat rows arrive newest-first (as a DESC SQL fetch would), including replies.
    const rows = [
      comment({ coid: 3, created: 30, parent: 0 }),
      comment({ coid: 5, created: 50, parent: 3 }),
      comment({ coid: 4, created: 40, parent: 3 }),
      comment({ coid: 1, created: 10, parent: 0 }),
      comment({ coid: 2, created: 20, parent: 1 }),
    ];

    const tree = buildCommentTree(rows, options({ commentsOrder: 'DESC' }));

    expect(tree.map(node => node.coid)).toEqual([3, 1]);
    expect(tree[0].children.map(node => node.coid)).toEqual([4, 5]);
    expect(tree[1].children.map(node => node.coid)).toEqual([2]);
  });

  it('keeps both roots and replies chronological when commentsOrder is ASC', () => {
    const rows = [
      comment({ coid: 3, created: 30, parent: 0 }),
      comment({ coid: 5, created: 50, parent: 3 }),
      comment({ coid: 4, created: 40, parent: 3 }),
      comment({ coid: 1, created: 10, parent: 0 }),
      comment({ coid: 2, created: 20, parent: 1 }),
    ];

    const tree = buildCommentTree(rows, options({ commentsOrder: 'ASC' }));

    expect(tree.map(node => node.coid)).toEqual([1, 3]);
    expect(tree[0].children.map(node => node.coid)).toEqual([2]);
    expect(tree[1].children.map(node => node.coid)).toEqual([4, 5]);
  });

  it('sorts nested replies chronologically at every depth', () => {
    const rows = [
      comment({ coid: 1, created: 10, parent: 0 }),
      comment({ coid: 3, created: 30, parent: 1 }),
      comment({ coid: 2, created: 20, parent: 1 }),
      comment({ coid: 5, created: 50, parent: 2 }),
      comment({ coid: 4, created: 40, parent: 2 }),
    ];

    const tree = buildCommentTree(rows, options({ commentsOrder: 'DESC' }));

    expect(tree[0].children.map(node => node.coid)).toEqual([2, 3]);
    expect(tree[0].children[0].children.map(node => node.coid)).toEqual([4, 5]);
  });
});
