#!/usr/bin/env bun
/**
 * Capture a performance baseline document under docs/.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=... bun run scripts/capture-baseline.ts
 *   CLOUDFLARE_ACCOUNT_ID=... bun run scripts/capture-baseline.ts --days 3
 *
 * Writes docs/performance-baseline-YYYY-MM-DD.md
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseDateRange } from './performance/lib/cloudflare-api.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(): { days?: number; from?: string; to?: string } {
  const args = process.argv.slice(2);
  const opts: { days?: number; from?: string; to?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const next = (): string => {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${args[i - 1]}`);
      return value;
    };
    switch (args[i]) {
      case '--days': opts.days = Number(next()); break;
      case '--from': opts.from = next(); break;
      case '--to': opts.to = next(); break;
      case '--help':
        console.log('Usage: bun run scripts/capture-baseline.ts [--days N | --from DATE --to DATE]');
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  return opts;
}

function tryRunScript(script: string, rangeArgs: string[]): { ok: true; output: string } | { ok: false; error: string } {
  const result = spawnSync('bun', ['run', script, '--', ...rangeArgs], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
    };
  }
  return { ok: true, output: result.stdout.trim() };
}

function main(): void {
  const opts = parseArgs();
  const range = parseDateRange(opts);
  const rangeArgs = opts.from || opts.to
    ? ['--from', range.from, '--to', range.to]
    : ['--days', String(opts.days ?? 3)];

  const capturedAt = new Date().toISOString().slice(0, 10);
  const metricsResult = tryRunScript('scripts/analyze-metrics.ts', rangeArgs);
  const usageResult = tryRunScript('scripts/analyze-usage.ts', rangeArgs);

  const metricsSection = metricsResult.ok
    ? metricsResult.output
    : `(skipped — ${metricsResult.error}\n\nSet CLOUDFLARE_API_TOKEN with Workers Observability Read for telemetry queries.)`;

  const usageSection = usageResult.ok
    ? usageResult.output
    : `(skipped — ${usageResult.error}\n\nGraphQL needs \`wrangler login\` or an API token with Account Analytics Read for this account. Observability-only tokens are not sufficient.)`;

  const body = `# Performance baseline (${capturedAt})

- **Window**: ${range.from} .. ${range.to} (UTC)
- **Captured**: ${new Date().toISOString()}
- **Auth**: GraphQL → Wrangler OAuth or Analytics token; telemetry → Observability API token

## [metrics] samples by cache bucket

\`\`\`text
${metricsSection}
\`\`\`

## GraphQL usage summary

\`\`\`text
${usageSection}
\`\`\`
`;

  const docsDir = join(projectRoot, 'docs');
  mkdirSync(docsDir, { recursive: true });
  const outputPath = join(docsDir, `performance-baseline-${capturedAt}.md`);
  writeFileSync(outputPath, body, 'utf8');
  console.error(`Wrote ${outputPath}`);
  if (!usageResult.ok) {
    console.error('Baseline incomplete: GraphQL usage query failed.');
    process.exit(1);
  }
  if (!metricsResult.ok) {
    console.error('Note: [metrics] telemetry query failed; GraphQL baseline was still captured.');
    process.exit(0);
  }
}

main();
