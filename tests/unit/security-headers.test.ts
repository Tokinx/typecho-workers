/**
 * Unit tests for src/lib/security-headers.ts (G3-5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applySecurityHeaders,
  defaultCspDirectives,
  addCspSource,
  serializeCsp,
  parseCspWhitelist,
  CSP_WHITELIST_DIRECTIVES,
} from '@/lib/security-headers';

vi.mock('@/lib/plugin', () => ({
  applyFilterSafely: vi.fn(async (_ctx: any, _hook: string, value: any) => value),
}));

/** Split one directive's source list out of a serialized CSP. */
function directiveSources(csp: string, name: string): string[] {
  const entry = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
  return entry ? entry.slice(name.length).trim().split(/\s+/) : [];
}

describe('CSP directive helpers', () => {
  it('serializeCsp joins directives with semicolons', () => {
    const out = serializeCsp({ 'default-src': ["'self'"], 'img-src': ["'self'", 'data:'] });
    expect(out).toBe("default-src 'self'; img-src 'self' data:");
  });

  it('addCspSource dedupes', () => {
    const d = defaultCspDirectives();
    const before = d['img-src'].length;
    addCspSource(d, 'img-src', ['data:', 'https://cdn.example']);
    expect(d['img-src']).toContain('https://cdn.example');
    expect(d['img-src'].filter(s => s === 'data:')).toHaveLength(1);
    expect(d['img-src'].length).toBe(before + 1); // only the new one added
  });

  it('default policy includes upstream services and blocks framing', () => {
    const csp = serializeCsp(defaultCspDirectives());
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('https://challenges.cloudflare.com');
    expect(csp).not.toContain('https://static.cloudflareinsights.com');
    expect(csp).not.toContain('https://cloudflareinsights.com');
  });
});

describe('parseCspWhitelist', () => {
  it('normalizes bare hosts to https and preserves explicit schemes and ports', () => {
    expect(parseCspWhitelist('cdn.example.com\nhttps://sub.example.com\nhttp://assets.example.org:8080')).toEqual([
      'https://cdn.example.com',
      'https://sub.example.com',
      'http://assets.example.org:8080',
    ]);
  });

  it('keeps subdomain wildcards and dedupes normalized sources', () => {
    expect(parseCspWhitelist('*.cdn.example.com\nhttps://cdn.example.com\ncdn.example.com')).toEqual([
      'https://*.cdn.example.com',
      'https://cdn.example.com',
    ]);
  });

  it('drops blank lines, comments, and anything that is not a host', () => {
    const raw = [
      '# first comment',
      '', // blank
      '   ', // whitespace-only
      'cdn.example.com',
      "'unsafe-inline'", // directive token
      'data:', // scheme source
      'https://cdn.example.com/path', // paths are not hosts
      'bad host.com', // internal whitespace
      '*', // bare wildcard
      'https://', // no host
    ].join('\n');
    expect(parseCspWhitelist(raw)).toEqual(['https://cdn.example.com']);
  });

  it('returns an empty list for null, undefined, empty, or comment-only input', () => {
    expect(parseCspWhitelist(null)).toEqual([]);
    expect(parseCspWhitelist(undefined)).toEqual([]);
    expect(parseCspWhitelist('')).toEqual([]);
    expect(parseCspWhitelist('# only a comment')).toEqual([]);
  });
});

