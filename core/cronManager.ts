// ============================================================
// Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0.
// ============================================================
//
// core/cronManager.ts — backward-compat shim.
//
// The legacy in-process scheduler this file used to host has been
// replaced by the hardened scheduler at
// `core/v4/cron/cronManager.ts` (Phase v4.1-cron).
// Public function names + parseSchedule are preserved so existing
// importers (notably cli/v4/commands/cron.ts) keep working
// unchanged. The legacy synchronous `loadJobs()` / `createJob()`
// signatures were always followed by a `save()` which itself was
// async-fire-and-forget; the new module is async-end-to-end.
// Callers that previously did `cron.createJob(...)` and assumed
// instant disk persistence now MUST `await` the call.

import {
  loadJobs,
  listJobs,
  listJobsAsync,
  getJob,
  getJobAsync,
  createJob,
  createJobAsync,
  pauseJob,
  pauseJobAsync,
  resumeJob,
  resumeJobAsync,
  deleteJob,
  deleteJobAsync,
  triggerJob,
  parseSchedule,
  awaitPendingSaves,
  __resetForTests,
  AIDEN_CRON_BUILD,
  getDiagnostics,
  startHeartbeat,
  stopHeartbeat,
  isHeartbeatActive,
  type CronJob,
  type CronDiagnostics,
  type CronFireRecord,
  type ScheduleSpec,
} from './v4/cron/cronManager';

export {
  loadJobs,
  listJobs,
  listJobsAsync,
  getJob,
  getJobAsync,
  createJob,
  createJobAsync,
  pauseJob,
  pauseJobAsync,
  resumeJob,
  resumeJobAsync,
  deleteJob,
  deleteJobAsync,
  triggerJob,
  parseSchedule,
  awaitPendingSaves,
  __resetForTests,
  AIDEN_CRON_BUILD,
  getDiagnostics,
  startHeartbeat,
  stopHeartbeat,
  isHeartbeatActive,
};

export type { CronJob, CronDiagnostics, CronFireRecord, ScheduleSpec };

/** Legacy v3 type — kind discriminator was string-only. v4 keeps
 *  it for back-compat. */
export type CronKind = 'interval' | 'cron' | 'oneshot';
