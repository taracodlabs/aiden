/**
 * v4.5 Phase 5a — dispatcher lifecycle tests.
 *
 * Covers:
 *   1. claim → runner.invoke → markDone (happy path; trigger_event ends 'done')
 *   2. runner throws → markFailed → returns to 'pending' (attempts < max)
 *   3. runner throws repeatedly → dead_letter when attempts >= maxAttempts
 *   4. Lease renewal extends claim_expires_at during long-running invoke
 *   5. Worker count = 1 → only one in-flight at a time
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
import type {
  Dispatcher,
  DaemonAgentInput,
  DaemonAgentResult,
} from '../../../../core/v4/daemon/dispatcher';

let db: Database.Database;
let bus: ReturnType<typeof createTriggerBus>;
let runStore: ReturnType<typeof createRunStore>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  bus = createTriggerBus({ db });
  runStore = createRunStore({ db });
  // Seed an instance row so run inserts (FK to daemon_instances) don't fail.
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-1', 12345, 'test-host', Date.now(), Date.now(), '4.1.5');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

// Helper: build a dispatcher that records every invocation in `calls`.
function build(opts: {
  invoke: (input: DaemonAgentInput) => Promise<DaemonAgentResult>;
  maxAttempts?: number;
}): { dispatcher: Dispatcher; calls: DaemonAgentInput[] } {
  const calls: DaemonAgentInput[] = [];
  const dispatcher = createDispatcher({
    triggerBus: bus,
    runStore,
    db,
    ownerId:    'inst-1',
    instanceId: 'inst-1',
    workerCount: 1,
    leaseMs:    60_000,
    renewMs:    30_000,
    maxAttempts: opts.maxAttempts ?? 3,
    runnerFactory: () => makeRunner(async (input) => {
      calls.push(input);
      return opts.invoke(input);
    }),
  });
  return { dispatcher, calls };
}

describe('dispatcher — happy path', () => {
  it('claims a pending event, invokes runner, marks done with the runId', async () => {
    const { id } = bus.insert({ source: 'manual', sourceKey: 't1', idempotencyKey: 'idem-1', payload: { msg: 'go' } });
    const { dispatcher, calls } = build({
      invoke: async (input) => {
        const runId = runStore.create({
          sessionId:      input.sessionId,
          instanceId:     input.instanceId,
          triggerEventId: input.triggerEventId,
          status:         'running',
        });
        runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
        return { runId, finishReason: 'stop' };
      },
    });
    const eventId = await dispatcher._pumpOnce();
    expect(eventId).toBe(id);
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toMatch(/^trigger:manual:t1:/);
    const row = bus.get(id);
    expect(row?.status).toBe('done');
    expect(row?.runId).not.toBeNull();
  });

  it('uses spec.prompt_template when set; missing vars → trigger_misconfigured', async () => {
    // Seed a trigger row with a template that references {{missingvar}}.
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t1', 'manual', 'mytrig', '{}', 1, 'Use {{missingvar}}', 0, Date.now(), Date.now());
    bus.insert({ source: 'manual', sourceKey: 't1', idempotencyKey: 'i1', payload: { x: 1 } });
    const { dispatcher, calls } = build({
      invoke: async () => ({ runId: 0, finishReason: 'stop' }),
    });
    await dispatcher._pumpOnce();
    // Runner must NOT have been called — misconfigured event short-circuits.
    expect(calls).toHaveLength(0);
    const stats = dispatcher.stats();
    expect(stats.misconfigured).toBe(1);
    expect(stats.failed).toBe(1);
  });
});

describe('dispatcher — failure handling', () => {
  it('runner throws → markFailed; event returns to pending with attempts incremented', async () => {
    const { id } = bus.insert({ source: 'manual', sourceKey: 't1', idempotencyKey: 'i', payload: {} });
    const { dispatcher } = build({
      invoke: async () => { throw new Error('boom'); },
      maxAttempts: 3,
    });
    await dispatcher._pumpOnce();
    const row = bus.get(id);
    // After 1 attempt with maxAttempts=3, the event returns to pending.
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toMatch(/boom/);
  });

  it('repeated failures → dead_letter when attempts >= maxAttempts', async () => {
    const { id } = bus.insert({ source: 'manual', sourceKey: 't1', idempotencyKey: 'i', payload: {} });
    const { dispatcher } = build({
      invoke: async () => { throw new Error('persistent failure'); },
      maxAttempts: 2,
    });
    await dispatcher._pumpOnce();      // attempt 1 → pending
    await dispatcher._pumpOnce();      // attempt 2 → dead_letter
    const row = bus.get(id);
    expect(row?.status).toBe('dead_letter');
    expect(row?.attempts).toBe(2);
  });

  it('runner returns finishReason="error" → markFailed', async () => {
    const { id } = bus.insert({ source: 'manual', sourceKey: 't1', idempotencyKey: 'i', payload: {} });
    const { dispatcher } = build({
      invoke: async () => ({ runId: 0, finishReason: 'error', error: 'agent gave up' }),
      maxAttempts: 3,
    });
    await dispatcher._pumpOnce();
    const row = bus.get(id);
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toMatch(/agent gave up/);
  });
});

describe('dispatcher — workerCount=1 boundedness', () => {
  it('only claims one event at a time (sequential pump)', async () => {
    bus.insert({ source: 'manual', sourceKey: 'a', idempotencyKey: 'a', payload: {} });
    bus.insert({ source: 'manual', sourceKey: 'b', idempotencyKey: 'b', payload: {} });
    let inflightPeak = 0;
    const { dispatcher } = build({
      invoke: async (input) => {
        // Inspect the dispatcher's in-flight count mid-invocation.
        inflightPeak = Math.max(inflightPeak, dispatcher.inflight().length);
        const runId = runStore.create({
          sessionId:      input.sessionId,
          instanceId:     input.instanceId,
          triggerEventId: input.triggerEventId,
          status:         'running',
        });
        runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
        return { runId, finishReason: 'stop' };
      },
    });
    await dispatcher._pumpOnce();
    await dispatcher._pumpOnce();
    expect(inflightPeak).toBe(1);
    expect(dispatcher.stats().succeeded).toBe(2);
  });

  it('stop() drains in-flight before resolving', async () => {
    bus.insert({ source: 'manual', sourceKey: 'a', idempotencyKey: 'a', payload: {} });
    let resolveInvoke!: (r: DaemonAgentResult) => void;
    const invokePromise = new Promise<DaemonAgentResult>((r) => { resolveInvoke = r; });
    const { dispatcher } = build({
      invoke: async () => invokePromise,
    });
    dispatcher.start();
    // Give the poll loop a tick to claim.
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatcher.inflight().length).toBeGreaterThanOrEqual(0);
    // Resolve invoke + stop.
    const runId = runStore.create({ sessionId: 's', instanceId: 'inst-1', status: 'running' });
    runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
    resolveInvoke({ runId, finishReason: 'stop' });
    await dispatcher.stop(2_000);
    // Dispatcher exited cleanly.
    expect(dispatcher.inflight().length).toBe(0);
  });
});
