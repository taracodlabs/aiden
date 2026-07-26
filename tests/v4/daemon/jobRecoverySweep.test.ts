/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDaemonDb, type Db } from '../../../core/v4/daemon/db/connection';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { sweepDurableJobRecovery } from '../../../core/v4/daemon/jobRecoverySweep';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';

describe('durable Job recovery sweep', () => {
  let db: Db | null = null;
  const tempDirs: string[] = [];

  afterEach(() => {
    db?.close();
    db = null;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

  it('reconciles an externally completed file effect before scheduling recovery', () => {
    db = openDaemonDb(':memory:');
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('instance-old', 1, 'localhost', 1, 1, '4.16.1'),
              ('instance-new', 2, 'localhost', 2, 2, '4.16.1')`,
    ).run();
    const engine = createJobEngine({ db });
    const bus = createTriggerBus({ db });
    const admitted = engine.submitJob({
      entryPoint: 'daemon', source: 'daemon', sessionId: 'session-effect-recovery',
      instanceId: 'instance-old', idempotencyNamespace: 'effect-recovery',
      idempotencyKey: 'job-1', goal: 'write one file',
    });
    const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'worker-old', ttlMs: 10, now: 100 });
    const dir = mkdtempSync(join(tmpdir(), 'aiden-recovery-effect-'));
    tempDirs.push(dir);
    const path = join(dir, 'result.txt');
    const content = 'already written';
    engine.prepareToolCall({
      toolCallId: 'tool_file', jobId: admitted.jobId, attemptId: admitted.attemptId,
      generation: lease.generation!, fenceToken: lease.fenceToken!, toolName: 'file_write',
      normalizedArgsDigest: 'digest', riskTier: 'caution', mutates: true,
      effect: {
        classification: 'reconcilable_mutation', kind: 'filesystem.write', target: path,
        retrySafety: 'reconcile_before_retry', idempotencySupported: true, idempotencyKey: 'idem-file',
        reconciliationSupported: true, verificationSupported: true,
        approvalRequirement: 'policy', approvalState: 'not_required', sensitiveFields: ['content'],
        redactionRules: ['digest_arguments'], trusted: true,
        reconciliationData: {
          path, before: { exists: false }, expectedSize: Buffer.byteLength(content),
          expectedContentSha256: createHash('sha256').update(content).digest('hex'),
        },
      },
      producer: 'test', now: 101,
    });
    engine.startToolCall({
      toolCallId: 'tool_file', attemptId: admitted.attemptId,
      generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test', now: 102,
    });
    writeFileSync(path, content);

    const sweep = sweepDurableJobRecovery({
      jobEngine: engine, triggerBus: bus, instanceId: 'instance-new',
      producer: 'recovery-sweep', now: 111,
    });

    expect(sweep).toMatchObject({ expired: 1, reconciled: 1, needsUser: 0, retried: 1, enqueued: 1 });
    expect(engine.listEffectReconciliations('side_effect:tool_file')).toMatchObject([
      { outcome: 'occurred', confidence: 'high', humanResolutionRequired: false },
    ]);
    expect(engine.listAttempts(admitted.jobId)).toHaveLength(2);
  });
});
