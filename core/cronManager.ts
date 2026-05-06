// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// core/cronManager.ts — scheduled task engine.
//
// Public API (kept stable): createJob, listJobs, getJob,
// pauseJob, resumeJob, deleteJob, triggerJob, parseSchedule,
// loadJobs.
//
// Capabilities:
//   - "every N minutes/hours/days", "hourly", "daily", "30m"
//   - 5-field cron expressions ("0 9 * * *", "*/30 * * * *")
//   - One-shot ISO timestamps ("2026-02-03T14:00")
// Persistence:
//   - ~/.aiden/cron_jobs.json — atomic temp-then-rename + fsync,
//     guarded by a per-path mutex. cron_jobs.json never observed
//     in a half-written state, even if the process is killed
//     mid-write.
// Scheduling:
//   - lastRun-anchored chained setTimeout (no setInterval drift).
//     Each fire schedules the next from `lastRun + intervalMs`,
//     so a process restart resumes the cadence from where it
//     left off. Stale anchors (lastRun + interval < now) fire
//     immediately, then the regular cadence resumes.
// Per-run logs:
//   - ~/.aiden/cron-logs/<job-id>.log gets a full STARTED /
//     output / DONE block per fire. cron_jobs.json carries a
//     4 KB summary on the job record.

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'

import { writeJsonAtomic }                     from './v4/cron/atomicWrite'
import {
  parseSchedule, ScheduleSpec,
  computeFirstFire, computeNextFire,
} from './v4/cron/scheduleParser'
import { captureRun, RunResult }               from './v4/cron/outputCapture'

// ── Types ─────────────────────────────────────────────────────────────────────

export type CronKind = 'interval' | 'cron' | 'oneshot'

export interface CronJob {
  id:           string
  description:  string
  schedule:     string          // human/canonical display string
  kind:         CronKind
  intervalMs?:  number          // when kind === 'interval'
  cronExpr?:    string          // when kind === 'cron'
  oneshotIso?:  string          // when kind === 'oneshot'
  action:       string          // shell command to execute
  enabled:      boolean
  createdAt:    string
  lastRun?:     string
  lastResult?:  RunResult
  lastOutput?:  string          // truncated to 4 KB
  nextRun?:     string
  runCount:     number
}

// ── State ─────────────────────────────────────────────────────────────────────

const jobs:    Map<string, CronJob>                       = new Map()
const timers:  Map<string, ReturnType<typeof setTimeout>> = new Map()
let   jobSeq                                              = 1
let   pendingSave: Promise<void>                          = Promise.resolve()

const DATA_DIR  = path.join(os.homedir(), '.aiden')
const DATA_FILE = path.join(DATA_DIR, 'cron_jobs.json')
const LOGS_DIR  = path.join(DATA_DIR, 'cron-logs')

// Re-export so callers can keep `import { parseSchedule } from './cronManager'`.
export { parseSchedule } from './v4/cron/scheduleParser'

// ── Persistence ───────────────────────────────────────────────────────────────

function save(): void {
  // Fire-and-forget, but chain off the previous save so writes serialise.
  pendingSave = pendingSave.catch(() => undefined).then(() =>
    writeJsonAtomic(DATA_FILE, Array.from(jobs.values())),
  )
}

// Test/shutdown hook — drain any queued writes.
export async function awaitPendingSaves(): Promise<void> {
  await pendingSave
}

export function loadJobs(): void {
  try {
    if (!fs.existsSync(DATA_FILE)) return
    const data: unknown = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    if (!Array.isArray(data)) return
    for (const raw of data) {
      const job = migrateJob(raw)
      if (!job) continue
      jobs.set(job.id, job)
      const num = parseInt(job.id, 10)
      if (!isNaN(num) && num >= jobSeq) jobSeq = num + 1
      if (job.enabled) _scheduleJob(job)
    }
  } catch { /* corrupt file → start with empty registry */ }
}

function migrateJob(raw: any): CronJob | null {
  if (!raw || typeof raw !== 'object' || !raw.id) return null
  // Old shape (pre-Phase-24.1) had no `kind`; everything was an interval.
  if (!raw.kind) {
    raw.kind = raw.cronExpr ? 'cron'
             : raw.oneshotIso ? 'oneshot'
             : 'interval'
  }
  return raw as CronJob
}

// ── Scheduling ────────────────────────────────────────────────────────────────

