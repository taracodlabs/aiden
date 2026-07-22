/**
 * v4.5 Phase 5a — deliver_only stub tests.
 *
 * Covers:
 *   1. spec.deliver_only=1 → runner NOT invoked; run row marked completed
 *   2. The `delivered` run_event is emitted with the rendered message
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import { createRunStore } from '../../../../core/v4/daemon/runStore';
import { createJobEngine } from '../../../../core/v4/daemon/jobEngine';
import {
  createDispatcher,
  makeRunner,
} from '../../../../core/v4/daemon/dispatcher';
import type {
  DaemonAgentInput,
  DaemonAgentResult,
} from '../../../../core/v4/daemon/dispatcher';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances
    (instance_id, pid, hostname, started_at, last_heartbeat, version)
    VALUES (?, ?, ?, ?, ?, ?)`).run('inst-1', 1, 'h', Date.now(), Date.now(), '4.5.0');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('dispatcher — deliver_only stub', () => {
  it('skips the agent runner when spec.deliver_only=1', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t1', 'manual', 'notify', '{}', 1, 'Hello {{name}}', 1, Date.now(), Date.now());
    const { id } = bus.insert({ source: 'manual', sourceKey: 't1', idempotencyKey: 'k', payload: { name: 'world' } });
    const invocations: DaemonAgentInput[] = [];
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-1', instanceId: 'inst-1',
      workerCount: 1,
      runnerFactory: () => makeRunner(async (input) => {
        invocations.push(input);
        // Should NEVER be reached.
        return { runId: 0, finishReason: 'stop' } as DaemonAgentResult;
      }),
    });
    await dispatcher._pumpOnce();
    expect(invocations).toHaveLength(0);
    expect(dispatcher.stats().deliverOnly).toBe(1);
    const row = bus.get(id);
    expect(row?.status).toBe('done');
    // A run row was still created (forensic trail).
    expect(row?.runId).not.toBeNull();
    // v4.10 Slice 10.2b — select `name` (stable emitter id). `kind`
    // is now the dotted taxonomy form (`dispatcher.delivered`).
    const events = db.prepare(`SELECT kind, name, payload FROM run_events WHERE run_id = ? ORDER BY id`)
      .all(row!.runId) as Array<{ kind: string; name: string | null; payload: string }>;
    expect(events.find((e) => e.name === 'delivered')).toBeTruthy();
  });

  it('rendered message length lands in the delivered event payload', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t2', 'manual', 'n', '{}', 1, 'event id={{eventId}} src={{source}}', 1, Date.now(), Date.now());
    bus.insert({ source: 'manual', sourceKey: 't2', idempotencyKey: 'k', payload: {} });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, db,
      ownerId: 'inst-1', instanceId: 'inst-1',
      workerCount: 1,
      runnerFactory: () => makeRunner(async () => ({ runId: 0, finishReason: 'stop' })),
    });
    await dispatcher._pumpOnce();
    const ev = db.prepare(`SELECT payload FROM run_events WHERE name='delivered'`).get() as { payload: string };
    const parsed = JSON.parse(ev.payload);
    expect(parsed.deliverOnly).toBe(true);
    expect(parsed.messageBytes).toBeGreaterThan(0);
  });

  it('uses one authoritative Job and Attempt when the durable authority is available', async () => {
    const bus = createTriggerBus({ db });
    const runStore = createRunStore({ db });
    const jobEngine = createJobEngine({ db });
    db.prepare(`INSERT INTO triggers (id, source, name, spec_json, enabled, prompt_template, deliver_only, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t3', 'manual', 'durable-notify', '{}', 1, 'Durable delivery', 1, Date.now(), Date.now());
    const trigger = bus.insert({ source: 'manual', sourceKey: 't3', idempotencyKey: 'durable', payload: {} });
    const dispatcher = createDispatcher({
      triggerBus: bus, runStore, jobEngine, db,
      ownerId: 'inst-1', instanceId: 'inst-1', workerCount: 1,
      runnerFactory: () => makeRunner(async () => ({ runId: 0, finishReason: 'stop' })),
    });

    await dispatcher._pumpOnce();

    const row = bus.get(trigger.id)!;
    const jobs = jobEngine.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'completed', terminalOutcome: 'delivered' });
    expect(jobEngine.listAttempts(jobs[0]!.id)).toEqual([
      expect.objectContaining({ rowId: row.runId, status: 'succeeded' }),
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
  });
});
