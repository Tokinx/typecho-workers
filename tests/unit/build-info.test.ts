import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

// scripts/build-info.ts 通过 node:child_process 调用 git；同时 mock 无前缀写法，
// 避免实现改用 'child_process' 时意外执行真实 Git / 污染宿主机环境。
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));
vi.mock('child_process', () => ({ execFileSync: execFileSyncMock }));

import { resolveBuildCommit } from '../../scripts/build-info';

const ENV_KEYS = [
  'TYPECHO_BUILD_COMMIT',
  'WORKERS_CI_COMMIT_SHA',
  'CF_PAGES_COMMIT_SHA',
  'GITHUB_SHA',
] as const;

const HASH_40 = '0123456789abcdef0123456789abcdef01234567';
const HASH_40_UPPER = '0123456789ABCDEF0123456789ABCDEF01234567';
const HASH_64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const HASH_64_UPPER = HASH_64.toUpperCase();

const savedEnv = new Map<string, string | undefined>();

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function withEnv(env: Record<string, string | undefined>): string | null {
  return resolveBuildCommit({ env, cwd: '/tmp/build-info-test-repo' });
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
});

describe('resolveBuildCommit', () => {
  it('prefers TYPECHO_BUILD_COMMIT over all CI sources', () => {
    expect(
      withEnv({
        TYPECHO_BUILD_COMMIT: HASH_40,
        WORKERS_CI_COMMIT_SHA: HASH_64,
        CF_PAGES_COMMIT_SHA: HASH_64,
        GITHUB_SHA: HASH_64,
      }),
    ).toBe(HASH_40);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('falls through the priority list when earlier sources are missing or invalid', () => {
    expect(
      withEnv({
        TYPECHO_BUILD_COMMIT: 'short',
        WORKERS_CI_COMMIT_SHA: HASH_40,
        CF_PAGES_COMMIT_SHA: HASH_64,
        GITHUB_SHA: HASH_64,
      }),
    ).toBe(HASH_40);

    expect(
      withEnv({
        TYPECHO_BUILD_COMMIT: '',
        WORKERS_CI_COMMIT_SHA: '   ',
        CF_PAGES_COMMIT_SHA: HASH_64,
        GITHUB_SHA: HASH_40,
      }),
    ).toBe(HASH_64);

    expect(
      withEnv({
        CF_PAGES_COMMIT_SHA: 'not-a-commit',
        GITHUB_SHA: HASH_40,
      }),
    ).toBe(HASH_40);

    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('trims and lowercases valid 40- and 64-character hashes', () => {
    expect(withEnv({ TYPECHO_BUILD_COMMIT: `  ${HASH_40_UPPER}\n` })).toBe(HASH_40.toLowerCase());
    expect(withEnv({ TYPECHO_BUILD_COMMIT: `\t${HASH_64.toUpperCase()} ` })).toBe(HASH_64);
  });

  it('accepts only complete 40- or 64-character hex values', () => {
    const invalidValues = [
      HASH_40.slice(0, 39),
      `${HASH_40}0`,
      HASH_64.slice(0, 63),
      `${HASH_64}0`,
      'g'.repeat(40),
      '0123456789abcdef0123456789abcdef0123456z',
      '0'.repeat(0),
    ];

    for (const invalid of invalidValues) {
      execFileSyncMock.mockReturnValueOnce(`${HASH_40}\n`);
      expect(withEnv({ TYPECHO_BUILD_COMMIT: invalid })).toBe(HASH_40);
    }

    expect(execFileSyncMock).toHaveBeenCalledTimes(invalidValues.length);
  });

  it('skips HTML / injection payloads instead of echoing them', () => {
    expect(
      withEnv({
        TYPECHO_BUILD_COMMIT: '<script>alert(1)</script>',
        WORKERS_CI_COMMIT_SHA: '<img src=x onerror=alert(1)>',
        CF_PAGES_COMMIT_SHA: HASH_64,
      }),
    ).toBe(HASH_64);

    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not a git repository');
    });
    expect(withEnv({ TYPECHO_BUILD_COMMIT: '<script>alert(1)</script>' })).toBeNull();
  });

  it('falls back to git rev-parse HEAD with a bounded, non-interactive call', () => {
    execFileSyncMock.mockReturnValueOnce(`${HASH_40}\n`);

    expect(withEnv({})).toBe(HASH_40);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({
        cwd: '/tmp/build-info-test-repo',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }),
    );
  });

  it('normalizes and validates the Git fallback output', () => {
    execFileSyncMock.mockReturnValueOnce(`  ${HASH_64_UPPER}\n`);
    expect(withEnv({})).toBe(HASH_64);

    execFileSyncMock.mockReturnValueOnce('deadbeef\n');
    expect(withEnv({})).toBeNull();
  });

  it('returns null when git is unavailable', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      const error = new Error('spawnSync git ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    expect(withEnv({})).toBeNull();
  });

  it('returns null when git fails or times out', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('git failed');
    });
    expect(withEnv({})).toBeNull();

    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawnSync git ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        signal: 'SIGTERM',
      });
    });
    expect(withEnv({})).toBeNull();
  });

  it('reads process.env and defaults cwd to the repository root', () => {
    process.env.TYPECHO_BUILD_COMMIT = HASH_40_UPPER;
    expect(resolveBuildCommit()).toBe(HASH_40.toLowerCase());

    delete process.env.TYPECHO_BUILD_COMMIT;
    execFileSyncMock.mockReturnValueOnce(`${HASH_40}\n`);
    expect(resolveBuildCommit()).toBe(HASH_40);

    const options = execFileSyncMock.mock.calls.at(-1)?.[2] as { cwd?: string } | undefined;
    expect(options?.cwd).toBeDefined();
    expect(resolvePath(options!.cwd!)).toBe(process.cwd());
  });
});

