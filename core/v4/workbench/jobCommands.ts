/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import type { JobEngine } from '../daemon/jobEngine';
import type { RunStore } from '../daemon/runStore';
import type { TriggerBus } from '../daemon/triggerBus';

export function createWorkbenchJobCommands(options: {
  db: Db;
  triggerBus: TriggerBus;
  jobEngine: JobEngine;
  runStore: RunStore;
  instanceId: string;
  idFactory?: () => string;
}) {
  const nextId = options.idFactory ?? randomUUID;
  const enqueueTx = options.db.transaction((task: { message: string; sessionId?: string }) => {
    const idempotencyKey = nextId();
    const fingerprint = createHash('sha256').update(task.message).digest('hex');
    const trigger = options.triggerBus.insert({
      source: 'manual', sourceKey: 'workbench-web', idempotencyKey,
      payload: { body: { prompt: task.message, source: 'workbench-web' }, sessionId: task.sessionId },
    });
    const admission = options.jobEngine.submitJob({
      entryPoint: 'workbench', source: 'workbench',
      sessionId: task.sessionId ?? `workbench:${idempotencyKey}`,
      instanceId: options.instanceId,
      idempotencyNamespace: 'workbench-web', idempotencyKey,
      requestFingerprint: fingerprint,
      goal: `Workbench request ${fingerprint.slice(0, 16)}`,
      triggerEventId: trigger.id,
    });
    options.db.prepare('UPDATE trigger_events SET payload_json = ? WHERE id = ?').run(JSON.stringify({
      body: { prompt: task.message, source: 'workbench-web' },
      sessionId: task.sessionId,
      durable_job: {
        job_id: admission.jobId,
        attempt_id: admission.attemptId,
        run_id: admission.runId,
      },
    }), trigger.id);
    return { trigger, admission };
  }).immediate;

  const finalRun = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  return {
    enqueue: {
      enqueue(task: { message: string; sessionId?: string }) {
        const accepted = enqueueTx(task);
        return {
          accepted: true,
          triggerEventId: accepted.trigger.id,
          duplicate: !accepted.trigger.inserted,
          jobId: accepted.admission.jobId,
          attemptId: accepted.admission.attemptId,
          runId: accepted.admission.runId,
        };
      },
    },
    cancel: {
      cancel(runId: number): { accepted: boolean; runId: number; alreadyFinal?: boolean } {
        const run = options.runStore.get(runId);
        if (!run) return { accepted: false, runId };
        if (finalRun.has(String(run.status))) return { accepted: true, runId, alreadyFinal: true };
        if (run.taskId && options.jobEngine.getJob(run.taskId)) {
          const result = options.jobEngine.cancelJob({
            jobId: run.taskId,
            reason: 'stopped from workbench web',
            producer: 'workbench',
            eventIdempotencyKey: `workbench-cancel:${run.taskId}`,
          });
          if (!result.applied && result.conflict === 'terminal_state') {
            return { accepted: true, runId, alreadyFinal: true };
          }
          if (!result.applied && !result.duplicate) return { accepted: false, runId };
          try {
            options.runStore.emitEvent(runId, 'task_cancelled', {
              source: 'workbench-web', reason: 'stopped from dashboard',
            });
          } catch { /* compatibility projection is best-effort */ }
        } else {
          options.runStore.setStatus(runId, 'cancelled', { finishReason: 'stopped from workbench web' });
          options.runStore.emitEvent(runId, 'task_cancelled', {
            source: 'workbench-web', reason: 'stopped from dashboard',
          });
        }
        return { accepted: true, runId };
      },
    },
  };
}
