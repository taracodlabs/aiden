/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 1 — the side-effect idempotency ledger + guard.
 *
 * Proves the resume-safety contract on a REAL sqlite db (migration v19):
 *   • key determinism (same logical send → same key; volatile args stripped);
 *   • intent → confirm lifecycle, confirmed rows never downgraded;
 *   • the ledger SURVIVES a process restart (reopen the db file → confirmed
 *     rows still there) — the property that makes resume safe;
 *   • guardExternalSend NEVER double-fires: confirmed → skip, attempting →
 *     needs-confirmation (or verify), ambiguous ordinal → needs-confirmation;
 *   • the crash-then-resume simulation for both branches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  SideEffectLedger,
  sideEffectKey,
  argsHashOf,
  guardExternalSend,
  guardContentAddressedSend,
} from '../../../core/v4/sideEffectLedger';

let tmp: string;
let dbFile: string;
let db: Database.Database;

function openLedger(): SideEffectLedger {
  db = new Database(dbFile);
  runMigrations(db);
  return new SideEffectLedger(db);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-sel-'));
  dbFile = path.join(tmp, 'daemon.db');
});

afterEach(async () => {
  try { db?.close(); } catch { /* already closed */ }
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

// ── Key derivation ──────────────────────────────────────────────────────────

describe('sideEffectKey / argsHashOf — determinism', () => {
  it('same parts → same key; any differing part → different key', () => {
    const base = { taskId: 'task_1', step: 0, tool: 'channel_send', argsHash: 'abc' };
    expect(sideEffectKey(base)).toBe(sideEffectKey({ ...base }));
    expect(sideEffectKey(base)).not.toBe(sideEffectKey({ ...base, step: 1 }));
    expect(sideEffectKey(base)).not.toBe(sideEffectKey({ ...base, tool: 'email' }));
    expect(sideEffectKey(base)).not.toBe(sideEffectKey({ ...base, argsHash: 'def' }));
    expect(sideEffectKey(base)).not.toBe(sideEffectKey({ ...base, taskId: 'task_2' }));
  });

  it('argsHashOf ignores object key order and volatile fields', () => {
    const a = argsHashOf({ chatId: 'c1', text: 'hi', platform: 'discord' });
    const b = argsHashOf({ platform: 'discord', text: 'hi', chatId: 'c1' });
    expect(a).toBe(b);
    // Volatile fields (timestamps, ids) must not change the logical hash.
    const withVolatile = argsHashOf({ chatId: 'c1', text: 'hi', platform: 'discord', ts: 123, runId: 'r9', tempGuid: 'x' });
    expect(withVolatile).toBe(a);
    // Real content change DOES change the hash.
    expect(argsHashOf({ chatId: 'c1', text: 'BYE', platform: 'discord' })).not.toBe(a);
  });
});

// ── Ledger lifecycle + restart ──────────────────────────────────────────────

describe('SideEffectLedger — lifecycle + durable across restart', () => {
  const parts = { key: '', taskId: 'task_1', step: 0, tool: 'channel_send', argsHash: 'h1', target: 'discord:c1' };

  it('beginIntent writes attempting; confirm promotes; lookup reflects both', () => {
    const ledger = openLedger();
    const key = sideEffectKey({ taskId: 'task_1', step: 0, tool: 'channel_send', argsHash: 'h1' });
    ledger.beginIntent({ ...parts, key });
    expect(ledger.lookup(key)?.status).toBe('attempting');
    expect(ledger.lookup(key)?.receipt).toBeNull();
    ledger.confirm(key, { ok: true, id: 'msg_42' });
    const row = ledger.lookup(key);
    expect(row?.status).toBe('confirmed');
    expect(row?.receipt).toContain('msg_42');
    expect(row?.confirmedAt).toBeGreaterThan(0);
  });

  it('beginIntent never downgrades an already-confirmed row', () => {
    const ledger = openLedger();
    const key = sideEffectKey({ taskId: 'task_1', step: 0, tool: 'channel_send', argsHash: 'h1' });
    ledger.beginIntent({ ...parts, key });
    ledger.confirm(key, 'receipt');
    ledger.beginIntent({ ...parts, key });                 // duplicate begin
    expect(ledger.lookup(key)?.status).toBe('confirmed');  // still confirmed
  });

  it('RESTART: a confirmed send is still on record after reopening the db file', () => {
    const key = sideEffectKey({ taskId: 'task_1', step: 0, tool: 'channel_send', argsHash: 'h1' });
    const l1 = openLedger();
    l1.beginIntent({ ...parts, key });
    l1.confirm(key, { id: 'persisted' });
    db.close();                                            // "process exits"
    const l2 = openLedger();                               // fresh process, same file
    const row = l2.lookup(key);
    expect(row?.status).toBe('confirmed');
    expect(row?.receipt).toContain('persisted');
    expect(l2.confirmedForTask('task_1').map((e) => e.step)).toEqual([0]);
  });
});

// ── The guard — never double-fires ──────────────────────────────────────────

describe('guardExternalSend — resume rule', () => {
  const keyParts = { taskId: 'task_1', step: 0, tool: 'channel_send', argsHash: 'h1', target: 'discord:c1' };

  it('FRESH: sends exactly once and records confirmed', async () => {
    const ledger = openLedger();
    const send = vi.fn(async () => ({ ok: true, id: 'm1' }));
    const out = await guardExternalSend(ledger, keyParts, { send });
    expect(out.kind).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger.lookup(out.key)?.status).toBe('confirmed');
  });

  it('CONFIRMED prior → SKIP, send NOT called (idempotent replay)', async () => {
    const ledger = openLedger();
    await guardExternalSend(ledger, keyParts, { send: vi.fn(async () => ({ ok: true, id: 'm1' })) });
    const send2 = vi.fn(async () => ({ ok: true, id: 'm2' }));
    const out = await guardExternalSend(ledger, keyParts, { send: send2 });
    expect(out.kind).toBe('skipped');
    expect(send2).not.toHaveBeenCalled();
    expect(out.reason).toMatch(/idempotent_replay/);
  });

  it('ATTEMPTING + no receipt → NEEDS_CONFIRMATION, send NOT called', async () => {
    const ledger = openLedger();
    // Simulate crash: intent written, send threw before confirm.
    const key = sideEffectKey(keyParts);
    ledger.beginIntent({ key, taskId: keyParts.taskId, step: 0, tool: 'channel_send', argsHash: 'h1' });
    const send = vi.fn(async () => ({ ok: true }));
    const out = await guardExternalSend(ledger, keyParts, { send });
    expect(out.kind).toBe('needs_confirmation');
    expect(send).not.toHaveBeenCalled();
  });

  it('ATTEMPTING + receipt + verify=true → SKIP (interrupted send confirmed landed)', async () => {
    const ledger = openLedger();
    const key = sideEffectKey(keyParts);
    ledger.beginIntent({ key, taskId: keyParts.taskId, step: 0, tool: 'channel_send', argsHash: 'h1' });
    ledger.confirm(key, 'left-a-receipt');
    // status is now confirmed → this is the plain confirmed-skip path.
    const send = vi.fn(async () => ({ ok: true }));
    const out = await guardExternalSend(ledger, keyParts, { send, verify: async () => true });
    expect(out.kind).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('AMBIGUOUS ORDINAL: a confirmed send at the same (task,step) with different content → NEEDS_CONFIRMATION', async () => {
    const ledger = openLedger();
    // First run delivered content A at step 0.
    await guardExternalSend(ledger, { ...keyParts, argsHash: 'hA' }, { send: vi.fn(async () => ({ ok: true })) });
    // Re-drive produces DIFFERENT content B at the same step 0.
    const send = vi.fn(async () => ({ ok: true }));
    const out = await guardExternalSend(ledger, { ...keyParts, argsHash: 'hB' }, { send });
    expect(out.kind).toBe('needs_confirmation');
    expect(send).not.toHaveBeenCalled();
    expect(out.reason).toMatch(/prior run/);
  });
});

// ── Crash → resume simulation, end to end over a restart ─────────────────────

describe('crash-then-resume simulation (across a db reopen)', () => {
  const keyParts = { taskId: 'task_send', step: 0, tool: 'channel_send', argsHash: argsHashOf({ text: 'hello' }), target: 'discord:c1' };

  it('completed send before crash → resume SKIPS (no second send)', async () => {
    const l1 = openLedger();
    const send1 = vi.fn(async () => ({ ok: true, id: 'm1' }));
    expect((await guardExternalSend(l1, keyParts, { send: send1 })).kind).toBe('sent');
    expect(send1).toHaveBeenCalledTimes(1);
    db.close();                                            // crash after send + confirm

    const l2 = openLedger();                               // resume in a fresh process
    const send2 = vi.fn(async () => ({ ok: true, id: 'm2' }));
    const out = await guardExternalSend(l2, keyParts, { send: send2 });
    expect(out.kind).toBe('skipped');
    expect(send2).not.toHaveBeenCalled();                 // ← no double-send
  });

  it('crash BETWEEN intent and confirm → resume surfaces NEEDS_CONFIRMATION (no blind re-fire)', async () => {
    const l1 = openLedger();
    const key = sideEffectKey(keyParts);
    l1.beginIntent({ key, taskId: keyParts.taskId, step: 0, tool: 'channel_send', argsHash: keyParts.argsHash });
    // ...process dies here, send may or may not have reached the wire.
    db.close();

    const l2 = openLedger();
    const send = vi.fn(async () => ({ ok: true }));
    const out = await guardExternalSend(l2, keyParts, { send });
    expect(out.kind).toBe('needs_confirmation');
    expect(send).not.toHaveBeenCalled();                  // ← never guesses on an irreversible send
  });
});

// ── Content-addressed guard (webhook/email outbound) ─────────────────────────

describe('guardContentAddressedSend — fire-and-forget outbound POSTs', () => {
  const cp = { scope: 'webhook:https://cb.example/x', tool: 'webhook', contentHash: argsHashOf({ body: 'A' }), target: 'https://cb.example/x' };

  it('identical payload to the same destination is sent at most once (across restart)', async () => {
    const l1 = openLedger();
    const send1 = vi.fn(async () => ({ status: 200 }));
    expect((await guardContentAddressedSend(l1, cp, { send: send1 })).kind).toBe('sent');
    db.close();
    const l2 = openLedger();
    const send2 = vi.fn(async () => ({ status: 200 }));
    const out = await guardContentAddressedSend(l2, cp, { send: send2 });
    expect(out.kind).toBe('skipped');
    expect(send2).not.toHaveBeenCalled();
  });

  it('a DIFFERENT payload to the same destination is a distinct send (no false collision)', async () => {
    const ledger = openLedger();
    await guardContentAddressedSend(ledger, cp, { send: vi.fn(async () => ({ status: 200 })) });
    const send = vi.fn(async () => ({ status: 200 }));
    const out = await guardContentAddressedSend(
      ledger,
      { ...cp, contentHash: argsHashOf({ body: 'B-different' }) },
      { send },
    );
    expect(out.kind).toBe('sent');            // not blocked — genuinely different content
    expect(send).toHaveBeenCalledTimes(1);
  });
});
