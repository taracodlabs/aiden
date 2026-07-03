/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 1 — the idempotency ledger wired into the DeliveryContext
 * seam (`withIdempotentDelivery`).
 *
 * Proves, through a REAL DeliveryContext (a counting driver) + a REAL ledger
 * on a sqlite file:
 *   • a fresh committed send goes out and is recorded;
 *   • a RESUME (fresh wrapper, same taskId, same db) does NOT re-send —
 *     the driver's send count stays put, the receipt is `replayed`, onSkip
 *     fires (→ the ↷ evidence line);
 *   • ephemeral kinds (progress/status) always pass through (never gated);
 *   • a crash mid-send (intent, no confirm) surfaces needs-confirmation on
 *     resume instead of re-firing;
 *   • content drift at the same ordinal surfaces needs-confirmation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { SideEffectLedger, sideEffectKey, argsHashOf } from '../../../core/v4/sideEffectLedger';
import { withIdempotentDelivery } from '../../../core/v4/idempotentDelivery';
import { createDeliveryContext, type DeliveryBinding, type DeliveryContext } from '../../../core/deliveryContext';

let tmp: string;
let dbFile: string;
let db: Database.Database;

const CAPS = { edit: false, chunkLongMessages: true, media: [] as string[], voiceBubble: false, reactions: false };

/** A DeliveryContext whose driver counts every actual platform send. */
function makeCtx(sink: { sends: Array<{ kind: string; text: string }> }): DeliveryContext {
  const binding: DeliveryBinding = {
    capabilities: CAPS,
    driver: {
      deliver: async (kind, payload) => {
        sink.sends.push({ kind, text: payload.text ?? '' });
        return { ok: true, kind, chunks: 1 };
      },
    },
  };
  return createDeliveryContext({ platform: 'discord', chatId: 'c1', threadId: 't1' }, binding);
}

