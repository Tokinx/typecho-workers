import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureCloudflareWranglerConfig,
  generateWranglerToml,
  GENERATED_CONFIG_MARKER,
  type CloudflareBuildEnv,
} from '../../scripts/generate-wrangler-config';

const env: CloudflareBuildEnv = {
  TYPECHO_CF_WORKER_NAME: 'typecho-cf-preview',
  TYPECHO_CF_D1_DATABASE_ID: 'f6ee8b53-9c4b-4d80-9765-28f9295bc3e3',
  TYPECHO_CF_D1_DATABASE_NAME: 'typecho-cf-db',
  TYPECHO_CF_R2_BUCKET_NAME: 'typecho-cf-uploads',
  TYPECHO_CF_PBKDF2_ITERATIONS: '50000',
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Cloudflare build Wrangler config', () => {
  it('generates all required Worker bindings without secrets', () => {
    const config = generateWranglerToml(env);

    expect(config).toContain(GENERATED_CONFIG_MARKER);
    expect(config).toContain('compatibility_flags = [ "nodejs_compat" ]');
    expect(config).toContain('binding = "DB"');
    expect(config).toContain('binding = "BUCKET"');
    expect(config).toContain('PBKDF2_ITERATIONS = "50000"');
    expect(config).not.toContain('PASSWORD_PEPPER');
    expect(config).not.toContain('INSTALL_TOKEN');
  });

  it('fails before writing a config when a required build variable is absent', () => {
    expect(() => generateWranglerToml({
      ...env,
      TYPECHO_CF_D1_DATABASE_ID: undefined,
    })).toThrow('TYPECHO_CF_D1_DATABASE_ID');
  });

  it('writes an ignored config when the build checkout has none', () => {
    const directory = mkdtempSync(join(tmpdir(), 'typecho-cf-wrangler-'));
    temporaryDirectories.push(directory);

    const result = ensureCloudflareWranglerConfig(directory, env);

    expect(result.created).toBe(true);
    expect(readFileSync(result.path, 'utf-8')).toContain(GENERATED_CONFIG_MARKER);
  });

  it('does not overwrite a local manual Wrangler config', () => {
    const directory = mkdtempSync(join(tmpdir(), 'typecho-cf-wrangler-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'wrangler.toml');
    writeFileSync(configPath, 'name = "local-manual-config"\n');

    const result = ensureCloudflareWranglerConfig(directory, env);

    expect(result.created).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe('name = "local-manual-config"\n');
  });
});
