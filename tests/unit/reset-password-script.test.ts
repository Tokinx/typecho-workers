import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, capturedSql } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  capturedSql: { value: '' },
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import { d1Execute, escapeSqlLiteral, validateResetOptions } from '../../scripts/reset-password';

describe('reset-password command safety', () => {
  it('passes PBKDF2 hashes and shell metacharacters through a file unchanged', () => {
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      const fileIndex = args.indexOf('--file');
      capturedSql.value = readFileSync(args[fileIndex + 1]!, 'utf8');
      return '[]';
    });

    const hash = '$PBKDF2$600000$0123456789abcdef0123456789abcdef$' + 'a'.repeat(64);
    const commandSubstitution = '$(touch /tmp/typecho-reset-command-substitution)';
    d1Execute(`UPDATE typecho_users SET password = '${hash}' WHERE name = '${commandSubstitution}'`, 'DB', false);

    expect(capturedSql.value).toContain(hash);
    expect(capturedSql.value).toContain(commandSubstitution);
    const [command, args, options] = execFileSyncMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe('npx');
    expect(args).toEqual(expect.arrayContaining(['wrangler', 'd1', 'execute', 'DB', '--local', '--file']));
    expect(options).not.toHaveProperty('shell');
  });

  it('escapes SQL literals without shell expansion', () => {
    expect(escapeSqlLiteral("$PBKDF2$600000$hash'$(touch /tmp/x)")).toBe(
      "$PBKDF2$600000$hash''$(touch /tmp/x)",
    );
  });

  it('rejects invalid command targets and usernames', () => {
    expect(() => validateResetOptions({ user: 'admin', password: 'x', target: 'local', d1Name: 'DB', list: false })).not.toThrow();
    expect(() => validateResetOptions({ user: '$(touch /tmp/x)', password: 'x', target: 'local', d1Name: 'DB', list: false })).not.toThrow();
    expect(() => validateResetOptions({ user: 'admin\u0000', password: 'x', target: 'local', d1Name: 'DB', list: false })).toThrow();
    expect(() => validateResetOptions({ user: 'admin', password: 'x', target: 'local', d1Name: '--remote', list: false })).toThrow();
  });
});
