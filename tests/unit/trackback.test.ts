import { describe, expect, it, vi } from 'vitest';
import { TrackbackInputError, parseTrackbackUrls, sendTrackbacks } from '@/lib/trackback';

describe('Trackback helpers', () => {
  it('normalizes, deduplicates, and ignores blank manual Trackback URLs', () => {
    expect(parseTrackbackUrls(' https://example.com/trackback \n\nhttps://example.com/trackback\nhttp://blog.test/ping'))
      .toEqual(['https://example.com/trackback', 'http://blog.test/ping']);
  });

  it('rejects unsafe or excessive Trackback URL input', () => {
    expect(() => parseTrackbackUrls('javascript:alert(1)')).toThrow(TrackbackInputError);
    expect(() => parseTrackbackUrls('http://127.0.0.1:8787/trackback')).toThrow('不可访问');
    expect(() => parseTrackbackUrls('https://user:secret@example.com/trackback')).toThrow('不可访问');
    expect(() => parseTrackbackUrls(Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`).join('\n')))
      .toThrow('最多只能填写 10 个');
  });

  it('posts Typecho-compatible fields and tolerates remote failures', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response())
      .mockRejectedValueOnce(new Error('unreachable'));

    await sendTrackbacks(
      ['https://one.example/trackback', 'https://two.example/trackback'],
      { blogName: 'My Blog » Post', permalink: 'https://blog.example/posts/post/', excerpt: 'Excerpt' },
      fetchFn as typeof fetch,
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://one.example/trackback',
      expect.objectContaining({
        method: 'POST',
        body: 'blog_name=My+Blog+%C2%BB+Post&url=https%3A%2F%2Fblog.example%2Fposts%2Fpost%2F&excerpt=Excerpt',
      }),
    );
  });
});