describe('build commit wiring', () => {
  it('injects __TYPECHO_BUILD_COMMIT__ from scripts/build-info via vite.define', () => {
    const config = source('astro.config.mjs');

    expect(config).toMatch(/resolveBuildCommit/);
    expect(config).toMatch(/JSON\.stringify/);

    const viteIndex = config.indexOf('vite:');
    const defineIndex = config.indexOf('define:', viteIndex);
    const constantIndex = config.indexOf('__TYPECHO_BUILD_COMMIT__', defineIndex);
    expect(viteIndex).toBeGreaterThan(-1);
    expect(defineIndex).toBeGreaterThan(viteIndex);
    expect(constantIndex).toBeGreaterThan(defineIndex);
  });

  it('declares the build commit constant as string | null', () => {
    expect(source('src/env.d.ts')).toMatch(
      /declare\s+const\s+__TYPECHO_BUILD_COMMIT__\s*:\s*string\s*\|\s*null/,
    );
  });

  it('renders the short hash and full-hash title only in the admin footer', () => {
    const admin = source('src/layouts/Admin.astro');
    const footerStart = admin.indexOf('typecho-foot');
    expect(footerStart).toBeGreaterThan(-1);
    const footer = admin.slice(footerStart);

    expect(admin).toMatch(/__TYPECHO_BUILD_COMMIT__/);
    expect(admin).toMatch(/slice\(\s*0\s*,\s*7\s*\)/);
    expect(admin).toContain('unknown');
    expect(admin).toContain("buildCommit?.slice(0, 7) ?? 'unknown'");
    expect(admin).toContain("buildCommit ? `Git commit: ${buildCommit}` : '未提供 Git 提交信息'");
    expect(footer).toContain('build-revision');
    expect(footer).toMatch(/title=\{[^}]*\}/);

    for (const layout of ['src/layouts/Base.astro', 'src/layouts/Blog.astro']) {
      expect(source(layout)).not.toContain('__TYPECHO_BUILD_COMMIT__');
    }
  });
});
