/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reconcileFilesystemEffectSync } from '../../../core/v4/effectReconciliation';
import { openDaemonDb, type Db } from '../../../core/v4/daemon/db/connection';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';

describe('Effect reconciliation across process restart', () => {
  let db: Db | null = null;
  const dirs: string[] = [];

  afterEach(() => {
    db?.close();
    db = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('retains the unknown Effect and resolves external file state after reopening SQLite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiden-effect-restart-'));
    dirs.push(dir);
    const dbPath = join(dir, 'runtime.db');
    const target = join(dir, 'result.txt');
    const content = 'persisted before crash';
    db = openDaemonDb(dbPath);
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('old', 1, 'localhost', 1, 1, '4.16.1'),
              ('new', 2, 'localhost', 2, 2, '4.16.1')`,
    ).run();
    let engine = createJobEngine({ db });
    const admitted = engine.submitJob({
      entryPoint: 'daemon', source: 'daemon', sessionId: 'session-restart', instanceId: 'old',
      idempotencyNamespace: 'restart', idempotencyKey: 'job', goal: 'write result',
    });
    const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'worker', ttlMs: 10, now: 100 });
    engine.prepareToolCall({
      toolCallId: 'tool_restart', jobId: admitted.jobId, attemptId: admitted.attemptId,
      generation: lease.generation!, fenceToken: lease.fenceToken!, toolName: 'file_write',
      normalizedArgsDigest: 'digest', riskTier: 'caution', mutates: true,
      effect: {
        classification: 'reconcilable_mutation', kind: 'filesystem.write', target,
        retrySafety: 'reconcile_before_retry', idempotencySupported: true, idempotencyKey: 'idem-restart',
        reconciliationSupported: true, verificationSupported: true,
        approvalRequirement: 'policy', approvalState: 'not_required', sensitiveFields: ['content'],
        redactionRules: ['digest_arguments'], trusted: true,
        reconciliationData: {
          path: target, before: { exists: false }, expectedSize: Buffer.byteLength(content),
          expectedContentSha256: createHash('sha256').update(content).digest('hex'),
        },
      },
      producer: 'test', now: 101,
    });
    engine.startToolCall({
      toolCallId: 'tool_restart', attemptId: admitted.attemptId,
      generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test', now: 102,
    });
    writeFileSync(target, content);
    db.close();
    db = openDaemonDb(dbPath);
    engine = createJobEngine({ db });

    expect(engine.recoverExpiredAttempts({
      now: 111, instanceId: 'new', producer: 'restart-recovery', maxCrashes: 3,
    })).toMatchObject([{ decision: 'ask_user' }]);
    const effect = engine.listEffectsRequiringReconciliation(admitted.jobId)[0]!;
    const result = reconcileFilesystemEffectSync(effect);
    expect(result.outcome).toBe('occurred');
    expect(engine.recordEffectReconciliation({
      effectId: effect.effectId,
      expectedJobStateVersion: engine.getJob(admitted.jobId)!.stateVersion,
      ...result,
      producer: 'restart-recovery', idempotencyKey: 'restart-readback', now: 112,
    }).applied).toBe(true);
    expect(engine.listEffectsRequiringReconciliation(admitted.jobId)).toEqual([]);
    expect(JSON.stringify(engine.listEffectReconciliations(effect.effectId))).not.toContain(content);
  });
});