describe('applySecurityHeaders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds the standard headers on https requests', async () => {
    const response = await applySecurityHeaders(new Response('ok'), {
      request: new Request('https://example.com/'),
    });
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBeNull();
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('omits HSTS for plain http (G8-6 / dev)', async () => {
    const response = await applySecurityHeaders(new Response('ok'), {
      request: new Request('http://localhost:4321/'),
    });
    expect(response.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('uses a strict CSP for upload responses', async () => {
    const response = await applySecurityHeaders(new Response('image'), {
      request: new Request('https://example.com/usr/uploads/x.png'),
      upload: true,
    });
    const csp = response.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBeNull();
  });

  it('preserves existing headers (route handler wins)', async () => {
    const response = await applySecurityHeaders(
      new Response('ok', { headers: { 'X-Frame-Options': 'SAMEORIGIN' } }),
      { request: new Request('https://example.com/') },
    );
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('allows the authenticated admin preview to be framed by its editor only', async () => {
    const response = await applySecurityHeaders(new Response('preview'), {
      request: new Request('https://example.com/admin/preview?cid=1'),
      allowSameOriginFrame: true,
    });
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'");
  });

  it('lets plugins extend the CSP via csp:directives', async () => {
    const { applyFilterSafely } = await import('@/lib/plugin');
    (applyFilterSafely as any).mockImplementationOnce(async (_ctx: any, _hook: string, directives: any) => {
      addCspSource(directives, 'img-src', ['https://my-cdn.example']);
      return directives;
    });
    const response = await applySecurityHeaders(new Response('ok'), {
      request: new Request('https://example.com/'),
    }, { activatedPlugins: new Set<string>() });
    const csp = response.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain('https://my-cdn.example');
  });

  it('merges the csp whitelist into the common fetch directives incrementally', async () => {
    const response = await applySecurityHeaders(new Response('ok'), {
      request: new Request('https://example.com/'),
      cspWhitelist: 'cdn.example.com\nplayer.twitch.tv',
    }, { activatedPlugins: new Set<string>() });
    const csp = response.headers.get('Content-Security-Policy') || '';
    for (const directive of CSP_WHITELIST_DIRECTIVES) {
      const sources = directiveSources(csp, directive);
      expect(sources).toContain('https://cdn.example.com');
      expect(sources).toContain('https://player.twitch.tv');
    }
    // Default sources remain — the whitelist appends, never replaces.
    expect(directiveSources(csp, 'frame-src')).toContain('https://www.youtube.com');
    expect(directiveSources(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directiveSources(csp, 'default-src')).toEqual(["'self'"]);
    expect(directiveSources(csp, 'base-uri')).toEqual(["'self'"]);
  });

  it('ignores the csp whitelist for upload responses', async () => {
    const response = await applySecurityHeaders(new Response('image'), {
      request: new Request('https://example.com/usr/uploads/x.png'),
      upload: true,
      cspWhitelist: 'cdn.example.com',
    });
    const csp = response.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('cdn.example.com');
  });

  it('keeps the admin preview frame allowance despite the whitelist', async () => {
    const response = await applySecurityHeaders(new Response('preview'), {
      request: new Request('https://example.com/admin/preview?cid=1'),
      allowSameOriginFrame: true,
      cspWhitelist: 'cdn.example.com',
    }, { activatedPlugins: new Set<string>() });
    const csp = response.headers.get('Content-Security-Policy') || '';
    expect(directiveSources(csp, 'frame-ancestors')).toEqual(["'self'"]);
    expect(directiveSources(csp, 'script-src')).toContain('https://cdn.example.com');
  });

  it('combines plugin csp:directives contributions with the whitelist', async () => {
    const { applyFilterSafely } = await import('@/lib/plugin');
    (applyFilterSafely as any).mockImplementationOnce(async (_ctx: any, _hook: string, directives: any) => {
      addCspSource(directives, 'img-src', ['https://my-cdn.example']);
      return directives;
    });
    const response = await applySecurityHeaders(new Response('ok'), {
      request: new Request('https://example.com/'),
      cspWhitelist: 'cdn.example.com',
    }, { activatedPlugins: new Set<string>() });
    const csp = response.headers.get('Content-Security-Policy') || '';
    const imgSrc = directiveSources(csp, 'img-src');
    expect(imgSrc).toContain('https://my-cdn.example');
    expect(imgSrc).toContain('https://cdn.example.com');
  });
});
