/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 Slice 12b — auto-disable policy tests.
 *
 *   - on_error: 'disable_hook' triggers immediate revoke after one failure
 *   - 3 consecutive failures triggers revoke regardless of policy
 *   - status: 'ok' resets counter
 *   - testMode (ctx.testMode=true) skips ALL counter mutation
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { dispatchHook, setAutoDisableLogger } from '../../../core/v4/hooks/dispatcher';
import { newHookId, newHookSubId } from '../../../core/v4/identity';

let db: Database.Database;
let tmpDir: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-hook-autod-'));
});
afterEach(async () => {
  setAutoDisableLogger(null);
  try { db.close(); } catch { /* noop */ }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function install(opts: {
  body:       string;
  onError?:   'allow' | 'block' | 'disable_hook';
  onTimeout?: 'allow' | 'block' | 'disable_hook';
  timeoutMs?: number;
}): Promise<{ hookId: string; subId: string }> {
  const dir = path.join(tmpDir, `h-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'run.js'), opts.body, 'utf8');
  await fs.writeFile(path.join(dir, 'HOOK.yaml'),
    `id: ad_${Math.random().toString(36).slice(2,8)}\nname: AD\nruntime: subprocess\nentrypoint:\n  argv: ["node","./run.js"]\nsubscriptions:\n  - {event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: ${opts.timeoutMs ?? 5000}, on_error: ${opts.onError ?? 'allow'}, on_timeout: ${opts.onTimeout ?? 'allow'}}\n`,
    'utf8');
  const hookId = newHookId();
  const subId  = newHookSubId();
  const now    = new Date().toISOString();
  db.prepare(`INSERT INTO hooks
    (hook_id, name, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
    VALUES (?, 'AD', 'global', 'subprocess', ?, 'h', 1, 'trusted', ?, ?)`)
    .run(hookId, path.join(dir, 'HOOK.yaml'), now, now);
  db.prepare(`INSERT INTO hook_subscriptions
    (subscription_id, hook_id, event, authority, mode, priority, timeout_ms, on_error, on_timeout, enabled)
    VALUES (?, ?, 'tool.call.pre', 'observe', 'best_effort_observer', 0, ?, ?, ?, 1)`)
    .run(subId, hookId, opts.timeoutMs ?? 5000, opts.onError ?? 'allow', opts.onTimeout ?? 'allow');
  return { hookId, subId };
}

function trustState(hookId: string): { trust_state: string; enabled: number; cf: number } {
  const row = db.prepare(`SELECT trust_state, enabled, consecutive_failures AS cf FROM hooks WHERE hook_id=?`).get(hookId) as { trust_state: string; enabled: number; cf: number };
  return row;
}

describe('auto-disable policy — Slice 12b', () => {
  it('on_error: disable_hook triggers immediate revoke after one crash', async () => {
    const log: Array<{ reason: string }> = [];
    setAutoDisableLogger((e) => log.push({ reason: e.reason }));
    const { hookId } = await install({ body: 'process.exit(7);', onError: 'disable_hook' });
    await dispatchHook(db, 'tool.call.pre', {}, {});
    const t = trustState(hookId);
    expect(t.trust_state).toBe('revoked');
    expect(t.enabled).toBe(0);
    expect(log[0].reason).toBe('auto_disable:crash');
  });

  it('on_timeout: disable_hook triggers immediate revoke on timeout', async () => {
    const { hookId } = await install({
      body: 'setTimeout(()=>{},60000);',
      timeoutMs: 200, onTimeout: 'disable_hook',
    });
    await dispatchHook(db, 'tool.call.pre', {}, {});
    expect(trustState(hookId).trust_state).toBe('revoked');
  });

  it('3 consecutive crashes auto-revoke regardless of on_error: allow', async () => {
    const log: string[] = [];
    setAutoDisableLogger((e) => log.push(e.reason));
    const { hookId } = await install({ body: 'process.exit(1);', onError: 'allow' });
    await dispatchHook(db, 'tool.call.pre', {}, {});
    expect(trustState(hookId).trust_state).toBe('trusted');
    expect(trustState(hookId).cf).toBe(1);
    await dispatchHook(db, 'tool.call.pre', {}, {});
    expect(trustState(hookId).cf).toBe(2);
    expect(trustState(hookId).trust_state).toBe('trusted');
    await dispatchHook(db, 'tool.call.pre', {}, {});
    // 3rd failure → counter hits threshold → auto-revoke fires.
    expect(trustState(hookId).trust_state).toBe('revoked');
    expect(log.some((r) => r.startsWith('auto_disable:three_strikes'))).toBe(true);
  });

  it('status: ok resets the consecutive_failures counter', async () => {
    const { hookId } = await install({ body: 'process.exit(1);', onError: 'allow' });
    await dispatchHook(db, 'tool.call.pre', {}, {});
    await dispatchHook(db, 'tool.call.pre', {}, {});
    expect(trustState(hookId).cf).toBe(2);
    // Swap entrypoint to a success path.
    const manifestRow = db.prepare(`SELECT manifest_path FROM hooks WHERE hook_id=?`).get(hookId) as { manifest_path: string };
    await fs.writeFile(
      path.join(path.dirname(manifestRow.manifest_path), 'run.js'),
      'process.stdout.write("{}");',
      'utf8',
    );
    await dispatchHook(db, 'tool.call.pre', {}, {});
    expect(trustState(hookId).cf).toBe(0);
    expect(trustState(hookId).trust_state).toBe('trusted');
  });

  it('testMode: ctx.testMode=true skips ALL counter mutation', async () => {
    const { hookId } = await install({ body: 'process.exit(7);', onError: 'disable_hook' });
    await dispatchHook(db, 'tool.call.pre', {}, { testMode: true });
    const t = trustState(hookId);
    expect(t.cf).toBe(0);
    expect(t.trust_state).toBe('trusted');
    expect(t.enabled).toBe(1);
  });
});
