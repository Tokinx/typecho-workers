import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { buildExternalSearchUrl, isInternalSearchRequest, searchClientHtml } from './search';

const SITE = 'https://example.com';

describe('external search URLs', () => {
  it.each(['bing', 'google'])('encodes literal query data and uses canonical hostname: %s', provider => {
    const keyword = '中文 😀 & # + ? " <script>';
    const url = new URL(buildExternalSearchUrl(provider, SITE + ':8443/blog/', keyword)!);
    expect(url.origin).toBe(`https://www.${provider}.com`);
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe(keyword + ' site:example.com');
    expect([...url.searchParams]).toHaveLength(1);
    expect(url.hash).toBe('');
  });
  it.each(['default', 'https://evil.test', '__proto__', 'GOOGLE'])('does not accept arbitrary provider %s', provider => {
    expect(buildExternalSearchUrl(provider, SITE, 'test')).toBeNull();
  });
  it.each(['javascript:alert(1)', 'file:///tmp/x', 'https://user:pass@example.com', 'broken'])('rejects unsafe site URL %s', site => {
    expect(buildExternalSearchUrl('bing', site, 'test')).toBeNull();
  });
  it('does not navigate for blank input', () => {
    expect(buildExternalSearchUrl('bing', SITE, ' \n ')).toBeNull();
  });

});

describe('internal search entry points', () => {
  it.each(['/search', '/search/', '/search/中文/page/2/', '/?s=term', '/?s=', '/?%73=x'])('recognizes %s', async path => {
    expect(await isInternalSearchRequest(new Request(SITE + path))).toBe(true);
  });
  it.each(['/', '/searching', '/admin/?s=x', '/post/?s=x'])('does not block unrelated path %s', async path => {
    expect(await isInternalSearchRequest(new Request(SITE + path))).toBe(false);
  });
  it('detects urlencoded POST without consuming its body', async () => {
    const request = new Request(SITE, { method: 'POST', body: new URLSearchParams({ s: '中文' }) });
    expect(await isInternalSearchRequest(request)).toBe(true);
    expect((await request.formData()).get('s')).toBe('中文');
  });
  it('detects multipart search but leaves unrelated POST intact', async () => {
    const body = new FormData(); body.set('s', '');
    expect(await isInternalSearchRequest(new Request(SITE, { method: 'POST', body }))).toBe(true);
    expect(await isInternalSearchRequest(new Request(SITE, { method: 'POST', body: new URLSearchParams({ other: 'value' }) }))).toBe(false);
  });
});


describe('injected browser search (actual serialized script)', () => {
  class Input {
    value = '中文 & +';
    placeholder = '';
    focus = vi.fn();
    setAttribute = vi.fn();
  }
  class Form {
    action = SITE + '/';
    input = new Input();
    elements = { namedItem: (name: string) => name === 's' ? this.input : null };
  }
  function browser(provider: 'bing' | 'google' = 'bing') {
    const html = searchClientHtml(provider, SITE);
    const config = html.match(/<script type="application\/json" data-engine-search data-no-instant>([\s\S]*?)<\/script>/)![1];
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    const form = new Form();
    const marker = { textContent: config };
    let currentMarker: typeof marker | null = marker;
    const document = {
      querySelector: () => currentMarker,
      querySelectorAll: () => [form],
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      __typechoEngineSearch: undefined as EventListener | undefined,
    };
    const navigate = vi.fn();
    const location = Object.assign(new URL('https://preview.example/404'), { assign: navigate });
    const scope = { document, location, window: { location }, URL, HTMLFormElement: Form, HTMLInputElement: Input };
    const run = () => runInNewContext(script, scope);
    const submit = (target = form) => {
      const event = { target, preventDefault: vi.fn() };
      document.__typechoEngineSearch!(event as any);
      return event;
    };
    run();
    return { form, marker, navigate, document, run, submit, removeMarker: () => { currentMarker = null; } };
  }
  it.each(['bing', 'google'] as const)('adapts unmodified Typecho forms and navigates directly to %s', provider => {
    const b = browser(provider);
    const event = b.submit();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(b.navigate).toHaveBeenCalledWith(buildExternalSearchUrl(provider, SITE, b.form.input.value));
    expect(b.form.input.placeholder).toContain(provider === 'bing' ? 'Bing' : 'Google');
  });
  it('does not navigate or submit internally for blank external queries', () => {
    const b = browser(); b.form.input.value = '   ';
    expect(b.submit().preventDefault).toHaveBeenCalled();
    expect(b.navigate).not.toHaveBeenCalled();
    expect(b.form.input.focus).toHaveBeenCalled();
  });
  it.each(['https://evil.test/', SITE + '/api/comment', SITE + '/admin/', SITE + '/searching'])('does not hijack unrelated form action %s', action => {
    const b = browser(); b.form.action = action;
    expect(b.submit().preventDefault).not.toHaveBeenCalled();
    expect(b.navigate).not.toHaveBeenCalled();
  });
  it('uses the new page marker after partial navigation, not stale provider state', () => {
    const b = browser();
    b.marker.textContent = JSON.stringify({ provider: 'google', siteUrl: SITE });
    b.submit();
    expect(b.navigate.mock.calls[0][0]).toContain('https://www.google.com/search');
    b.navigate.mockClear();
    b.removeMarker();
    expect(b.submit().preventDefault).not.toHaveBeenCalled();
    expect(b.navigate).not.toHaveBeenCalled();
  });
  it('handles forms inserted later and replaces the listener if the snippet runs twice', () => {
    const b = browser(); const first = b.document.__typechoEngineSearch;
    b.run();
    expect(b.document.removeEventListener).toHaveBeenCalledWith('submit', first, true);
    expect(b.submit(new Form()).preventDefault).toHaveBeenCalled();
  });
  it('escapes configuration embedded in HTML and emits nothing for default mode', () => {
    const value = SITE + '/</script><script>alert(1)</script>\u2028';
    const html = searchClientHtml('bing', value);
    const config = html.match(/data-engine-search data-no-instant>([\s\S]*?)<\/script>/)![1];
    expect(html).toContain('type="application/json" data-engine-search data-no-instant');
    expect(config).not.toContain('<');
    expect(JSON.parse(config).siteUrl).toBe(value);
    expect(searchClientHtml('default', SITE)).toBe('');
  });
});
