import { describe, expect, it } from 'vitest';
import { maskPluginConfigSecrets, restorePluginConfigSecrets, SECRET_PLACEHOLDER } from '@/lib/plugin-config-secrets';
import type { PluginConfigField } from '@/lib/plugin';

const configDef: Record<string, PluginConfigField> = {
  token: { type: 'password', label: 'Token' },
  hidden: { type: 'hidden', label: 'Hidden' },
  mounts: {
    type: 'repeatable',
    label: 'Mounts',
    itemFields: {
      accessKey: { type: 'text', label: 'Access key' },
      secretKey: { type: 'password', label: 'Secret key' },
    },
  },
};

describe('plugin config secret masking', () => {
  it('masks top-level and repeatable secrets without changing public values', () => {
    const masked = maskPluginConfigSecrets(configDef, {
      token: 'token-secret',
      hidden: 'hidden-secret',
      mounts: [{ accessKey: 'public', secretKey: 'mount-secret' }],
    });

    expect(masked).toEqual({
      token: SECRET_PLACEHOLDER,
      hidden: SECRET_PLACEHOLDER,
      mounts: [{ accessKey: 'public', secretKey: SECRET_PLACEHOLDER }],
    });
    expect(JSON.stringify(masked)).not.toContain('token-secret');
    expect(JSON.stringify(masked)).not.toContain('hidden-secret');
    expect(JSON.stringify(masked)).not.toContain('mount-secret');
  });

  it('restores unchanged placeholders by row index', () => {
    const previous = {
      token: 'old-token',
      mounts: [{ accessKey: 'public', secretKey: 'old-mount-secret' }],
    };
    const restored = restorePluginConfigSecrets(configDef, {
      token: SECRET_PLACEHOLDER,
      mounts: [{ accessKey: 'new-public', secretKey: SECRET_PLACEHOLDER }],
    }, previous);

    expect(restored).toEqual({
      token: 'old-token',
      mounts: [{ accessKey: 'new-public', secretKey: 'old-mount-secret' }],
    });
  });
});
