/**
 * Unit tests for dist/server/wrangler.json observability patch.
 */
import { describe, it, expect } from 'vitest';
import { patchDeployWranglerJson } from '../../scripts/patch-deploy-wrangler';

describe('patchDeployWranglerJson', () => {
  it('replaces observability from source wrangler config', () => {
    const deploy = {
      name: 'typecho-workers',
      observability: {
        enabled: false,
        logs: { enabled: true, persist: false },
      },
    };
    const source = {
      enabled: true,
      head_sampling_rate: 1,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: false,
        persist: true,
      },
    };

    const patched = patchDeployWranglerJson(deploy, source);
    expect(patched.observability).toEqual(source);
    expect(patched.name).toBe('typecho-workers');
  });

  it('leaves deploy config unchanged when source has no observability', () => {
    const deploy = {
      name: 'typecho',
      observability: { enabled: false, logs: { persist: false } },
    };

    expect(patchDeployWranglerJson(deploy, undefined)).toEqual(deploy);
  });
});
