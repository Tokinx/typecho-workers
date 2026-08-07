#!/usr/bin/env tsx
/**
 * Typecho Password Reset Tool
 *
 * Reset a user's password in the D1 database (local or remote).
 *
 * Usage:
 *   # Reset password for local D1 (wrangler dev)
 *   bun run reset-password --user admin --password newpass123
 *
 *   # Reset password for remote D1 (Cloudflare)
 *   bun run reset-password:cloudflare --user admin --password newpass123
 *
 *   # Using npx directly
 *   npx tsx scripts/reset-password.ts --user admin --password newpass123 --target local
 *   npx tsx scripts/reset-password.ts --user admin --password newpass123 --target cloudflare
 *
 *   # List all users
 *   npx tsx scripts/reset-password.ts --list --target local
 *
 *   # Auto-generate a random password
 *   npx tsx scripts/reset-password.ts --user admin --target local
 */

import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ─── CLI Arguments ───────────────────────────────────────────────────────────

interface ResetOptions {
  user: string;
  password: string;
  target: 'local' | 'cloudflare';
  d1Name: string;
  list: boolean;
}

function parseArgs(): ResetOptions {
  const args = process.argv.slice(2);
  const opts: ResetOptions = {
    user: '',
    password: '',
    target: 'local',
    d1Name: 'DB',
    list: false,
  };

  for (let i = 0; i < args.length; i++) {
    const nextValue = (option: string): string => {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${option} 需要一个参数`);
      return value;
    };
    switch (args[i]) {
      case '--user':
      case '-u':
        opts.user = nextValue(args[i]);
        break;
      case '--password':
      case '-p':
        opts.password = nextValue(args[i]);
        break;
      case '--target':
      case '-t':
        opts.target = nextValue(args[i]) as 'local' | 'cloudflare';
        break;
      case '--d1-name':
        opts.d1Name = nextValue(args[i]);
        break;
      case '--list':
      case '-l':
        opts.list = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`未知参数: ${args[i]}`);
    }
  }

  return opts;
}

const USERNAME_RE = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const D1_NAME_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

export function validateResetOptions(opts: ResetOptions): void {
  if (opts.target !== 'local' && opts.target !== 'cloudflare') {
    throw new Error('target 必须是 local 或 cloudflare');
  }
  if (!USERNAME_RE.test(opts.user)) {
    throw new Error('用户名不能为空，且不能包含控制字符');
  }
  if (!D1_NAME_RE.test(opts.d1Name)) {
    throw new Error('D1 数据库名只能包含字母、数字、点、下划线、冒号和连字符，且必须以字母开头');
  }
}

function printHelp(): void {
  console.log(`
Typecho-Workers Password Reset Tool
===============================

Usage:
  npx tsx scripts/reset-password.ts [options]

Options:
  --user, -u <name>       Username to reset password for (required unless --list)
  --password, -p <pass>   New password (auto-generated if omitted)
  --target, -t <target>   Target: "local" (default) or "cloudflare"
  --d1-name <name>        D1 database name or binding (default: DB)
  --list, -l              List all users
  --help, -h              Show this help

Environment:
  PBKDF2_ITERATIONS       Hash cost (50000-600000; default: 600000)
  PASSWORD_PEPPER         Optional Pepper; must match the Worker secret

Examples:
  # Reset admin password (local)
  bun run reset-password --user admin --password newpass123

  # Reset admin password (remote/Cloudflare)
  bun run reset-password:cloudflare --user admin --password newpass123

  # Auto-generate password (local)
  bun run reset-password --user admin

  # List all users (local)
  bun run reset-password --list

  # List all users (remote)
  bun run reset-password:cloudflare --list
`);
}

// ─── Password Hashing (matches src/lib/auth.ts) ─────────────────────────────

const PBKDF2_DEFAULT_ITERATIONS = 600_000;
const PBKDF2_MIN_ITERATIONS = 50_000;

function passwordHashIterations(): number {
  const configured = Number(process.env.PBKDF2_ITERATIONS || PBKDF2_DEFAULT_ITERATIONS);
  if (!Number.isInteger(configured)) return PBKDF2_DEFAULT_ITERATIONS;
  return Math.min(PBKDF2_DEFAULT_ITERATIONS, Math.max(PBKDF2_MIN_ITERATIONS, configured));
}

function generateSalt(length: number): string {
  const array = randomBytes(length);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hashPassword(password: string): string {
  const iterations = passwordHashIterations();
  const salt = generateSalt(16);
  const pepper = process.env.PASSWORD_PEPPER || '';
  const passwordMaterial = pepper
    ? createHmac('sha256', pepper).update(password).digest()
    : password;
  const hash = pbkdf2Hash(passwordMaterial, salt, iterations);
  if (pepper) return `$PBKDF2P$${iterations}$${salt}$${hash}`;
  return `$PBKDF2$${iterations}$${salt}$${hash}`;
}

function pbkdf2Hash(password: string | Buffer, salt: string, iterations: number): string {
  const derived = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return derived.toString('hex');
}

function generateRandomPassword(length = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

// ─── D1 Execution ────────────────────────────────────────────────────────────

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function d1Execute(sql: string, d1Name: string, remote: boolean): string {
  if (!sql || /\u0000/.test(sql)) throw new Error('SQL 不能为空且不能包含 NUL 字符');
  if (!D1_NAME_RE.test(d1Name)) throw new Error('D1 数据库名无效');
  const remoteFlag = remote ? '--remote' : '--local';
  const tempDir = mkdtempSync(path.join(tmpdir(), 'typecho-reset-'));
  const sqlPath = path.join(tempDir, 'query.sql');
  writeFileSync(sqlPath, sql, { encoding: 'utf8', mode: 0o600 });

  try {
    const output = execFileSync('npx', [
      'wrangler', 'd1', 'execute', d1Name, remoteFlag, '--file', sqlPath,
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
    });
    return output;
  } catch (err: any) {
    const stderr = err.stderr || err.message || '';
    const stdout = err.stdout || '';
    if (stderr.includes('no such table') || stdout.includes('no such table')) {
      console.error('❌ 数据库表不存在，请先运行安装向导或数据库迁移');
      process.exit(1);
    }
    console.error('❌ wrangler 执行失败:');
    if (err.stderr) console.error(err.stderr);
    if (err.stdout) console.error(err.stdout);
    process.exit(1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ─── List Users ──────────────────────────────────────────────────────────────

function listUsers(d1Name: string, remote: boolean): void {
  const targetLabel = remote ? 'Cloudflare (远程)' : '本地';
  console.log(`\n📋 用户列表 [${targetLabel}]\n`);

  const sql = 'SELECT uid, name, mail, screenName, [group], logged FROM typecho_users ORDER BY uid';
  const output = d1Execute(sql, d1Name, remote);

  // Parse wrangler D1 JSON output
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.log(output);
    return;
  }

  try {
    const results = JSON.parse(jsonMatch[0]);
    // wrangler wraps in [{ results: [...] }]
    const rows = Array.isArray(results[0]?.results) ? results[0].results : results;
    if (rows.length === 0) {
      console.log('  (无用户)');
      return;
    }

    console.log('  UID | 用户名          | 昵称            | 邮箱                    | 角色');
    console.log('  ' + '-'.repeat(80));
    for (const row of rows) {
      const uid = String(row.uid).padStart(3);
      const name = (row.name || '').padEnd(15);
      const screen = (row.screenName || '').padEnd(15);
      const mail = (row.mail || '').padEnd(23);
      const group = row.group || 'visitor';
      console.log(`  ${uid} | ${name} | ${screen} | ${mail} | ${group}`);
    }
    console.log(`\n  共 ${rows.length} 个用户\n`);
  } catch {
    console.log(output);
  }
}

// ─── Reset Password ──────────────────────────────────────────────────────────

function resetPassword(user: string, password: string, d1Name: string, remote: boolean): void {
  const targetLabel = remote ? 'Cloudflare (远程)' : '本地';

  // 1. Check user exists
  console.log(`\n🔍 查找用户 "${user}" [${targetLabel}]...`);

  const escapedUser = escapeSqlLiteral(user);
  const checkSql = `SELECT uid, name, screenName, [group] FROM typecho_users WHERE name = '${escapedUser}'`;
  const checkOutput = d1Execute(checkSql, d1Name, remote);

  const jsonMatch = checkOutput.match(/\[[\s\S]*\]/);
  let rows: any[] = [];
  if (jsonMatch) {
    try {
      const results = JSON.parse(jsonMatch[0]);
      rows = Array.isArray(results[0]?.results) ? results[0].results : results;
    } catch { /* ignore */ }
  }

  if (rows.length === 0) {
    console.error(`❌ 用户 "${user}" 不存在`);
    console.log('\n💡 使用 --list 参数查看所有用户');
    process.exit(1);
  }

  const userInfo = rows[0];
  console.log(`  ✅ 找到用户: uid=${userInfo.uid}, 昵称="${userInfo.screenName || userInfo.name}", 角色=${userInfo.group}`);

  // 2. Hash new password
  const hashedPassword = hashPassword(password);

  // 3. Update password
  console.log(`🔐 重置密码...`);
  const updateSql = `UPDATE typecho_users SET password = '${hashedPassword}' WHERE name = '${escapedUser}'`;
  d1Execute(updateSql, d1Name, remote);

  console.log(`\n✅ 密码重置成功！`);
  console.log(`  用户名: ${user}`);
  console.log(`  新密码: ${password}`);
  console.log(`  目标:   ${targetLabel}`);
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  let opts: ResetOptions;
  try {
    opts = parseArgs();
    validateResetOptions(opts);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : '参数无效'}`);
    process.exit(2);
  }
  const remote = opts.target === 'cloudflare';

  if (opts.list) {
    listUsers(opts.d1Name, remote);
    return;
  }

  if (!opts.user) {
    console.error('❌ 请指定用户名 (--user <name>)');
    console.log('💡 使用 --help 查看帮助，--list 查看所有用户');
    process.exit(1);
  }

  // Auto-generate password if not provided
  if (!opts.password) {
    opts.password = generateRandomPassword();
    console.log(`🎲 自动生成密码: ${opts.password}`);
  }

  resetPassword(opts.user, opts.password, opts.d1Name, remote);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main();
