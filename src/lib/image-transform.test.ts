import { describe, expect, it } from 'vitest';
import {
  OPTIMIZE_PARAMS_MAX_LENGTH,
  normalizeOptimizeParams,
  optimizeContentImages,
  optimizeImageUrl,
} from './image-transform';

const SITE = 'https://www.example.com';

describe('normalizeOptimizeParams', () => {
  it('strips a leading ?', () => {
    expect(normalizeOptimizeParams('?quality=80&format=auto')).toBe('quality=80&format=auto');
  });

  it('strips a leading &', () => {
    expect(normalizeOptimizeParams('&quality=80&width=500')).toBe('quality=80&width=500');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeOptimizeParams('  quality=80  ')).toBe('quality=80');
  });

  it('returns empty string for blank / non-string input', () => {
    expect(normalizeOptimizeParams('')).toBe('');
    expect(normalizeOptimizeParams('   ')).toBe('');
    expect(normalizeOptimizeParams(null)).toBe('');
    expect(normalizeOptimizeParams(undefined)).toBe('');
    expect(normalizeOptimizeParams(80)).toBe('');
  });

  it('filters out characters outside the safe whitelist', () => {
    expect(normalizeOptimizeParams('quality=80" onerror="alert(1)')).toBe('quality=80onerror=alert1');
    expect(normalizeOptimizeParams('format=<script>auto</script>')).toBe('format=scriptautoscript');
  });

  it('caps the length', () => {
    expect(normalizeOptimizeParams(`quality=${'8'.repeat(200)}`)).toHaveLength(OPTIMIZE_PARAMS_MAX_LENGTH);
  });
});

describe('optimizeImageUrl', () => {
  it('returns the URL unchanged when params are empty', () => {
    expect(optimizeImageUrl('/usr/uploads/2024/03/a.jpg', '', SITE)).toBe('/usr/uploads/2024/03/a.jpg');
    expect(optimizeImageUrl('/usr/uploads/2024/03/a.jpg', '   ', SITE)).toBe('/usr/uploads/2024/03/a.jpg');
  });

  it('appends params to a relative upload URL', () => {
    expect(optimizeImageUrl('/usr/uploads/2024/03/a.jpg', 'quality=80&format=auto', SITE))
      .toBe('/usr/uploads/2024/03/a.jpg?quality=80&format=auto');
  });

  it('appends params to an absolute same-origin upload URL', () => {
    expect(optimizeImageUrl(`${SITE}/usr/uploads/2024/03/a.jpg`, 'quality=80&width=500&format=auto', SITE))
      .toBe(`${SITE}/usr/uploads/2024/03/a.jpg?quality=80&width=500&format=auto`);
  });

  it('joins with & when the URL already has a query', () => {
    expect(optimizeImageUrl('/usr/uploads/2024/03/a.jpg?v=1', 'quality=80', SITE))
      .toBe('/usr/uploads/2024/03/a.jpg?v=1&quality=80');
  });

  it('normalizes the params before appending', () => {
    expect(optimizeImageUrl('/usr/uploads/2024/03/a.jpg', '?quality=80', SITE))
      .toBe('/usr/uploads/2024/03/a.jpg?quality=80');
  });

  it('leaves external URLs untouched', () => {
    expect(optimizeImageUrl('https://cdn.elsewhere.net/a.jpg', 'quality=80', SITE))
      .toBe('https://cdn.elsewhere.net/a.jpg');
  });

  it('leaves absolute upload URLs untouched when no site URL is known', () => {
    expect(optimizeImageUrl('https://www.example.com/usr/uploads/a.jpg', 'quality=80', ''))
      .toBe('https://www.example.com/usr/uploads/a.jpg');
  });

  it('still optimizes relative upload URLs without a site URL', () => {
    expect(optimizeImageUrl('/usr/uploads/a.jpg', 'quality=80', ''))
      .toBe('/usr/uploads/a.jpg?quality=80');
  });

  it('skips gif and svg uploads', () => {
    expect(optimizeImageUrl('/usr/uploads/2024/03/anim.gif', 'quality=80', SITE))
      .toBe('/usr/uploads/2024/03/anim.gif');
    expect(optimizeImageUrl('/usr/uploads/logo.SVG', 'quality=80', SITE))
      .toBe('/usr/uploads/logo.SVG');
  });

  it('skips data: URLs', () => {
    expect(optimizeImageUrl('data:image/png;base64,AAAA', 'quality=80', SITE))
      .toBe('data:image/png;base64,AAAA');
  });

  it('skips protocol-relative URLs', () => {
    expect(optimizeImageUrl('//www.example.com/usr/uploads/a.jpg', 'quality=80', SITE))
      .toBe('//www.example.com/usr/uploads/a.jpg');
  });

  it('skips URLs outside /usr/uploads/', () => {
    expect(optimizeImageUrl('/usr/themes/warm/style.css', 'quality=80', SITE))
      .toBe('/usr/themes/warm/style.css');
    expect(optimizeImageUrl(`${SITE}/favicon.ico`, 'quality=80', SITE))
      .toBe(`${SITE}/favicon.ico`);
  });
});

describe('optimizeContentImages', () => {
  const html = `<p><img src="/usr/uploads/2024/03/a.jpg" alt="a"></p>`;

  it('rewrites img src with double quotes', () => {
    expect(optimizeContentImages(html, 'quality=80&format=auto', SITE))
      .toBe('<p><img src="/usr/uploads/2024/03/a.jpg?quality=80&format=auto" alt="a"></p>');
  });

  it('rewrites img src with single quotes', () => {
    expect(optimizeContentImages(`<img src='/usr/uploads/a.jpg'>`, 'quality=80', SITE))
      .toBe(`<img src='/usr/uploads/a.jpg?quality=80'>`);
  });

  it('rewrites every img and leaves external ones alone', () => {
    const multi = `<img src="/usr/uploads/a.jpg"><img src="https://cdn.elsewhere.net/b.jpg">`;
    expect(optimizeContentImages(multi, 'quality=80', SITE))
      .toBe(`<img src="/usr/uploads/a.jpg?quality=80"><img src="https://cdn.elsewhere.net/b.jpg">`);
  });

  it('returns html unchanged when params are empty', () => {
    expect(optimizeContentImages(html, '', SITE)).toBe(html);
  });

  it('does not touch non-img src attributes', () => {
    const iframe = `<iframe src="/usr/uploads/2024/03/video.mp4"></iframe><img src="/usr/uploads/a.jpg">`;
    expect(optimizeContentImages(iframe, 'quality=80', SITE))
      .toBe(`<iframe src="/usr/uploads/2024/03/video.mp4"></iframe><img src="/usr/uploads/a.jpg?quality=80">`);
  });

  it('does not confuse src= text inside attributes with img src', () => {
    const tricky = `<img alt="src=/usr/uploads/x.jpg" src="/usr/uploads/a.jpg">`;
    expect(optimizeContentImages(tricky, 'quality=80', SITE))
      .toBe(`<img alt="src=/usr/uploads/x.jpg" src="/usr/uploads/a.jpg?quality=80">`);
  });
});
