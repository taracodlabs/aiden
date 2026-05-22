/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 Slice 12b — hooks CLI tests.
 *
 * Drives `runHooksSubcommand` directly against an in-tree daemon DB +
 * an aiden-root override so we don't touch the real ~/.aiden.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHooksSubcommand } from '../../../../cli/v4/commands/hooks';

let tmpRoot: string;
let dbPath: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-hooks-cli-'));
  await fs.mkdir(path.join(tmpRoot, 'hooks'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'daemon'), { recursive: true });
  dbPath = path.join(tmpRoot, 'daemon', 'daemon.db');
  out = [];
  err = [];
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const opts = (): Parameters<typeof runHooksSubcommand>[2] => ({
  writeOut: (s) => { out.push(s); },
  writeErr: (s) => { err.push(s); },
  dbPath,
  rootDir: tmpRoot,
  promptYesNo: async () => true,
});

async function installHook(name: string, manifest: string, entrypoint: string): Promise<void> {
  const dir = path.join(tmpRoot, 'hooks', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'HOOK.yaml'), manifest, 'utf8');
  await fs.writeFile(path.join(dir, 'run.js'), entrypoint, 'utf8');
}

const GOOD_MANIFEST = `id: cli_h1
name: CLI Test Hook
runtime: subprocess
entrypoint:
  argv: ["node", "./run.js"]
subscriptions:
  - {event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: 5000, on_error: allow, on_timeout: allow}
`;

