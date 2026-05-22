/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 Slice 12b — lifecycle helper tests.
 *
 * The fire* helpers fire-and-forget against the dispatcher. They are
 * observe-only and fail-open (errors swallowed). We verify both the
 * happy path (audit row written) and the no-db pass-through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  fireSessionStart, fireSessionEnd, fireApprovalRequested, fireApprovalResponded,
} from '../../../core/v4/hooks/lifecycle';
import { newHookId, newHookSubId } from '../../../core/v4/identity';

let db: Database.Database;
let tmpDir: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-life-'));
});
afterEach(async () => {
  try { db.close(); } catch { /* noop */ }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function installFor(event: string): Promise<string> {
  const dir = path.join(tmpDir, `h-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'run.js'),
    `let b='';process.stdin.on('data',c=>b+=c.toString('utf8'));process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({decision:'none'}));});`,
    'utf8');
  await fs.writeFile(path.join(dir, 'HOOK.yaml'),
    `id: life_${Math.random().toString(36).slice(2,8)}\nname: L\nruntime: subprocess\nentrypoint:\n  argv: ["node","./run.js"]\nsubscriptions:\n  - {event: ${event}, authority: observe, mode: best_effort_observer, timeout_ms: 5000, on_error: allow, on_timeout: allow}\n`,
    'utf8');
  const hookId = newHookId();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO hooks (hook_id, name, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
    VALUES (?, 'L', 'global', 'subprocess', ?, 'h', 1, 'trusted', ?, ?)`).run(hookId, path.join(dir, 'HOOK.yaml'), now, now);
  db.prepare(`INSERT INTO hook_subscriptions (subscription_id, hook_id, event, authority, mode, priority, timeout_ms, on_error, on_timeout, enabled)
    VALUES (?, ?, ?, 'observe', 'best_effort_observer', 0, 5000, 'allow', 'allow', 1)`).run(newHookSubId(), hookId, event);
  return hookId;
}

describe('lifecycle fire helpers — Slice 12b', () => {
  it('fireSessionStart writes an audit row', async () => {
    const hookId = await installFor('session.start');
    await fireSessionStart(db, { session_id: 's1', source: 'cli', started_at: new Date().toISOString() });
    const rows = db.prepare(`SELECT event, status FROM hook_executions WHERE hook_id=?`).all(hookId) as Array<{ event: string; status: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe('session.start');
    expect(rows[0].status).toBe('ok');
  });

  it('fireSessionEnd writes an audit row', async () => {
    const hookId = await installFor('session.end');
    await fireSessionEnd(db, { session_id: 's1', ended_at: new Date().toISOString(), turn_count: 5, duration_ms: 1000 });
    const rows = db.prepare(`SELECT event FROM hook_executions WHERE hook_id=?`).all(hookId) as Array<{ event: string }>;
    expect(rows.length).toBe(1);
  });

  it('fireApprovalRequested + fireApprovalResponded both fire', async () => {
    const hookReq  = await installFor('approval.requested');
    const hookResp = await installFor('approval.responded');
    await fireApprovalRequested(db, { tool_name: 'shell_exec', tool_args_redacted: { command: '<redacted>' }, reason: 'mutating' });
    await fireApprovalResponded(db, { tool_name: 'shell_exec', decision: 'allow', responded_at: new Date().toISOString() });
    const reqRows  = db.prepare(`SELECT event FROM hook_executions WHERE hook_id=?`).all(hookReq) as Array<{ event: string }>;
    const respRows = db.prepare(`SELECT event FROM hook_executions WHERE hook_id=?`).all(hookResp) as Array<{ event: string }>;
    expect(reqRows[0]?.event).toBe('approval.requested');
    expect(respRows[0]?.event).toBe('approval.responded');
  });

  it('helpers no-op when db is null (no daemon)', async () => {
    await fireSessionStart(null, { session_id: 's1', source: 'cli', started_at: 't' });
    // Just verifying no throw.
    expect(true).toBe(true);
  });

  it('helpers fail-open even when a hook crashes', async () => {
    const dir = path.join(tmpDir, 'crash-hook');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'run.js'), 'process.exit(99);', 'utf8');
    await fs.writeFile(path.join(dir, 'HOOK.yaml'),
      `id: crash_h\nname: C\nruntime: subprocess\nentrypoint:\n  argv: ["node","./run.js"]\nsubscriptions:\n  - {event: session.start, authority: observe, mode: best_effort_observer, timeout_ms: 5000, on_error: allow, on_timeout: allow}\n`,
      'utf8');
    const hookId = newHookId();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO hooks (hook_id, name, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
      VALUES (?, 'C', 'global', 'subprocess', ?, 'h', 1, 'trusted', ?, ?)`).run(hookId, path.join(dir, 'HOOK.yaml'), now, now);
    db.prepare(`INSERT INTO hook_subscriptions (subscription_id, hook_id, event, authority, mode, priority, timeout_ms, on_error, on_timeout, enabled)
      VALUES (?, ?, 'session.start', 'observe', 'best_effort_observer', 0, 5000, 'allow', 'allow', 1)`).run(newHookSubId(), hookId);
    await expect(fireSessionStart(db, { session_id: 's1', source: 'cli', started_at: 't' })).resolves.toBeUndefined();
  });
});
