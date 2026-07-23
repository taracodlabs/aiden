/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import { createActionAuthority, type ActionAuthority } from '../actionAuthority';
import type { JobEngine } from '../daemon/jobEngine';
import { createJobControlAuthority, type JobControlAuthority } from '../daemon/jobControlAuthority';
import type { RunStore } from '../daemon/runStore';
import type { TriggerBus } from '../daemon/triggerBus';

export function createWorkbenchJobCommands(options: {
  db: Db;
  triggerBus: TriggerBus;
  jobEngine: JobEngine;
  runStore: RunStore;
  instanceId: string;
  controlAuthority?: JobControlAuthority;
  actionAuthority?: ActionAuthority;
  idFactory?: () => string;
}) {
  const controlAuthority = options.controlAuthority ?? createJobControlAuthority({ db: options.db, jobEngine: options.jobEngine });
  const actionAuthority = options.actionAuthority ?? createActionAuthority({ db: options.db, jobEngine: options.jobEngine });
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
  const activeTarget = (runId: number) => {
    const run = options.runStore.get(runId);
    if (!run?.taskId) return null;
    const job = options.jobEngine.getJob(run.taskId);
    const attempt = job?.activeAttemptId ? options.jobEngine.getAttempt(job.activeAttemptId) : null;
    if (!job || !attempt) return null;
    return { run, job, attempt };
  };
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
          const attempt = options.jobEngine.getAttempt(options.jobEngine.getJob(run.taskId)?.activeAttemptId ?? '');
          const result = controlAuthority.commands.request({
            jobId: run.taskId,
            attemptId: attempt?.id,
            generation: attempt?.generation,
            kind: 'cancel',
            reason: 'stopped from workbench web',
            source: 'workbench',
            idempotencyNamespace: 'workbench-control',
            idempotencyKey: `cancel:${run.taskId}`,
          });
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
    input: {
      receive(runId: number, content: string, idempotencyKey = nextId()) {
        const target = activeTarget(runId);
        if (!target) return { accepted: false, runId };
        const received = controlAuthority.inputs.receive({
          jobId: target.job.id,
          targetAttemptId: target.attempt.id,
          targetGeneration: target.attempt.generation,
          sessionId: target.run.sessionId ?? `workbench:${target.job.id}`,
          channelId: 'workbench',
          source: 'workbench',
          kind: 'message',
          content,
          idempotencyNamespace: 'workbench-input',
          idempotencyKey,
        });
        return {
          accepted: true,
          runId,
          jobId: target.job.id,
          attemptId: target.attempt.id,
          inputId: received.record.inputId,
          duplicate: received.duplicate,
        };
      },
    },
    control: {
      pause(runId: number, idempotencyKey = nextId()) {
        const target = activeTarget(runId);
        if (!target) return { accepted: false, applied: false, runId };
        const result = controlAuthority.commands.request({
          jobId: target.job.id,
          attemptId: target.attempt.id,
          generation: target.attempt.generation,
          kind: 'pause',
          source: 'workbench',
          reason: 'paused from workbench',
          idempotencyNamespace: 'workbench-control',
          idempotencyKey,
        });
        return { accepted: true, applied: result.applied, runId, controlId: result.controlId };
      },
      applyPauseBoundary(runId: number) {
        const run = options.runStore.get(runId);
        if (!run?.taskId) return { accepted: false, applied: false };
        const result = controlAuthority.commands.applyPendingAtBoundary({ jobId: run.taskId });
        return { accepted: true, applied: result.applied };
      },
      resume(runId: number, idempotencyKey = nextId()) {
        const run = options.runStore.get(runId);
        if (!run?.taskId) return { accepted: false, runId };
        const resumed = controlAuthority.commands.resume({
          jobId: run.taskId,
          source: 'workbench',
          instanceId: options.instanceId,
          idempotencyNamespace: 'workbench-control',
          idempotencyKey,
        });
        const job = options.jobEngine.getJob(run.taskId)!;
        const trigger = options.triggerBus.insert({
          source: 'manual',
          sourceKey: `workbench-resume:${run.taskId}`,
          idempotencyKey: `resume:${idempotencyKey}`,
          payload: {
            body: { prompt: job.goal, source: 'workbench-resume' },
            sessionId: job.sessionId,
            durable_job: {
              job_id: job.id,
              attempt_id: resumed.attemptId,
              run_id: resumed.runId,
            },
          },
        });
        options.db.prepare('UPDATE runs SET trigger_event_id = ? WHERE attempt_id = ?')
          .run(trigger.id, resumed.attemptId);
        return { accepted: true, runId, triggerEventId: trigger.id, ...resumed };
      },
    },
    approval: {
      decide(approvalId: string, decision: 'approved' | 'denied' | 'cancelled') {
        const record = actionAuthority.get(approvalId);
        if (!record) return { accepted: false, approvalId };
        const decided = actionAuthority.decide({
          approvalId,
          jobId: record.jobId,
          attemptId: record.attemptId,
          generation: record.generation,
          actionDigest: record.actionDigest,
          policySnapshotId: record.policySnapshotId,
          decision,
          decidedBy: 'user',
          decisionChannel: 'workbench',
        });
        return { accepted: true, approvalId, state: decided.state };
      },
    },
  };
}
