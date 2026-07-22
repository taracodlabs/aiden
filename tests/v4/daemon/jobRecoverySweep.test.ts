/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { openDaemonDb, type Db } from '../../../core/v4/daemon/db/connection';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { sweepDurableJobRecovery } from '../../../core/v4/daemon/jobRecoverySweep';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';

describe('durable Job recovery sweep', () => {
  let db: Db | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('enqueues an expired read-only Attempt exactly once and repairs the recovery-to-queue crash window', () => {
    db = openDaemonDb(':memory:');
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('instance-old', 1, 'localhost', 1, 1, '4.15.1');
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('instance-new', 2, 'localhost', 2, 2, '4.15.1');
    const engine = createJobEngine({ db });
    const bus = createTriggerBus({ db });
    const admitted = engine.submitJob({
      entryPoint: 'schedule', source: 'schedule', sessionId: 'session-recovery',
      instanceId: 'instance-old', idempotencyNamespace: 'schedule:test',
      idempotencyKey: 'tick-1', goal: 'Read the current status',
    });
    const lease = engine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'worker-old', ttlMs: 10, now: 100,
    });
    expect(lease.acquired).toBe(true);
    expect(engine.transitionAttempt({
      attemptId: admitted.attemptId,
      expectedStateVersion: 1,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'running',
      eventIdempotencyKey: 'attempt-started',
      producer: 'worker-old',
      now: 101,
    }).applied).toBe(true);

    const first = sweepDurableJobRecovery({
      jobEngine: engine, triggerBus: bus, instanceId: 'instance-new',
      producer: 'recovery-sweep', now: 111,
    });
    expect(first).toMatchObject({ expired: 1, retried: 1, enqueued: 1 });

    const recovery = engine.listAttempts(admitted.jobId)[1]!;
    const event = bus.claim({ ownerId: 'dispatcher' });
    expect(event?.payload).toMatchObject({
      durable_job: {
        job_id: admitted.jobId,
        attempt_id: recovery.id,
        run_id: recovery.rowId,
      },
      resume: { taskId: admitted.jobId, ofRunId: recovery.rowId },
    });
    if (event) bus.release(event.id, event.claimToken);

    const second = sweepDurableJobRecovery({
      jobEngine: engine, triggerBus: bus, instanceId: 'instance-new',
      producer: 'recovery-sweep', now: 112,
    });
    expect(second).toMatchObject({ expired: 0, enqueued: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM trigger_events WHERE source_key = ?")
      .get(`job-recovery:${admitted.jobId}`)).toEqual({ count: 1 });
  });
});
