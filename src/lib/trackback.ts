import { normalizeHttpUrl } from '@/lib/url';

const MAX_TRACKBACK_URLS = 10;
const TRACKBACK_TIMEOUT_MS = 5_000;

export class TrackbackInputError extends Error {}

function isPrivateNetworkTarget(url: URL): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;

  const octets = hostname.split('.').map(Number);
  if (octets.length === 4 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [first, second] = octets;
    return first === 0 || first === 10 || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19));
  }

  return hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:');
}

/** Parse Typecho's one-URL-per-line Trackback editor field. */
export function parseTrackbackUrls(value: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const line of value.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;

    const normalized = normalizeHttpUrl(raw);
    if (!normalized) throw new TrackbackInputError(`引用通告地址无效: ${raw}`);
    const url = new URL(normalized);
    if (url.username || url.password || isPrivateNetworkTarget(url)) {
      throw new TrackbackInputError(`引用通告地址不可访问: ${raw}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }

  if (urls.length > MAX_TRACKBACK_URLS) {
    throw new TrackbackInputError(`引用通告地址最多只能填写 ${MAX_TRACKBACK_URLS} 个`);
  }

  return urls;
}

export interface TrackbackPayload {
  blogName: string;
  permalink: string;
  excerpt: string;
}

/**
 * Send the manual Trackback notifications requested when a post is published.
 * Remote failures deliberately do not block an otherwise successful publish,
 * matching Typecho's best-effort delivery semantics.
 */
export async function sendTrackbacks(
  urls: string[],
  payload: TrackbackPayload,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await Promise.all(urls.map(async (url) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRACKBACK_TIMEOUT_MS);
    try {
      await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({
          blog_name: payload.blogName,
          url: payload.permalink,
          excerpt: payload.excerpt,
        }).toString(),
        signal: controller.signal,
      });
    } catch {
      // Trackback endpoints are third-party services and commonly fail.
    } finally {
      clearTimeout(timeout);
    }
  }));
}
