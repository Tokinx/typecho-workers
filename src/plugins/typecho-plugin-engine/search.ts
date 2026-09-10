/** Engine-owned optional external search. No core or theme-specific configuration. */
export type SearchProvider = 'default' | 'bing' | 'google';

export function normalizeSearchProvider(value: unknown): SearchProvider {
  return value === 'bing' || value === 'google' ? value : 'default';
}

/** Self-contained: also serialized into the frontend snippet below. */
export function buildExternalSearchUrl(provider: unknown, siteUrl: string, keyword: string): string | null {
  if ((provider !== 'bing' && provider !== 'google') || !keyword.trim()) return null;
  try {
    const site = new URL(siteUrl);
    if (!['https:', 'http:'].includes(site.protocol) || site.username || site.password) return null;
    const target = new URL(provider === 'bing' ? 'https://www.bing.com/search' : 'https://www.google.com/search');
    target.searchParams.set('q', `${keyword.trim()} site:${site.hostname}`);
    return target.toString();
  } catch {
    return null;
  }
}

/** Detect existing core search entry points without consuming downstream POST bodies. */
export async function isInternalSearchRequest(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  if (/^\/search(?:\/|$)/.test(url.pathname)) return true;
  if (url.pathname !== '/') return false;
  if (url.searchParams.has('s')) return true;
  if (request.method !== 'POST') return false;
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded' && type !== 'multipart/form-data') return false;
  try {
    return (await request.clone().formData()).has('s');
  } catch {
    return false;
  }
}

export function searchDisabledResponse(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

/**
 * Self-contained browser function; do not reference module state here.
 * The current page's marker, not a closure, controls the mode after InstantClick
 * swaps the body. A page without the plugin marker retains native form behavior.
 */
export function installExternalSearch(buildUrl: typeof buildExternalSearchUrl): void {
  const state = document as Document & { __typechoEngineSearch?: EventListener };
  if (state.__typechoEngineSearch) document.removeEventListener('submit', state.__typechoEngineSearch, true);

  const readConfig = (): { provider: string; siteUrl: string } | null => {
    const marker = document.querySelector('script[data-engine-search]');
    if (!marker?.textContent) return null;
    try { return JSON.parse(marker.textContent); } catch { return null; }
  };
  const searchInput = (form: HTMLFormElement, siteUrl: string): HTMLInputElement | null => {
    const input = form.elements.namedItem('s');
    if (!(input instanceof HTMLInputElement)) return null;
    try {
      const action = new URL(form.action, location.href);
      const site = new URL(siteUrl);
      // Do not hijack another service's forms or admin/comment submissions.
      if (action.origin !== location.origin && action.origin !== site.origin) return null;
      if (action.pathname !== '/' && !/^\/search(?:\/|$)/.test(action.pathname)) return null;
      return input;
    } catch { return null; }
  };

  state.__typechoEngineSearch = event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const config = readConfig();
    if (!config || (config.provider !== 'bing' && config.provider !== 'google')) return;
    const input = searchInput(form, config.siteUrl);
    if (!input) return;
    event.preventDefault();
    const target = buildUrl(config.provider, config.siteUrl, input.value);
    if (target) window.location.assign(target);
    else input.focus();
  };
  document.addEventListener('submit', state.__typechoEngineSearch, true);

  const config = readConfig();
  if (!config || (config.provider !== 'bing' && config.provider !== 'google')) return;
  const label = `使用 ${config.provider === 'bing' ? 'Bing' : 'Google'} 搜索本站`;
  for (const form of document.querySelectorAll('form')) {
    const input = searchInput(form, config.siteUrl);
    if (input) {
      input.placeholder = label;
      input.setAttribute('aria-label', label);
    }
  }
}

/** archive:footer output; only publish the mode and canonical URL, never AI settings. */
export function searchClientHtml(provider: SearchProvider, siteUrl: string): string {
  if (provider === 'default') return '';
  const config = JSON.stringify({ provider, siteUrl })
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const label = provider === 'bing' ? 'Bing' : 'Google';
  const engine = provider === 'bing' ? 'https://www.bing.com/search' : 'https://www.google.com/search';
  // InstantClick recreates executable script tags without preserving attributes.
  // Keep this inert JSON marker untouched when it swaps/replays a page body.
  return `<script type="application/json" data-engine-search data-no-instant>${config}</script>`
    + `<script>(${installExternalSearch.toString()})(${buildExternalSearchUrl.toString()});</script>`
    + `<noscript><p>本站使用 ${label} 搜索。请启用 JavaScript，或前往 <a href="${engine}" rel="nofollow">${label}</a> 输入关键词和 site:本站域名。</p></noscript>`;
}
