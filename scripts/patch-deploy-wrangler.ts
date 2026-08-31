#!/usr/bin/env tsx
/**
 * Merge observability settings from wrangler.toml into dist/server/wrangler.json.
 *
 * @astrojs/cloudflare emits persist=false in the bundled deploy config even when
 * the source wrangler.toml enables log persistence — without this patch, [metrics]
 * console.log lines never land in Workers Observability storage.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unstable_readConfig } from 'wrangler';

export interface DeployWranglerJson {
  observability?: Record<string, unknown>;
  [key: string]: unknown;
}

export function patchDeployWranglerJson(
  deployConfig: DeployWranglerJson,
  sourceObservability: Record<string, unknown> | undefined,
): DeployWranglerJson {
  if (!sourceObservability) {
    return deployConfig;
  }
  return {
    ...deployConfig,
    observability: sourceObservability,
  };
}

export function patchDeployWranglerFile(cwd: string): string {
  const deployPath = resolve(cwd, 'dist/server/wrangler.json');
  if (!existsSync(deployPath)) {
    throw new Error(`Deploy config not found: ${deployPath} (run astro build first)`);
  }

  const sourcePath = resolveWranglerSource(cwd);
  const sourceConfig = unstable_readConfig({ config: sourcePath }, { hideWarnings: true });
  const deployConfig = JSON.parse(readFileSync(deployPath, 'utf-8')) as DeployWranglerJson;
  const patched = patchDeployWranglerJson(deployConfig, sourceConfig.observability as Record<string, unknown>);

  if (!patched.observability?.logs || (patched.observability.logs as { persist?: boolean }).persist !== true) {
    throw new Error(
      'Source wrangler config must set [observability.logs] persist = true for [metrics] telemetry',
    );
  }

  writeFileSync(deployPath, `${JSON.stringify(patched, null, 2)}\n`);
  return deployPath;
}

function resolveWranglerSource(cwd: string): string {
  for (const file of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) {
    const path = resolve(cwd, file);
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error('No wrangler.toml / wrangler.json found in project root');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = patchDeployWranglerFile(process.cwd());
  console.log(`Patched observability in ${path}`);
}
