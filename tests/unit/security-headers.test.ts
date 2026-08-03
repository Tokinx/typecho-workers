/**
 * Unit tests for src/lib/security-headers.ts (G3-5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applySecurityHeaders, defaultCspDirectives, addCspSource, serializeCsp } from '@/lib/security-headers';

vi.mock('@/lib/plugin', () => ({
  applyFilterSafely: vi.fn(async (_ctx: any, _hook: string, value: any) => value),
}));

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
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
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
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
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
});
