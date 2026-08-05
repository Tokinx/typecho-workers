/**
 * Integration tests for public upload serving route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBucketGet, mockBucketHead } = vi.hoisted(() => ({
  mockBucketGet: vi.fn(),
  mockBucketHead: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: { get: mockBucketGet, head: mockBucketHead },
  },
}));

import { GET } from '@/pages/usr/uploads/[...path]';

function bodyStream(text: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('GET /usr/uploads/[...path]', () => {
  beforeEach(() => {
    mockBucketGet.mockReset();
    mockBucketHead.mockReset();
    mockBucketHead.mockResolvedValue({ httpEtag: '"current-etag"' });
  });

  it('preserves Content-Disposition metadata for SVG downloads', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('<svg></svg>'),
      httpEtag: '"svg-etag"',
      httpMetadata: {
        contentType: 'image/svg+xml',
        contentDisposition: 'attachment',
      },
    });

    const res = await GET({
      params: { path: '2026/05/icon.svg' },
      locals: {},
      request: new Request('https://example.com/usr/uploads/2026/05/icon.svg'),
    } as any);

    expect(res.status).toBe(200);
    expect(mockBucketGet).toHaveBeenCalledWith('usr/uploads/2026/05/icon.svg');
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
  });

  it('forces Content-Disposition: attachment for SVG even if metadata is missing (G5-6)', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('<svg></svg>'),
      httpEtag: '"svg-etag"',
      httpMetadata: { contentType: 'image/svg+xml' },
    });
    const res = await GET({
      params: { path: 'legacy.svg' },
      locals: {},
      request: new Request('https://example.com/usr/uploads/legacy.svg'),
    } as any);
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
  });

  it('attaches the strict upload CSP without cross-origin isolation headers', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('binary'),
      httpEtag: '"e"',
      httpMetadata: { contentType: 'image/png' },
    });
    const res = await GET({
      params: { path: 'a.png' },
      locals: {},
      request: new Request('https://example.com/usr/uploads/a.png'),
    } as any);
    expect(res.headers.get('Content-Security-Policy') || '').toContain("default-src 'none'");
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBeNull();
  });

  it('serves subsequent requests from edge cache without another R2 body read', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('cached image'),
      httpEtag: '"cached-etag"',
      httpMetadata: { contentType: 'image/png' },
    });
    const request = new Request('https://example.com/usr/uploads/cached.png');
    const routeContext = {
      params: { path: 'cached.png' },
      locals: {},
      request,
    } as any;

    const first = await GET(routeContext);
    expect(await first.text()).toBe('cached image');
    const second = await GET(routeContext);
    expect(await second.text()).toBe('cached image');
    expect(mockBucketGet).toHaveBeenCalledTimes(1);
    expect(mockBucketHead).toHaveBeenCalledTimes(2);
    expect(second.headers.get('Content-Security-Policy') || '').toContain("default-src 'none'");
    expect(second.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
    expect(second.headers.get('Cross-Origin-Resource-Policy')).toBeNull();
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('does not serve a cached upload after the R2 object is deleted', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('private image'),
      httpEtag: '"private-etag"',
      httpMetadata: { contentType: 'image/png' },
    });
    mockBucketHead.mockResolvedValueOnce({ httpEtag: '"private-etag"' });
    const request = new Request('https://example.com/usr/uploads/private.png');
    const routeContext = { params: { path: 'private.png' }, locals: {}, request } as any;

    const first = await GET(routeContext);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('private image');

    mockBucketHead.mockResolvedValueOnce(null);
    const afterDelete = await GET(routeContext);
    expect(afterDelete.status).toBe(404);
    expect(mockBucketGet).toHaveBeenCalledTimes(1);
  });

  it('uses a new cache entry when an R2 object is replaced', async () => {
    const request = new Request('https://example.com/usr/uploads/replaced.png');
    const routeContext = { params: { path: 'replaced.png' }, locals: {}, request } as any;
    mockBucketHead
      .mockResolvedValueOnce({ httpEtag: '"v1"' })
      .mockResolvedValueOnce({ httpEtag: '"v2"' });
    mockBucketGet
      .mockResolvedValueOnce({
        body: bodyStream('version one'),
        httpEtag: '"v1"',
        httpMetadata: { contentType: 'image/png' },
      })
      .mockResolvedValueOnce({
        body: bodyStream('version two'),
        httpEtag: '"v2"',
        httpMetadata: { contentType: 'image/png' },
      });

    expect(await (await GET(routeContext)).text()).toBe('version one');
    expect(await (await GET(routeContext)).text()).toBe('version two');
    expect(mockBucketGet).toHaveBeenCalledTimes(2);
  });

  it('schedules cache persistence through the request ExecutionContext', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('async cache'),
      httpEtag: '"async-etag"',
      httpMetadata: { contentType: 'image/png' },
    });
    const waitUntil = vi.fn();
    const request = new Request('https://example.com/usr/uploads/async.png');

    const response = await GET({
      params: { path: 'async.png' },
      locals: { cfContext: { waitUntil } },
      request,
    } as any);

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
    const versionedUrl = new URL(request.url);
    versionedUrl.searchParams.set('__typecho_upload_etag', '"current-etag"');
    expect(await caches.default.match(new Request(versionedUrl.toString()))).toBeDefined();
  });

  it('still serves the R2 object when edge cache persistence fails', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('uncached image'),
      httpEtag: '"uncached-etag"',
      httpMetadata: { contentType: 'image/png' },
    });
    const putSpy = vi.spyOn(caches.default, 'put').mockRejectedValueOnce(new Error('cache unavailable'));

    const response = await GET({
      params: { path: 'uncached.png' },
      locals: {},
      request: new Request('https://example.com/usr/uploads/uncached.png'),
    } as any);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('uncached image');
    putSpy.mockRestore();
  });
});