function openLedger(): SideEffectLedger {
  db = new Database(dbFile);
  runMigrations(db);
  return new SideEffectLedger(db);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-idem-deliv-'));
  dbFile = path.join(tmp, 'daemon.db');
});
afterEach(async () => {
  try { db?.close(); } catch { /* closed */ }
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe('withIdempotentDelivery — committed sends', () => {
  it('fresh final send goes out once and is recorded confirmed', async () => {
    const ledger = openLedger();
    const sink = { sends: [] as Array<{ kind: string; text: string }> };
    const ctx = withIdempotentDelivery(makeCtx(sink), ledger, { taskId: 'task_1' });
    const r = await ctx.send('final', 'the answer is 42');
    expect(r.ok).toBe(true);
    expect(r.replayed).toBeUndefined();
    expect(sink.sends).toHaveLength(1);
    const key = sideEffectKey({ taskId: 'task_1', step: 0, tool: 'channel_send', argsHash: argsHashOf({ platform: 'discord', chatId: 'c1', threadId: 't1', kind: 'final', text: 'the answer is 42' }) });
    expect(ledger.lookup(key)?.status).toBe('confirmed');
  });

  it('RESUME (fresh wrapper, same task, same db) does NOT re-send — no double-send', async () => {
    // Run 1 delivers.
    const l1 = openLedger();
    const sink1 = { sends: [] as Array<{ kind: string; text: string }> };
    await withIdempotentDelivery(makeCtx(sink1), l1, { taskId: 'task_1' }).send('final', 'hello world');
    expect(sink1.sends).toHaveLength(1);
    db.close();                                            // crash after delivery

    // Run 2 (resume) re-drives the same task and tries to deliver again.
    const l2 = openLedger();
    const sink2 = { sends: [] as Array<{ kind: string; text: string }> };
    const skips: Array<{ target: string; reason: string }> = [];
    const ctx2 = withIdempotentDelivery(makeCtx(sink2), l2, {
      taskId: 'task_1',
      onSkip: (n) => skips.push({ target: n.target, reason: n.reason }),
    });
    const r = await ctx2.send('final', 'hello world');
    expect(sink2.sends).toHaveLength(0);                   // ← nothing re-sent
    expect(r.ok).toBe(true);
    expect(r.replayed).toBe(true);
    expect(skips).toHaveLength(1);
    expect(skips[0].target).toBe('discord:c1');
    expect(skips[0].reason).toMatch(/idempotent_replay/);
  });

  it('ephemeral kinds (progress/status) always pass through — never gated', async () => {
    const ledger = openLedger();
    const sink = { sends: [] as Array<{ kind: string; text: string }> };
    const ctx = withIdempotentDelivery(makeCtx(sink), ledger, { taskId: 'task_1' });
    await ctx.send('progress', 'thinking…');
    await ctx.send('status', 'still working');
    await ctx.send('progress', 'thinking…');               // identical repeat, still delivered
    expect(sink.sends.map((s) => s.kind)).toEqual(['progress', 'status', 'progress']);
  });

  it('multiple committed sends consume ordinals independently of ephemeral ones', async () => {
    const l1 = openLedger();
    const sink1 = { sends: [] as Array<{ kind: string; text: string }> };
    const c1 = withIdempotentDelivery(makeCtx(sink1), l1, { taskId: 'task_1' });
    await c1.send('final', 'first');
    await c1.send('progress', 'mid');       // ephemeral — no ordinal consumed
    await c1.send('final', 'second');
    expect(sink1.sends.map((s) => s.text)).toEqual(['first', 'mid', 'second']);
    db.close();

    // Resume: both committed sends map back to their ordinals → both skipped.
    const l2 = openLedger();
    const sink2 = { sends: [] as Array<{ kind: string; text: string }> };
    const c2 = withIdempotentDelivery(makeCtx(sink2), l2, { taskId: 'task_1' });
    const r1 = await c2.send('final', 'first');
    const r2 = await c2.send('final', 'second');
    expect(r1.replayed).toBe(true);
    expect(r2.replayed).toBe(true);
    expect(sink2.sends).toHaveLength(0);
  });
});

describe('withIdempotentDelivery — never re-fires on ambiguous state', () => {
  it('crash between intent and confirm → resume surfaces needs-confirmation, nothing sent', async () => {
    // Pre-seed the exact ATTEMPTING row the decorator would write for
    // task_1 / step 0 / this text — a send that crashed before confirm.
    const text = 'important';
    const argsHash = argsHashOf({ platform: 'discord', chatId: 'c1', threadId: 't1', kind: 'final', text });
    const key = sideEffectKey({ taskId: 'task_1', step: 0, tool: 'channel_send', argsHash });
    const l1 = openLedger();
    l1.beginIntent({ key, taskId: 'task_1', step: 0, tool: 'channel_send', argsHash });
    db.close();

    const l2 = openLedger();
    const sink = { sends: [] as Array<{ kind: string; text: string }> };
    const blocked: string[] = [];
    const ctx = withIdempotentDelivery(makeCtx(sink), l2, {
      taskId: 'task_1',
      onNeedsConfirmation: (n) => blocked.push(n.reason),
    });
    const r = await ctx.send('final', text);
    expect(sink.sends).toHaveLength(0);                    // ← not re-fired
    expect(r.ok).toBe(false);
    expect(blocked).toHaveLength(1);
  });

  it('content drift at the same ordinal → needs-confirmation, nothing sent', async () => {
    const l1 = openLedger();
    await withIdempotentDelivery(makeCtx({ sends: [] }), l1, { taskId: 'task_1' }).send('final', 'version A');
    db.close();

    const l2 = openLedger();
    const sink = { sends: [] as Array<{ kind: string; text: string }> };
    const blocked: string[] = [];
    const ctx = withIdempotentDelivery(makeCtx(sink), l2, {
      taskId: 'task_1',
      onNeedsConfirmation: (n) => blocked.push(n.reason),
    });
    const r = await ctx.send('final', 'version B DIFFERENT');   // same step 0, different content
    expect(sink.sends).toHaveLength(0);
    expect(r.ok).toBe(false);
    expect(blocked[0]).toMatch(/prior run/);
  });

  // v4.14 Pillar 5 Slice C — needs_confirmation also emits the pillar event
  // (durable run_events) when a sink is wired.
  it('emits needs_confirmation onto run_events when a pillarSink is provided', async () => {
    const l1 = openLedger();
    await withIdempotentDelivery(makeCtx({ sends: [] }), l1, { taskId: 'task_1' }).send('final', 'version A');
    db.close();

    const l2 = openLedger();
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const ctx = withIdempotentDelivery(makeCtx({ sends: [] }), l2, {
      taskId: 'task_1',
      pillarSink: {
        runStore: { emitEventRich: (o) => { events.push({ name: String(o.name), payload: o.payload as Record<string, unknown> }); return 1; } },
        runId: 42,
      },
    });
    const r = await ctx.send('final', 'version B DIFFERENT');   // same ordinal, drift → needs_confirmation
    expect(r.ok).toBe(false);
    const nc = events.find((e) => e.name === 'needs_confirmation');
    expect(nc).toBeTruthy();
    expect(nc!.payload.tool).toBe('channel_send');
  });

  it('a throwing pillarSink is swallowed — the delivery decision still returns', async () => {
    const l1 = openLedger();
    await withIdempotentDelivery(makeCtx({ sends: [] }), l1, { taskId: 'task_1' }).send('final', 'version A');
    db.close();

    const l2 = openLedger();
    const ctx = withIdempotentDelivery(makeCtx({ sends: [] }), l2, {
      taskId: 'task_1',
      pillarSink: { runStore: { emitEventRich: () => { throw new Error('DB down'); } }, runId: 1 },
    });
    const r = await ctx.send('final', 'version B DIFFERENT');
    expect(r.ok).toBe(false);   // telemetry failure did not break the decision
  });
});