function _scheduleJob(job: CronJob): void {
  if (timers.has(job.id)) return  // already armed
  if (!job.enabled) return

  const target = computeNextFire(job)
  if (!target) {
    // Nothing to fire (e.g. completed one-shot). Make sure no stale timer.
    return
  }

  const delay = Math.max(0, target.getTime() - Date.now())
  job.nextRun = new Date(Date.now() + delay).toISOString()
  jobs.set(job.id, { ...job })
  save()

  const handle = setTimeout(async () => {
    timers.delete(job.id)
    try {
      await _fireJob(job.id)
    } catch { /* errors already captured into the run log */ }

    const fresh = jobs.get(job.id)
    if (!fresh) return
    if (fresh.kind === 'oneshot') {
      fresh.enabled = false
      jobs.set(fresh.id, { ...fresh })
      save()
      return
    }
    if (fresh.enabled) _scheduleJob(fresh)
  }, delay)

  if (typeof (handle as any).unref === 'function') (handle as any).unref()
  timers.set(job.id, handle)
}

async function _fireJob(id: string): Promise<void> {
  const job = jobs.get(id)
  if (!job) return

  const startedMs = Date.now()
  const cap = await captureRun(
    job.id,
    job.description || job.id,
    LOGS_DIR,
    async () => {
      try {
        const { executeTool } = await import('./toolRegistry')
        const r = await executeTool('shell_exec', { command: job.action }, 0)
        const text   = typeof r === 'string' ? r : ((r as any)?.output ?? JSON.stringify(r))
        const failed = (r as any)?.success === false
        return { output: String(text ?? ''), failed }
      } catch (e: any) {
        return { output: e?.stack ?? e?.message ?? String(e), failed: true }
      }
    },
  )

  const fresh = jobs.get(id)
  if (!fresh) return
  fresh.lastRun    = new Date(startedMs).toISOString()
  fresh.lastResult = cap.result
  fresh.lastOutput = cap.output
  fresh.runCount   = (fresh.runCount ?? 0) + 1
  jobs.set(fresh.id, { ...fresh })
  save()
}

function clearTimer(id: string): void {
  const h = timers.get(id)
  if (h) { clearTimeout(h); timers.delete(id) }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function createJob(
  description: string,
  schedule:    string,
  action:      string,
): CronJob {
  const spec = parseSchedule(schedule)
  const id   = String(jobSeq++)

  const job: CronJob = {
    id,
    description,
    schedule:   spec.display,
    kind:       spec.kind,
    action,
    enabled:    true,
    createdAt:  new Date().toISOString(),
    runCount:   0,
    ...attachKindFields(spec),
  }

  const first = computeFirstFire(job)
  if (first) job.nextRun = first.toISOString()

  jobs.set(id, job)
  _scheduleJob(job)
  save()
  return job
}

function attachKindFields(spec: ScheduleSpec): Partial<CronJob> {
  if (spec.kind === 'interval') return { intervalMs: spec.intervalMs }
  if (spec.kind === 'cron')     return { cronExpr:   spec.cronExpr   }
  return                              { oneshotIso: spec.runAtIso   }
}

export function listJobs(): CronJob[] {
  return Array.from(jobs.values())
}

export function getJob(id: string): CronJob | undefined {
  return jobs.get(id)
}

export function pauseJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  job.enabled = false
  clearTimer(id)
  jobs.set(id, { ...job })
  save()
  return true
}

export function resumeJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  job.enabled = true
  jobs.set(id, { ...job })
  _scheduleJob(job)
  save()
  return true
}

export function deleteJob(id: string): boolean {
  if (!jobs.has(id)) return false
  clearTimer(id)
  jobs.delete(id)
  save()
  return true
}

export async function triggerJob(id: string): Promise<boolean> {
  const job = jobs.get(id)
  if (!job) return false
  // A manual trigger should not double-fire alongside a pending timer; we
  // cancel and re-arm after the run so the cadence anchors on the fresh
  // lastRun set by _fireJob.
  clearTimer(id)
  await _fireJob(id)
  const fresh = jobs.get(id)
  if (fresh && fresh.enabled && fresh.kind !== 'oneshot') _scheduleJob(fresh)
  if (fresh && fresh.kind === 'oneshot') {
    fresh.enabled = false
    jobs.set(fresh.id, { ...fresh })
    save()
  }
  return true
}

// ── Test hook ─────────────────────────────────────────────────────────────────
//
// Tests need to reset module state between cases. Production code never
// reaches for this — it lives behind a name that signals "for tests" so
// nobody depends on it accidentally.

export function __resetForTests(): void {
  for (const id of timers.keys()) clearTimer(id)
  jobs.clear()
  jobSeq = 1
  pendingSave = Promise.resolve()
}