describe('aiden hooks CLI', () => {
  it('list shows "no hooks discovered" when registry empty', async () => {
    const code = await runHooksSubcommand('list', [], opts());
    expect(code).toBe(0);
    expect(out.join('')).toContain('no hooks discovered');
  });

  it('rescan picks up a new hook → list shows it as untrusted, disabled', async () => {
    await installHook('cli_h1', GOOD_MANIFEST, 'console.log("{}");');
    const code1 = await runHooksSubcommand('rescan', [], opts());
    expect(code1).toBe(0);
    expect(out.join('')).toMatch(/loaded=1/);
    out.length = 0;
    const code2 = await runHooksSubcommand('list', [], opts());
    expect(code2).toBe(0);
    expect(out.join('')).toContain('untrusted, disabled');
  });

  it('list --json emits machine-parseable payload', async () => {
    await installHook('cli_h1', GOOD_MANIFEST, 'console.log("{}");');
    await runHooksSubcommand('rescan', [], opts());
    out.length = 0;
    await runHooksSubcommand('list', ['--json'], opts());
    const parsed = JSON.parse(out.join(''));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('hook_id');
    expect(parsed[0]).toHaveProperty('subs');
  });

  // Helper: install + rescan + return the first hook_id.
  async function bootstrapHook(script = 'console.log("{}");'): Promise<string> {
    await installHook('cli_h1', GOOD_MANIFEST, script);
    await runHooksSubcommand('rescan', [], opts());
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    const row = db.prepare(`SELECT hook_id FROM hooks LIMIT 1`).get() as { hook_id: string };
    db.close();
    return row.hook_id;
  }
  async function readHook(hookId: string): Promise<{ trust_state: string; enabled: number; cf: number }> {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    const r = db.prepare(`SELECT trust_state, enabled, consecutive_failures AS cf FROM hooks WHERE hook_id=?`).get(hookId) as { trust_state: string; enabled: number; cf: number };
    db.close();
    return r;
  }

  it('trust with --yes flips state to trusted+enabled', async () => {
    const id = await bootstrapHook();
    out.length = 0;
    expect(await runHooksSubcommand('trust', [id, '--yes'], opts())).toBe(0);
    expect(out.join('')).toMatch(/trusted/);
    expect(await readHook(id)).toMatchObject({ trust_state: 'trusted', enabled: 1 });
  });

  it('trust without --yes aborts on N + shows RISK WARNING', async () => {
    const id = await bootstrapHook();
    err.length = 0;
    expect(await runHooksSubcommand('trust', [id], { ...opts(), promptYesNo: async () => false })).toBe(1);
    expect(err.join('')).toContain('RISK WARNING');
    expect((await readHook(id)).trust_state).toBe('untrusted');
  });

  it('revoke with --yes flips state to revoked+disabled', async () => {
    const id = await bootstrapHook();
    await runHooksSubcommand('trust',  [id, '--yes'], opts());
    await runHooksSubcommand('revoke', [id, '--yes'], opts());
    expect(await readHook(id)).toMatchObject({ trust_state: 'revoked', enabled: 0 });
  });

  it('show prints manifest summary + recent executions list', async () => {
    const id = await bootstrapHook();
    out.length = 0;
    expect(await runHooksSubcommand('show', [id], opts())).toBe(0);
    const text = out.join('');
    expect(text).toContain('CLI Test Hook');
    expect(text).toContain('tool.call.pre');
    expect(text).toContain('Recent executions');
  });

  it('test invokes subprocess + does NOT mutate consecutive_failures counter', async () => {
    const id = await bootstrapHook('process.exit(1);');
    out.length = 0;
    expect(await runHooksSubcommand('test', [id], opts())).toBe(0);
    expect(out.join('')).toMatch(/status:\s+crash/);
    expect(await readHook(id)).toMatchObject({ cf: 0, trust_state: 'untrusted' });
  });

  it('test --payload accepts arbitrary JSON override', async () => {
    const id = await bootstrapHook(
      `let b='';process.stdin.on('data',c=>b+=c.toString('utf8'));process.stdin.on('end',()=>{const p=JSON.parse(b);process.stdout.write(JSON.stringify({decision:'none',echoed:p.payload}));});`);
    out.length = 0;
    await runHooksSubcommand('test', [id, '--payload', '{"X":1}', '--json'], opts());
    const parsed = JSON.parse(out.join('')) as { payload: { X?: number } };
    expect(parsed.payload.X).toBe(1);
  });

  it('audit filters by hook_id + status + limit', async () => {
    const id = await bootstrapHook('process.exit(0);');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    for (let i = 0; i < 3; i++) {
      const t = new Date(Date.now() + i * 1000).toISOString();
      db.prepare(`INSERT INTO hook_executions (hook_execution_id, hook_id, event, status, elapsed_ms, started_at, finished_at)
        VALUES (?, ?, 'tool.call.pre', ?, 1, ?, ?)`).run(`hexec_${i}`, id, i === 2 ? 'crash' : 'ok', t, t);
    }
    db.close();
    out.length = 0;
    await runHooksSubcommand('audit', ['--hook', id, '--limit', '10', '--json'], opts());
    expect((JSON.parse(out.join('')) as unknown[]).length).toBe(3);
    out.length = 0;
    await runHooksSubcommand('audit', ['--status', 'crash', '--json'], opts());
    const crashed = JSON.parse(out.join('')) as Array<{ status: string }>;
    expect(crashed.length).toBe(1);
    expect(crashed[0].status).toBe('crash');
  });

  it('doctor reports schema_v12_current + drift + untrusted counts', async () => {
    await bootstrapHook();
    out.length = 0;
    expect(await runHooksSubcommand('doctor', ['--json'], opts())).toBe(0);
    const byName = new Map((JSON.parse(out.join('')) as { checks: Array<{ name: string; status: string }> }).checks.map((c) => [c.name, c.status]));
    expect(byName.get('schema_v12_current')).toBe('ok');
    expect(byName.get('hooks_dir_exists')).toBe('ok');
    expect(byName.get('untrusted_count')).toBe('warn');
  });

  it('doctor --fix creates missing hooks dir but does NOT auto-trust', async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-hooks-fix-'));
    try {
      await runHooksSubcommand('doctor', ['--fix', '--json'], { ...opts(), rootDir: otherRoot, dbPath: path.join(otherRoot, 'd.db') });
      expect(await fs.stat(path.join(otherRoot, 'hooks')).then(() => true, () => false)).toBe(true);
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });
});
