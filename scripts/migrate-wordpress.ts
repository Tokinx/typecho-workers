#!/usr/bin/env tsx

import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  buildWordPressMigrationDataset,
  buildWordPressMigrationStatements,
  buildWordPressOverrideStatements,
  buildWordPressOverrideTargetState,
  parseWordPressExport,
  type ExistingMeta,
  type MediaAsset,
  type WordPressTargetState,
} from './wordpress';

const execFileAsync = promisify(execFile);
export const MEDIA_TRANSFER_RETRY_COUNT = 3;

export interface MediaTransferFailure {
  sourceUrl: string;
  key: string;
  attempts: number;
  error: string;
}

type Delay = (milliseconds: number) => Promise<void>;

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A failed upload must not abort the content migration. Retrying the complete
 * transfer covers both a transient source download failure and an R2 API error.
 */
export async function transferMediaWithRetries(
  asset: MediaAsset,
  transfer: () => Promise<void>,
  wait: Delay = delay,
): Promise<MediaTransferFailure | null> {
  let lastError = '';
  for (let retry = 0; retry <= MEDIA_TRANSFER_RETRY_COUNT; retry++) {
    try {
      await transfer();
      return null;
    } catch (error) {
      lastError = errorMessage(error);
      if (retry === MEDIA_TRANSFER_RETRY_COUNT) break;
      const retryNumber = retry + 1;
      const backoff = 1_000 * 2 ** retry;
      console.warn(`  Media transfer failed; retry ${retryNumber}/${MEDIA_TRANSFER_RETRY_COUNT} in ${backoff / 1_000}s: ${asset.sourceUrl} (${lastError})`);
      await wait(backoff);
    }
  }
  return {
    sourceUrl: asset.sourceUrl,
    key: asset.key,
    attempts: MEDIA_TRANSFER_RETRY_COUNT + 1,
    error: lastError,
  };
}

