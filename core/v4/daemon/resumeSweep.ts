/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/resumeSweep.ts — v4.13 Pillar 1, Gap 4.
 *
 * The re-drive. Crash recovery (reclaim.ts) DETECTS dead runs and marks
 * them resume_pending; this sweep is what finally acts on the mark:
 *
 *   for each resume_pending run:
 *     1. LEASE — single-statement compare-and-clear on resume_pending;
 *        exactly one sweep wins per run (double boot-pass = no-op).
 *     2. Load the run's job-card (runs.task_id → tasks row). Runs with
 *        no card (pre-v18, or card write failed) are honestly skipped:
 *        no evidence → no safe revalidation → no blind re-drive.
 *     3. buildResumePlan — REVALIDATE the world against the card.
 *     4. Act on the verdict:
 *        resume    → spend a resume attempt + insert a 'manual' trigger
 *                    event whose payload carries the revalidation
 *                    preamble + original goal + the task linkage. The
 *                    EXISTING dispatcher claims it and runs it through
 *                    the normal lifecycle (budgets, approvals, run row)
 *                    — a fresh conversation seeded from truth, never a
 *                    replay of the dead run's prose.
 *        ask_user  → task parks at blocked_needs_user with the specific
 *                    question on the failureState.
 *        abandon   → honest terminal state with the reason recorded.
 *
 * Boot wiring calls this after crash recovery; `aiden runs resume <id>`
 * calls it scoped to one run.
 */

import { statSync } from 'node:fs';

import type { RunStore } from './runStore';
import type { TaskStore, Task } from './taskStore';
import type { TriggerBus } from './triggerBus';
import {
  buildResumePlan,
  DEFAULT_MAX_RESUMES,
  type FileProbeResult,
} from '../resumePlan';

export interface ResumeSweepDeps {
  runStore:   RunStore;
  taskStore:  TaskStore;
  triggerBus: TriggerBus;
  log?:       (level: 'info' | 'warn', msg: string) => void;
  /** Injected for tests; defaults to a statSync wrapper. */
  fileProbe?: (path: string) => FileProbeResult;
  /** Wake-loop cap override; default AIDEN_RESUME_MAX env or 2. */
  maxResumes?: number;
  /** Scope the sweep to one run (`aiden runs resume <id>`). */
  runId?:     number;
  now?:       () => number;
}

export interface ResumeSweepResult {
  scanned:    number;
  resumed:    number;
  askedUser:  number;
  abandoned:  number;
  skipped:    number;   // no lease won, or no job-card
}

function defaultFileProbe(path: string): FileProbeResult {
  try {
    const st = statSync(path);
    return { exists: true, bytes: st.size };
  } catch {
    return { exists: false };
  }
}

function resolveMaxResumes(override?: number): number {
  if (typeof override === 'number' && override >= 0) return override;
  const env = Number(process.env.AIDEN_RESUME_MAX);
  return Number.isFinite(env) && env >= 0 ? Math.floor(env) : DEFAULT_MAX_RESUMES;
}

/** Minimal envelope for sweep-decided terminal states (no new turn ran). */
function sweepEnvelope(task: Task, verdict: string, now: number) {
  return task.evidence
    ? { ...task.evidence, verdict, decidedAt: now }
    : { v: 1 as const, verdict, decidedAt: now, handles: [], failures: [] };
}

export function sweepResumePending(deps: ResumeSweepDeps): ResumeSweepResult {
  const log = deps.log ?? (() => { /* silent */ });
  const now = deps.now ?? Date.now;
  const fileProbe = deps.fileProbe ?? defaultFileProbe;
  const maxResumes = resolveMaxResumes(deps.maxResumes);
  const result: ResumeSweepResult = { scanned: 0, resumed: 0, askedUser: 0, abandoned: 0, skipped: 0 };

  const pending = deps.runStore.listResumePending()
    .filter((r) => deps.runId === undefined || r.id === deps.runId);

  for (const run of pending) {
    result.scanned += 1;

    // 2 — no job-card → honestly unresumable (evidence-free re-drive is
    // exactly the blind continuation this design forbids).
    const task = run.taskId ? deps.taskStore.get(run.taskId) : null;
    if (!task) {
      if (deps.runStore.claimResumePending(run.id, 'no_task_card')) {
        log('warn', `[resume] run ${run.id}: no job-card — cannot revalidate, not resuming`);
      }
      result.skipped += 1;
      continue;
    }

    // 3 — revalidate BEFORE leasing? No: lease first so plan-building
    // work isn't raced, but the lease reason records the outcome below.
    if (!deps.runStore.claimResumePending(run.id, 'resume_sweep')) {
      result.skipped += 1;   // another sweep won
      continue;
    }

    const plan = buildResumePlan(task, { fileProbe, maxResumes });

    if (plan.verdict === 'abandon') {
      deps.taskStore.finalizeVerification(
        task.id,
        'abandoned',
        sweepEnvelope(task, 'abandoned', now()),
        {
          failureState: {
            class:        'resume_abandoned',
            reason:       plan.reason,
            whatWasTried: task.failureState?.whatWasTried ?? [],
            whenAt:       now(),
          },
        },
      );
      log('warn', `[resume] run ${run.id} task ${task.id}: abandoned — ${plan.reason}`);
      result.abandoned += 1;
      continue;
    }

    if (plan.verdict === 'ask_user') {
      deps.taskStore.finalizeVerification(
        task.id,
        'blocked_needs_user',
        sweepEnvelope(task, 'blocked_needs_user', now()),
        {
          failureState: {
            class:        'needs_user',
            reason:       plan.reason,
            whatWasTried: task.failureState?.whatWasTried ?? [],
            whenAt:       now(),
          },
        },
      );
      log('warn', `[resume] run ${run.id} task ${task.id}: needs user — ${plan.reason}`);
      result.askedUser += 1;
      continue;
    }

    // resume — spend an attempt, then enqueue the fresh-conversation
    // re-drive through the normal dispatcher lifecycle.
    const attempt = deps.taskStore.incrementResumeCount(task.id);
    deps.triggerBus.insert({
      source:         'manual',
      sourceKey:      `resume:${run.id}`,
      idempotencyKey: `resume:${run.id}:${attempt}`,
      payload: {
        resume: {
          prompt:  `${plan.preamble}\n\nContinue the task now.`,
          taskId:  task.id,
          ofRunId: run.id,
          attempt,
        },
      },
    });
    log('info', `[resume] run ${run.id} task ${task.id}: re-driving (attempt ${attempt}/${maxResumes})`);
    result.resumed += 1;
  }

  return result;
}
