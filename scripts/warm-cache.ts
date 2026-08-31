#!/usr/bin/env bun
/**
 * Warm public HTML cache by fetching URLs with the publish-time marker.
 *
 * Usage:
 *   bun run perf:warm -- --site https://example.com
 *   bun run perf:warm -- --site https://example.com --sitemap
 *   bun run perf:warm -- --site https://example.com --urls /,/feed,/archives/1/
 *   bun run perf:warm -- --file urls.txt
 *
 * Options:
 *   --site URL        Site origin (required unless every --file URL is absolute)
 *   --sitemap         Also fetch /sitemap.xml and warm listed loc entries
 *   --urls CSV        Comma-separated paths or absolute URLs
 *   --file PATH       Newline-separated paths or absolute URLs
 *   --concurrency N   Parallel warm-up fetches (default: 3)
 *   --delay-ms N      Pause between batches (default: 200)
 *   --dry-run         Print URLs without fetching
 */

import { readFileSync } from 'node:fs';

const CACHE_WARMUP_HEADER = 'X-Typecho-Cache-Warmup';

interface CliOptions {
  site?: string;
  sitemap: boolean;
  urls: string[];
  file?: string;
  concurrency: number;
  delayMs: number;
  dryRun: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    sitemap: false,
    urls: [],
    concurrency: 3,
    delayMs: 200,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const next = (): string => {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${args[i - 1]}`);
      return value;
    };
    switch (args[i]) {
      case '--site': opts.site = next(); break;
      case '--sitemap': opts.sitemap = true; break;
      case '--urls':
        opts.urls.push(...next().split(',').map(value => value.trim()).filter(Boolean));
        break;
      case '--file': opts.file = next(); break;
      case '--concurrency': opts.concurrency = Math.max(1, Number(next())); break;
      case '--delay-ms': opts.delayMs = Math.max(0, Number(next())); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help':
        console.log('Usage: bun run scripts/warm-cache.ts --site https://example.com [--sitemap] [--urls /,/feed]');
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  return opts;
}

function normalizeSiteUrl(site: string): string {
  return site.trim().replace(/\/+$/, '');
}

function resolveUrl(site: string | undefined, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!site) return null;
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${normalizeSiteUrl(site)}${path}`;
}

function parseUrlList(values: string[], site?: string): string[] {
  const urls = new Set<string>();
  for (const value of values) {
    const resolved = resolveUrl(site, value);
    if (resolved) urls.add(resolved);
  }
  return [...urls];
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'typecho-workers-cache-warmup/1.0' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function parseSitemapLocs(xml: string, site: string): string[] {
  const locs: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const loc = match[1].trim();
    if (loc.startsWith(site)) locs.push(loc);
  }
  return locs;
}

async function warmUrl(url: string): Promise<{ url: string; ok: boolean; status?: number; error?: string }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache',
        [CACHE_WARMUP_HEADER]: '1',
        'User-Agent': 'typecho-workers-cache-warmup/1.0',
      },
    });
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Body may already be consumed.
      }
    }
    return { url, ok: response.ok, status: response.status };
  } catch (error) {
    return {
      url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function warmInBatches(
  urls: string[],
  concurrency: number,
  delayMs: number,
): Promise<Array<{ url: string; ok: boolean; status?: number; error?: string }>> {
  const results: Array<{ url: string; ok: boolean; status?: number; error?: string }> = [];
  for (let index = 0; index < urls.length; index += concurrency) {
    const batch = urls.slice(index, index + concurrency);
    const batchResults = await Promise.all(batch.map(url => warmUrl(url)));
    results.push(...batchResults);
    if (delayMs > 0 && index + concurrency < urls.length) {
      await sleep(delayMs);
    }
  }
  return results;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (!opts.site && !opts.file && opts.urls.length === 0) {
    throw new Error('Provide --site with --sitemap/--urls, or --file with absolute URLs');
  }

  const site = opts.site ? normalizeSiteUrl(opts.site) : undefined;
  const seedUrls = [
    ...parseUrlList(['/', '/feed'], site),
    ...parseUrlList(opts.urls, site),
  ];

  if (opts.file) {
    const lines = readFileSync(opts.file, 'utf8').split('\n');
    seedUrls.push(...parseUrlList(lines, site));
  }

  if (opts.sitemap) {
    if (!site) throw new Error('--sitemap requires --site');
    const xml = await fetchText(`${site}/sitemap.xml`);
    seedUrls.push(...parseSitemapLocs(xml, site));
  }

  const urls = [...new Set(seedUrls)];
  if (urls.length === 0) throw new Error('No URLs to warm');

  console.error(`Warming ${urls.length} URL(s)…`);
  if (opts.dryRun) {
    for (const url of urls) console.log(url);
    return;
  }

  const results = await warmInBatches(urls, opts.concurrency, opts.delayMs);
  const failed = results.filter(result => !result.ok);
  for (const result of results) {
    if (result.ok) {
      console.log(`ok  ${result.status}  ${result.url}`);
    } else {
      console.log(`ERR ${result.error || result.status}  ${result.url}`);
    }
  }
  console.error(`Done: ${results.length - failed.length} ok, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