interface CliOptions {
  source: string;
  target: 'local' | 'cloudflare';
  dryRun: boolean;
  authorId: number;
  siteUrl: string;
  d1Name: string;
  r2Bucket: string;
  downloadMedia: boolean;
  includeAttachments: boolean;
  mediaConcurrency: number;
  maxMediaBytes: number;
  outputSql: string;
  override: boolean;
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function booleanAfter(args: string[], index: number, flag: string): boolean {
  const value = valueAfter(args, index, flag).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${flag} must be true or false`);
}

export function parseWordPressMigrationArgs(args = process.argv.slice(2)): CliOptions {
  const options: CliOptions = {
    source: '',
    target: 'local',
    dryRun: false,
    authorId: 1,
    siteUrl: '',
    d1Name: 'typecho-db',
    r2Bucket: 'typecho-uploads',
    downloadMedia: false,
    includeAttachments: true,
    mediaConcurrency: 4,
    maxMediaBytes: 50 * 1024 * 1024,
    outputSql: '',
    override: false,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    switch (arg) {
      case '--source':
      case '-s':
        options.source = valueAfter(args, index, arg);
        index++;
        break;
      case '--target':
      case '-t': {
        const target = valueAfter(args, index, arg);
        if (target !== 'local' && target !== 'cloudflare') throw new Error('--target must be local or cloudflare');
        options.target = target;
        index++;
        break;
      }
      case '--author-id':
        options.authorId = Number.parseInt(valueAfter(args, index, arg), 10);
        index++;
        break;
      case '--site-url':
        options.siteUrl = valueAfter(args, index, arg).replace(/\/+$/, '');
        index++;
        break;
      case '--d1-name':
        options.d1Name = valueAfter(args, index, arg);
        index++;
        break;
      case '--r2-bucket':
        options.r2Bucket = valueAfter(args, index, arg);
        index++;
        break;
      case '--media-concurrency':
        options.mediaConcurrency = Number.parseInt(valueAfter(args, index, arg), 10);
        index++;
        break;
      case '--max-media-mb':
        options.maxMediaBytes = Number.parseInt(valueAfter(args, index, arg), 10) * 1024 * 1024;
        index++;
        break;
      case '--output-sql':
        options.outputSql = valueAfter(args, index, arg);
        index++;
        break;
      case '--override':
        options.override = booleanAfter(args, index, arg);
        index++;
        break;
      case '--download-media':
        options.downloadMedia = true;
        break;
      case '--skip-attachments':
        options.includeAttachments = false;
        break;
      case '--dry-run':
      case '-n':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.source) throw new Error('--source is required');
  if (!existsSync(options.source)) throw new Error(`WordPress export not found: ${options.source}`);
  if (!Number.isInteger(options.authorId) || options.authorId <= 0) throw new Error('--author-id must be a positive integer');
  if (!Number.isInteger(options.mediaConcurrency) || options.mediaConcurrency < 1 || options.mediaConcurrency > 16) {
    throw new Error('--media-concurrency must be between 1 and 16');
  }
  if (!Number.isFinite(options.maxMediaBytes) || options.maxMediaBytes < 1024 * 1024) {
    throw new Error('--max-media-mb must be at least 1');
  }
  if (options.downloadMedia && !options.siteUrl) throw new Error('--site-url is required with --download-media');
  return options;
}

function printHelp(): void {
  console.log(`
WordPress WXR Migration Tool
============================

Usage:
  pnpm run db:migrate:wordpress -- --source WordPress.2026-07-29.xml [options]

Options:
  --source, -s <file>       WordPress WXR XML file (required)
  --target, -t <target>     local or cloudflare (default: local)
  --author-id <uid>         Existing Typecho-Workers user that owns imported data (default: 1)
  --site-url <url>          New public site URL; required when downloading media
  --download-media          Download referenced wp-content/uploads files to R2 and rewrite URLs
  --skip-attachments        Do not create attachment content records
  --media-concurrency <n>   Concurrent media transfers, 1-16 (default: 4)
  --max-media-mb <n>        Reject an individual media file above this size (default: 50)
  --d1-name <name>          D1 database name (default: typecho-db)
  --r2-bucket <name>        R2 bucket name (default: typecho-uploads)
  --output-sql <file>       Also write the generated SQL to a file
  --override <true|false>   Replace existing content/comments and preserve WXR IDs (default: false)
  --dry-run, -n             Parse and report only; do not inspect or write the target
  --help, -h                Show this help

WordPress system post types, such as menus and revisions, are always skipped. Without
--download-media, attachment records retain their original remote URLs.

Notes are always imported, but this tool does not enable the notes plugin. Enable it
manually after a successful import. With --override true, content records (including
attachments), comments, fields and relationships are cleared. Imported content and
comments retain their WordPress post_id/comment_id values; users, settings, meta
definitions and R2 objects are retained.
`);
}

function extractRows(stdout: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(stdout) as unknown;
  const containers = Array.isArray(parsed) ? parsed : [parsed];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    const result = container as Record<string, unknown>;
    if (Array.isArray(result.results)) return result.results as Array<Record<string, unknown>>;
    if (Array.isArray(result.result)) {
      for (const nested of result.result as Array<Record<string, unknown>>) {
        if (Array.isArray(nested?.results)) return nested.results as Array<Record<string, unknown>>;
      }
    }
  }
  return [];
}

class WranglerTarget {
  private locationFlag: '--local' | '--remote';

  constructor(
    private target: 'local' | 'cloudflare',
    private d1Name: string,
    private r2Bucket: string,
  ) {
    this.locationFlag = target === 'cloudflare' ? '--remote' : '--local';
  }

  private async wrangler(args: string[]): Promise<string> {
    const { stdout, stderr } = await execFileAsync('pnpm', ['exec', 'wrangler', ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (stderr && !stderr.includes('wrangler')) process.stderr.write(stderr);
    return stdout;
  }

  private async query(sql: string): Promise<Array<Record<string, unknown>>> {
    const output = await this.wrangler([
      'd1', 'execute', this.d1Name, this.locationFlag, '--command', sql, '--json',
    ]);
    return extractRows(output);
  }

  async inspect(authorId: number, allowPreviousImport = false): Promise<WordPressTargetState> {
    // Local Wrangler commands use separate workerd processes against one SQLite
    // file. Run these reads serially so Miniflare does not return SQLITE_BUSY.
    const maximaRows = await this.query(`SELECT
      COALESCE((SELECT MAX(cid) FROM typecho_contents), 0) AS maxContentId,
      COALESCE((SELECT MAX(coid) FROM typecho_comments), 0) AS maxCommentId,
      COALESCE((SELECT MAX(mid) FROM typecho_metas), 0) AS maxMetaId`);
    const slugRows = await this.query('SELECT slug FROM typecho_contents WHERE slug IS NOT NULL');
    const metaRows = await this.query('SELECT mid, type, slug FROM typecho_metas WHERE slug IS NOT NULL');
    const authorRows = await this.query(`SELECT uid FROM typecho_users WHERE uid = ${authorId} LIMIT 1`);
    const previousImportRows = await this.query("SELECT COUNT(*) AS value FROM typecho_fields WHERE name = 'wordpress_post_id'");
    if (!authorRows.length) throw new Error(`Target user uid=${authorId} does not exist`);
    if (!allowPreviousImport && Number(previousImportRows[0]?.value || 0) > 0) {
      throw new Error('Target already contains a WordPress import. Restore a pre-import backup before running the same WXR again.');
    }
    const maxima = maximaRows[0] || {};
    return {
      maxContentId: Number(maxima.maxContentId || 0),
      maxCommentId: Number(maxima.maxCommentId || 0),
      maxMetaId: Number(maxima.maxMetaId || 0),
      contentSlugs: slugRows.map(row => String(row.slug || '')).filter(Boolean),
      metas: metaRows.map(row => ({
        mid: Number(row.mid),
        type: String(row.type || ''),
        slug: String(row.slug || ''),
      })).filter((row): row is ExistingMeta => !!row.mid && !!row.type && !!row.slug),
    };
  }

  async executeStatements(statements: string[]): Promise<void> {
    const chunks: string[][] = [];
    let current: string[] = [];
    let bytes = 0;
    for (const statement of statements) {
      const statementBytes = Buffer.byteLength(statement) + 1;
      if (current.length && bytes + statementBytes > 600_000) {
        chunks.push(current);
        current = [];
        bytes = 0;
      }
      current.push(statement);
      bytes += statementBytes;
    }
    if (current.length) chunks.push(current);

    const tempDir = mkdtempSync(join(tmpdir(), 'typecho-wxr-sql-'));
    try {
      for (let index = 0; index < chunks.length; index++) {
        const sqlPath = join(tempDir, `chunk-${String(index + 1).padStart(3, '0')}.sql`);
        writeFileSync(sqlPath, `${chunks[index].join('\n')}\n`, 'utf8');
        console.log(`  Applying SQL chunk ${index + 1}/${chunks.length}...`);
        await this.wrangler(['d1', 'execute', this.d1Name, this.locationFlag, '--file', sqlPath]);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async resetForOverride(): Promise<void> {
    await this.executeStatements(buildWordPressOverrideStatements());
  }

  private async transferMedia(asset: MediaAsset, tempDir: string, index: number, maxBytes: number): Promise<void> {
    const tempPath = join(tempDir, `media-${index}`);
    const response = await fetch(asset.sourceUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${asset.sourceUrl}`);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > maxBytes) throw new Error(`Media exceeds size limit: ${asset.sourceUrl}`);

    try {
      let received = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(received > maxBytes ? new Error(`Media exceeds size limit: ${asset.sourceUrl}`) : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as any), limiter, createWriteStream(tempPath));
      const args = ['r2', 'object', 'put', `${this.r2Bucket}/${asset.key}`, '--file', tempPath, this.locationFlag];
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (contentType) args.push('--content-type', contentType);
      await this.wrangler(args);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  async uploadMedia(assets: MediaAsset[], concurrency: number, maxBytes: number): Promise<MediaTransferFailure[]> {
    if (!assets.length) return [];
    const tempDir = mkdtempSync(join(tmpdir(), 'typecho-wxr-media-'));
    let cursor = 0;
    let completed = 0;
    const failures: MediaTransferFailure[] = [];
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= assets.length) return;
        const failure = await transferMediaWithRetries(
          assets[index],
          () => this.transferMedia(assets[index], tempDir, index, maxBytes),
        );
        if (failure) {
          failures.push(failure);
          continue;
        }
        completed++;
        if (completed % 10 === 0 || completed === assets.length) {
          console.log(`  Uploaded media ${completed}/${assets.length}`);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, assets.length) }, worker));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    return failures;
  }
}

