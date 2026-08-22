import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAutomationAuthority } from '../../../core/v4/automation/automationAuthority';
import { createAutomationScheduler } from '../../../core/v4/automation/scheduler';
import { nextScheduleInstants } from '../../../core/v4/automation/schedule';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';

describe('automation schedule authority', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => db.close());

  it('previews timezone-bound UTC instants without consulting the machine timezone', () => {
    expect(nextScheduleInstants({
      expression: '0 9 * * *', timezone: 'Asia/Kolkata',
      after: '2026-08-20T00:00:00.000Z', count: 3,
    })).toEqual([
      '2026-08-20T03:30:00.000Z', '2026-08-21T03:30:00.000Z', '2026-08-22T03:30:00.000Z',
    ]);
  });

  it('handles spring gaps and autumn folds as unique deterministic instants', () => {
    const spring = nextScheduleInstants({
      expression: '30 2 * * *', timezone: 'America/New_York',
      after: '2026-03-07T00:00:00.000Z', count: 3,
    });
    const autumn = nextScheduleInstants({
      expression: '30 1 * * *', timezone: 'America/New_York',
      after: '2026-10-31T00:00:00.000Z', count: 4,
    });
    expect(new Set(spring).size).toBe(3);
    expect(new Set(autumn).size).toBe(4);
    expect(spring).toEqual([...spring].sort());
    expect(autumn).toEqual([...autumn].sort());
  });

  it('emits one durable TriggerBus receipt when the same due scan runs twice', () => {
    const now = Date.parse('2026-08-20T03:29:00.000Z');
    const created = createAutomationAuthority({ db }).create({
      name: 'Daily', action: { kind: 'prompt', prompt: 'Daily summary' },
      trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'Asia/Kolkata' },
      policies: { misfire: { kind: 'run_once' }, overlap: 'queue', retry: { maxAttempts: 2 } },
      capabilities: ['repository.read'], credentialRefs: [], workspace: { rootPath: process.cwd() }, createdBy: 'test', now,
    });
    const bus = createTriggerBus({ db });
    const scheduler = createAutomationScheduler({ db, triggerBus: bus, maxPerScan: 10 });
    expect(scheduler.scanDue(Date.parse('2026-08-20T03:30:01.000Z'))).toEqual({ scanned: 1, emitted: 1, duplicates: 0, released: 0 });
    db.prepare('UPDATE automation_trigger_bindings SET next_fire_at = ? WHERE automation_id = ?')
      .run('2026-08-20T03:30:00.000Z', created.definition.id);
    expect(scheduler.scanDue(Date.parse('2026-08-20T03:30:02.000Z'))).toEqual({ scanned: 1, emitted: 0, duplicates: 1, released: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM trigger_events WHERE source = 'schedule'").get()).toEqual({ count: 1 });
  });

  it('applies SKIP, RUN_ONCE and bounded CATCH_UP without unbounded scans', () => {
    const bus = createTriggerBus({ db });
    const authority = createAutomationAuthority({ db });
    const base = Date.parse('2026-08-20T00:00:00.000Z');
    for (const [name, misfire] of [
      ['skip', { kind: 'skip' as const }],
      ['once', { kind: 'run_once' as const }],
      ['catchup', { kind: 'catch_up' as const, maxOccurrences: 3 }],
    ] as const) {
      authority.create({
        name, action: { kind: 'prompt', prompt: name },
        trigger: { kind: 'schedule', expression: 'interval:60000', timezone: 'UTC' },
        policies: { misfire, overlap: 'queue', retry: { maxAttempts: 1 } },
        capabilities: [], credentialRefs: [], createdBy: 'test', now: base,
      });
    }
    const result = createAutomationScheduler({ db, triggerBus: bus, maxPerScan: 10, misfireGraceMs: 1_000 })
      .scanDue(base + 10 * 60_000);
    expect(result).toMatchObject({ scanned: 3, emitted: 4 });
    const byAutomation = db.prepare(
      `SELECT source_key,COUNT(*) AS count FROM trigger_events GROUP BY source_key ORDER BY count`,
    ).all() as Array<{ source_key: string; count: number }>;
    expect(byAutomation.map((row) => row.count)).toEqual([1, 3]);
  });

  it('emits a one-shot schedule once and disables its binding atomically', () => {
    const at = '2026-08-21T12:00:00.000Z';
    createAutomationAuthority({ db }).create({
      name: 'Once', action: { kind: 'prompt', prompt: 'Run once' },
      trigger: { kind: 'schedule', expression: `oneshot:${at}`, timezone: 'UTC' },
      policies: { misfire: { kind: 'run_once' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: [], credentialRefs: [], createdBy: 'test', now: Date.parse(at) - 60_000,
    });
    const scheduler = createAutomationScheduler({ db, triggerBus: createTriggerBus({ db }) });
    expect(scheduler.scanDue(Date.parse(at) + 1)).toMatchObject({ scanned: 1, emitted: 1 });
    expect(scheduler.scanDue(Date.parse(at) + 2)).toMatchObject({ scanned: 0, emitted: 0 });
    expect(db.prepare('SELECT enabled,next_fire_at FROM automation_trigger_bindings').get())
      .toEqual({ enabled: 0, next_fire_at: null });
  });

  it('rolls back trigger emission when next-fire persistence fails, then emits once on recovery', () => {
    const due = '2026-08-21T12:00:00.000Z';
    createAutomationAuthority({ db }).create({
      name: 'Crash-safe', action: { kind: 'prompt', prompt: 'Run once' },
      trigger: { kind: 'schedule', expression: `oneshot:${due}`, timezone: 'UTC' },
      policies: { misfire: { kind: 'run_once' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: [], credentialRefs: [], createdBy: 'test', now: Date.parse(due) - 60_000,
    });
    db.exec(`CREATE TRIGGER fail_next_fire BEFORE UPDATE ON automation_trigger_bindings
      BEGIN SELECT RAISE(ABORT, 'injected scheduler persistence crash'); END;`);
    const scheduler = createAutomationScheduler({ db, triggerBus: createTriggerBus({ db }) });
    expect(() => scheduler.scanDue(Date.parse(due) + 1)).toThrow(/injected scheduler persistence crash/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM trigger_events').get()).toEqual({ count: 0 });
    db.exec('DROP TRIGGER fail_next_fire');
    expect(scheduler.scanDue(Date.parse(due) + 2)).toMatchObject({ emitted: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM trigger_events').get()).toEqual({ count: 1 });
  });

  it('does not replay an admitted instant when the wall clock moves backward', () => {
    const base = Date.parse('2026-08-21T12:00:00.000Z');
    createAutomationAuthority({ db }).create({
      name: 'Rollback-safe', action: { kind: 'prompt', prompt: 'Run' },
      trigger: { kind: 'schedule', expression: 'interval:60000', timezone: 'UTC' },
      policies: { misfire: { kind: 'run_once' }, overlap: 'queue', retry: { maxAttempts: 1 } },
      capabilities: [], credentialRefs: [], createdBy: 'test', now: base,
    });
    const first = createAutomationScheduler({ db, triggerBus: createTriggerBus({ db }) });
    const second = createAutomationScheduler({ db, triggerBus: createTriggerBus({ db }) });
    expect(first.scanDue(base + 60_001)).toMatchObject({ emitted: 1 });
    expect(second.scanDue(base + 30_000)).toMatchObject({ scanned: 0, emitted: 0 });
    expect(first.scanDue(base + 60_002)).toMatchObject({ scanned: 0, emitted: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM trigger_events').get()).toEqual({ count: 1 });
  });
});
