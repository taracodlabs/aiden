/**
 * v4.5 Phase 7c — dispatcher.installRunner atomic swap tests.
 *
 * Covers:
 *   1. Dispatcher starts with placeholder runner (runnerKind='placeholder')
 *   2. installRunner flips runnerKind → 'real'
 *   3. Swap takes effect on the NEXT claim — in-flight claim
 *      continues on the previous runner
 *   4. Multiple swaps work (idempotent within the lifecycle)
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
  DaemonAgentInput,
  DaemonAgentResult,
  DaemonAgentRunner,
} from '../../../../core/v4/daemon/dispatcher';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-7c', 1, 'h', Date.now(), Date.now(), '4.5.0');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

function placeholderRunner(runStore: ReturnType<typeof createRunStore>, label = 'placeholder'): DaemonAgentRunner {
  return makeRunner(async (input: DaemonAgentInput): Promise<DaemonAgentResult> => {
    const runId = runStore.create({
      sessionId:      input.sessionId,
      instanceId:     input.instanceId,
      triggerEventId: input.triggerEventId,
      status:         'running',
    });
    runStore.emitEvent(runId, `${label}:invoked`, { eventId: input.triggerEventId });
    runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
    return { runId, finishReason: 'stop' };
  });
}

describe('Dispatcher.installRunner — runner kind tracking', () => {
  it('starts as runnerKind=none, then placeholder after start()', () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-7c', instanceId: 'inst-7c',
      workerCount: 1,
      runnerFactory: () => placeholderRunner(runStore),
    });
    expect(dispatcher.runnerKind()).toBe('none');
    dispatcher.start();
    expect(dispatcher.runnerKind()).toBe('placeholder');
  });

  it('installRunner flips runnerKind → real', () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-7c', instanceId: 'inst-7c',
      workerCount: 1,
      runnerFactory: () => placeholderRunner(runStore),
    });
    dispatcher.start();
    dispatcher.installRunner(placeholderRunner(runStore, 'real'));
    expect(dispatcher.runnerKind()).toBe('real');
  });
});

describe('Dispatcher.installRunner — claim swap behavior', () => {
  it('next claim after installRunner uses the new runner', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-7c', instanceId: 'inst-7c',
      workerCount: 1,
      runnerFactory: () => placeholderRunner(runStore, 'placeholder'),
    });
    dispatcher.start();

    // First event — should use placeholder.
    const { id: id1 } = bus.insert({ source: 'manual', sourceKey: 'k', idempotencyKey: 'i1', payload: {} });
    await dispatcher._pumpOnce();
    const evRow1 = bus.get(id1);
    const events1 = runStore.listEvents(evRow1!.runId!);
    expect(events1.map((e) => e.kind)).toContain('placeholder:invoked');

    // Swap.
    dispatcher.installRunner(placeholderRunner(runStore, 'real'));

    // Second event — should use real.
    const { id: id2 } = bus.insert({ source: 'manual', sourceKey: 'k', idempotencyKey: 'i2', payload: {} });
    await dispatcher._pumpOnce();
    const evRow2 = bus.get(id2);
    const events2 = runStore.listEvents(evRow2!.runId!);
    expect(events2.map((e) => e.kind)).toContain('real:invoked');
    expect(events2.map((e) => e.kind)).not.toContain('placeholder:invoked');
  });

  it('multiple swaps — last one wins', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-7c', instanceId: 'inst-7c',
      workerCount: 1,
      runnerFactory: () => placeholderRunner(runStore, 'v0'),
    });
    dispatcher.start();
    dispatcher.installRunner(placeholderRunner(runStore, 'v1'));
    dispatcher.installRunner(placeholderRunner(runStore, 'v2'));
    expect(dispatcher.runnerKind()).toBe('real');
    const { id } = bus.insert({ source: 'manual', sourceKey: 'k', idempotencyKey: 'i', payload: {} });
    await dispatcher._pumpOnce();
    const events = runStore.listEvents(bus.get(id)!.runId!);
    expect(events.map((e) => e.kind)).toContain('v2:invoked');
  });
});
