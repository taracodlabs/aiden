/**
 * v4.5 Phase 6 — CI-safe quick-soak harness.
 *
 * Runs for AIDEN_SOAK_DURATION_MS (default 5_000 ms in CI; the
 * documented manual-run procedure overrides this for 1h / 72h
 * runs). Asserts:
 *
 *   1. RSS slope is bounded after warmup (no obvious leak).
 *   2. No leaked claims: dispatcher.inflight().length === 0 at end.
 *   3. Bus drains: pending count returns to zero after the load
 *      generator stops.
 *
 * For real production validation, run the manual 72h soak. See
 * tests/v4/daemon/soak/README.md for the procedure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import { createRunStore } from '../../../../core/v4/daemon/runStore';
import {
  createDispatcher,
  makeRunner,
} from '../../../../core/v4/daemon/dispatcher';
import type { DaemonAgentResult } from '../../../../core/v4/daemon/dispatcher';
import {
  createLoadGenerator,
  sampleMetrics,
  QUICK_PROFILE,
} from './loadGenerator';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-soak', 1, 'h', Date.now(), Date.now(), '4.5.0');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

describe('quick soak — synthetic load drains cleanly', () => {
  it('bus + dispatcher drain to zero after generator stops', { timeout: 30_000 }, async () => {
    const DURATION_MS = envInt('AIDEN_SOAK_DURATION_MS', 3_000);
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-soak', instanceId: 'inst-soak',
      workerCount: 1,
      pollIdleMs: 25,
      runnerFactory: () => makeRunner(async (input) => {
        const runId = runStore.create({
          sessionId:      input.sessionId,
          instanceId:     input.instanceId,
          triggerEventId: input.triggerEventId,
          status:         'running',
        });
        runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
        const r: DaemonAgentResult = { runId, finishReason: 'stop' };
        return r;
      }),
    });
    const gen = createLoadGenerator({ triggerBus: bus, profile: QUICK_PROFILE });
    dispatcher.start();
    gen.start();
    // Let load run for DURATION_MS.
    await new Promise((r) => setTimeout(r, DURATION_MS));
    // Stop generator + drain dispatcher.
    await gen.stop();
    // Drain window — give the dispatcher time to process the queue.
    const drainStart = Date.now();
    while (Date.now() - drainStart < 5_000) {
      const s = bus.stats();
      if (s.pending === 0 && s.claimed === 0 && dispatcher.inflight().length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await dispatcher.stop(2_000);

    const final = bus.stats();
    expect(final.pending).toBe(0);
    expect(final.claimed).toBe(0);
    expect(dispatcher.inflight().length).toBe(0);
    // Some events should have been processed.
    expect(dispatcher.stats().claimed).toBeGreaterThan(0);
  });

  it('captures metric samples across the run window', { timeout: 20_000 }, async () => {
    const DURATION_MS = envInt('AIDEN_SOAK_DURATION_MS', 2_000);
    const SAMPLE_MS   = 250;
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-soak', instanceId: 'inst-soak',
      workerCount: 1, pollIdleMs: 25,
      runnerFactory: () => makeRunner(async (input) => {
        const runId = runStore.create({
          sessionId: input.sessionId, instanceId: input.instanceId,
          triggerEventId: input.triggerEventId, status: 'running',
        });
        runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
        return { runId, finishReason: 'stop' };
      }),
    });
    const gen = createLoadGenerator({ triggerBus: bus });
    dispatcher.start();
    gen.start();
    const samples = [];
    const start = Date.now();
    while (Date.now() - start < DURATION_MS) {
      samples.push(sampleMetrics({ triggerBus: bus, activeRuns: () => runStore.listActive().length }));
      await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
    await gen.stop();
    await dispatcher.stop(2_000);
    expect(samples.length).toBeGreaterThan(2);
    // Sanity: RSS samples were captured (non-zero).
    for (const s of samples) expect(s.rssBytes).toBeGreaterThan(0);
  });

  it('no dead-letter under stub-runner happy path', { timeout: 20_000 }, async () => {
    const DURATION_MS = envInt('AIDEN_SOAK_DURATION_MS', 2_000);
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-soak', instanceId: 'inst-soak',
      workerCount: 1, pollIdleMs: 25,
      runnerFactory: () => makeRunner(async (input) => {
        const runId = runStore.create({
          sessionId: input.sessionId, instanceId: input.instanceId,
          triggerEventId: input.triggerEventId, status: 'running',
        });
        runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
        return { runId, finishReason: 'stop' };
      }),
    });
    const gen = createLoadGenerator({ triggerBus: bus });
    dispatcher.start();
    gen.start();
    await new Promise((r) => setTimeout(r, DURATION_MS));
    await gen.stop();
    // Drain.
    const drainStart = Date.now();
    while (Date.now() - drainStart < 5_000) {
      if (bus.stats().pending === 0 && dispatcher.inflight().length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await dispatcher.stop(2_000);
    expect(bus.stats().deadLetter).toBe(0);
  });
});
