import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface BuildCommitOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
}

function normalizeCommit(value: string | undefined): string | null {
  const commit = value?.trim();
  return commit && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commit)
    ? commit.toLowerCase()
    : null;
}

/** Resolve once at build time; never import this Node-only module into a Worker. */
export function resolveBuildCommit({
  env = process.env,
  cwd = fileURLToPath(new URL('..', import.meta.url)),
}: BuildCommitOptions = {}): string | null {
  for (const name of [
    'TYPECHO_BUILD_COMMIT',
    'WORKERS_CI_COMMIT_SHA',
    'CF_PAGES_COMMIT_SHA',
    'GITHUB_SHA',
  ]) {
    const commit = normalizeCommit(env[name]);
    if (commit) return commit;
  }

  try {
    return normalizeCommit(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }));
  } catch {
    // Source archives and some CI images do not contain Git metadata.
    return null;
  }
}