function emptyTargetState(): WordPressTargetState {
  return {
    maxContentId: 0,
    maxCommentId: 0,
    maxMetaId: 0,
    contentSlugs: [],
    metas: [],
  };
}

function printRecord(label: string, values: Record<string, number>): void {
  const entries = Object.entries(values).filter(([, count]) => count > 0);
  console.log(`${label}: ${entries.length ? entries.map(([name, count]) => `${name}=${count}`).join(', ') : 'none'}`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseWordPressMigrationArgs(args);
  console.log(`Reading ${basename(options.source)}...`);
  const source = parseWordPressExport(readFileSync(options.source, 'utf8'));
  console.log(`WordPress site: ${source.siteTitle || '(untitled)'} (${source.siteUrl || 'unknown URL'})`);

  const targetWriter = options.dryRun
    ? null
    : new WranglerTarget(options.target, options.d1Name, options.r2Bucket);
  const inspectedTargetState = targetWriter
    ? await targetWriter.inspect(options.authorId, options.override)
    : emptyTargetState();
  const targetState = options.override
    ? buildWordPressOverrideTargetState(inspectedTargetState)
    : inspectedTargetState;
  const datasetConfig = {
    authorId: options.authorId,
    includeAttachments: options.includeAttachments,
    siteUrl: options.siteUrl,
    rewriteMedia: options.downloadMedia,
    preserveIds: options.override,
  };
  let dataset = buildWordPressMigrationDataset(source, targetState, datasetConfig);
  let statements = buildWordPressMigrationStatements(dataset);

  printRecord('Import plan', dataset.imported);
  printRecord('Skipped WordPress types', dataset.skipped);
  console.log(`Generated SQL statements: ${statements.length}`);
  if (options.override) console.log('Override mode will replace existing content and comments while preserving WordPress IDs.');
  if (!options.downloadMedia && dataset.imported.attachments) {
    console.log('Media download is disabled; attachment records will keep their original WordPress URLs.');
  }

  if (options.dryRun) {
    if (options.outputSql) {
      writeFileSync(options.outputSql, `${statements.join('\n')}\n`, 'utf8');
      console.log(`SQL written to ${options.outputSql}`);
    }
    console.log('Dry run complete. No target resources were read or changed.');
    return;
  }

  let mediaFailures: MediaTransferFailure[] = [];
  if (options.downloadMedia) {
    console.log(`Downloading and uploading ${dataset.mediaAssets.length} media objects...`);
    mediaFailures = await targetWriter!.uploadMedia(dataset.mediaAssets, options.mediaConcurrency, options.maxMediaBytes);
    if (mediaFailures.length) {
      const failedKeys = new Set(mediaFailures.map(failure => failure.key));
      dataset = buildWordPressMigrationDataset(source, targetState, { ...datasetConfig, skipMediaKeys: failedKeys });
      statements = buildWordPressMigrationStatements(dataset);
      console.warn(`Media transfer completed with ${mediaFailures.length} failed object(s). Their original WordPress URLs will be retained:`);
      for (const failure of mediaFailures) {
        console.warn(`  - ${failure.sourceUrl} (${failure.error}; ${failure.attempts} attempts)`);
      }
    }
  }
  if (options.outputSql) {
    writeFileSync(options.outputSql, `${statements.join('\n')}\n`, 'utf8');
    console.log(`SQL written to ${options.outputSql}`);
  }
  if (options.override) {
    console.log('Clearing existing content and comments...');
    await targetWriter!.resetForOverride();
  }
  await targetWriter!.executeStatements(statements);
  if (mediaFailures.length) {
    console.log(`WordPress migration completed with ${mediaFailures.length} skipped media object(s).`);
  } else {
    console.log('WordPress migration completed successfully.');
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  main().catch(error => {
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
