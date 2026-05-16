/**
 * v4.5 Phase 5a — integration test: trigger event → bus → dispatcher
 *                                → stub agent → markDone → runs table.
 *
 * The producer side (file watcher / webhook / email handler) is
 * already covered in their own test files. This integration test
 * inserts a synthetic trigger_event row directly into the bus and
 * asserts the dispatcher pulls it through end-to-end.
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

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-1', 1, 'h', Date.now(), Date.now(), '4.1.5');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('integration: file trigger → bus → dispatcher → agent → markDone', () => {
  it('end-to-end happy path produces a completed run linked to the event', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    // Seed trigger row (file watcher would have inserted it).
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('wat-1', 'file', 'docs-watcher',
           JSON.stringify({ paths: ['/repo/docs'], ignoreTemp: true }),
           1, 'A file changed at {{path}}.', 0, Date.now(), Date.now());

    // File watcher would have called bus.insert with this shape.
    const inserted = bus.insert({
      source:         'file',
      sourceKey:      'wat-1',
      idempotencyKey: '/repo/docs/README.md|1715800000000',
      payload:        { path: '/repo/docs/README.md', event: 'change', mtimeMs: 1715800000000 },
    });
    expect(inserted.inserted).toBe(true);

    let observed = '';
    let observedSession = '';
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-1', instanceId: 'inst-1',
      workerCount: 1,
      runnerFactory: () => makeRunner(async (input) => {
        observed = input.initialMessage;
        observedSession = input.sessionId;
        const runId = runStore.create({
          sessionId:      input.sessionId,
          instanceId:     input.instanceId,
          triggerEventId: input.triggerEventId,
          status:         'running',
        });
        runStore.emitEvent(runId, 'agent_turn_start', { tools: 0 });
        runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
        return { runId, finishReason: 'stop' };
      }),
    });

    const eventId = await dispatcher._pumpOnce();
    expect(eventId).toBe(inserted.id);
    expect(observed).toBe('A file changed at /repo/docs/README.md.');
    expect(observedSession).toMatch(/^trigger:file:wat-1:/);

    const evRow = bus.get(inserted.id);
    expect(evRow?.status).toBe('done');
    expect(evRow?.runId).not.toBeNull();

    const runRow = runStore.get(evRow!.runId!);
    expect(runRow?.status).toBe('completed');
    expect(runRow?.finishReason).toBe('stop');
    expect(runRow?.triggerEventId).toBe(inserted.id);
  });

  it('retries are stable: same idempotencyKey → same sessionId across attempts', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('wat-1', 'file', 'w', '{}', 1, null, 0, Date.now(), Date.now());
    bus.insert({
      source:         'file',
      sourceKey:      'wat-1',
      idempotencyKey: '/x|123',
      payload:        { path: '/x' },
    });
    const sessions: string[] = [];
    let counter = 0;
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-1', instanceId: 'inst-1',
      workerCount: 1,
      maxAttempts: 3,
      runnerFactory: () => makeRunner(async (input) => {
        sessions.push(input.sessionId);
        counter += 1;
        if (counter < 3) throw new Error('flake');
        const runId = runStore.create({
          sessionId:      input.sessionId,
          instanceId:     input.instanceId,
          triggerEventId: input.triggerEventId,
          status:         'running',
        });
        runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
        return { runId, finishReason: 'stop' };
      }),
    });
    await dispatcher._pumpOnce();   // attempt 1 throws
    await dispatcher._pumpOnce();   // attempt 2 throws
    await dispatcher._pumpOnce();   // attempt 3 succeeds
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[1]).toBe(sessions[2]);
    expect(sessions[0]).toMatch(/^trigger:file:wat-1:/);
  });
});
