// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// core/v4/cron/scheduleParser.ts — schedule string → spec.
//
// Three kinds of schedule are recognised, dispatched in order:
//   1. 5-field cron expression  ("0 9 * * *", "*/30 * * * *")
//   2. ISO timestamp / one-shot ("2026-02-03T14:00")
//   3. Interval phrase          ("every 30 minutes", "30m", "hourly")
//
// Cron parsing is delegated to `croner`, which is also used to
// compute next-fire times. The package is small, dependency-free
// and runs in plain Node.

import { Cron } from 'croner'

export type ScheduleSpec =
  | { kind: 'interval'; intervalMs: number;  display: string }
  | { kind: 'cron';     cronExpr:   string;  display: string }
  | { kind: 'oneshot';  runAtIso:   string;  display: string }

const CRON_FIELD = /^[\d*/,\-]+$/

export function parseSchedule(input: string): ScheduleSpec {
  const raw = (input ?? '').trim()
  if (!raw) throw new Error('Empty schedule string')

  const cronSpec = tryParseCron(raw)
  if (cronSpec) return cronSpec

  const onceSpec = tryParseOneshot(raw)
  if (onceSpec) return onceSpec

  return parseInterval(raw)
}

// ── helpers ──────────────────────────────────────────────────────────────────

function tryParseCron(raw: string): ScheduleSpec | null {
  const parts = raw.split(/\s+/)
  if (parts.length !== 5) return null
  if (!parts.every(p => CRON_FIELD.test(p))) return null
  // Let croner validate — it throws on malformed expressions.
  try {
    // Constructing without a callback puts croner in passive mode
    // (no internal timer is armed).
    const c = new Cron(raw)
    const sample = c.nextRun()
    if (!sample) {
      throw new Error(`Cron expression has no future runs: ${raw}`)
    }
    return { kind: 'cron', cronExpr: raw, display: humanizeCron(raw) }
  } catch (err: any) {
    throw new Error(`Invalid cron expression "${raw}": ${err?.message ?? err}`)
  }
}

function tryParseOneshot(raw: string): ScheduleSpec | null {
  // Accept strict ISO date / datetime forms. Pure intervals like "30m" fall
  // through to parseInterval.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(raw)) {
    return null
  }
  const dt = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  if (isNaN(dt.getTime())) return null
  return {
    kind: 'oneshot',
    runAtIso: dt.toISOString(),
    display:  `once at ${dt.toISOString()}`,
  }
}

function parseInterval(raw: string): ScheduleSpec {
  const norm = raw.toLowerCase()

  // "every N <unit>"
  const everyN = norm.match(
    /^every\s+(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days)$/,
  )
  if (everyN) {
    const n  = parseInt(everyN[1], 10)
    const u  = everyN[2].replace(/s$/, '')
    const ms = unitToMs(u, n)
    if (ms != null) return interval(ms, raw)
  }

  // Bareword aliases
  if (norm === 'every minute') return interval(60_000,        raw)
  if (norm === 'hourly')        return interval(3_600_000,    raw)
  if (norm === 'daily')         return interval(86_400_000,   raw)

  // Shorthand "30s" / "5m" / "2h" / "1d"
  const shorthand = norm.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/)
  if (shorthand) {
    const n  = parseInt(shorthand[1], 10)
    const u  = shorthand[2][0]
    const ms = unitToMs(u, n)
    if (ms != null) return interval(ms, raw)
  }

  // Plain numeric ms — escape hatch for tests / power users.
  const num = parseInt(norm, 10)
  if (!isNaN(num) && num > 0 && /^\d+$/.test(norm)) {
    return interval(num, raw)
  }

  throw new Error(
    `Cannot parse schedule "${raw}". Expected:\n` +
    `  cron      — "0 9 * * *", "*/30 * * * *"\n` +
    `  interval  — "every 30 minutes", "30m", "hourly"\n` +
    `  one-shot  — "2026-02-03T14:00"`,
  )
}

function interval(ms: number, raw: string): ScheduleSpec {
  return { kind: 'interval', intervalMs: ms, display: raw }
}

function unitToMs(u: string, n: number): number | null {
  const ch = u[0]
  if (ch === 's') return n * 1_000
  if (ch === 'm') return n * 60_000
  if (ch === 'h') return n * 3_600_000
  if (ch === 'd') return n * 86_400_000
  return null
}

// ── next-fire computation ────────────────────────────────────────────────────

export function nextCronFire(expr: string, from: Date = new Date()): Date | null {
  const c = new Cron(expr)
  return c.nextRun(from) ?? null
}

// Anchor used by computeNextFire — only the fields we actually need.
export interface FireAnchor {
  kind:        'interval' | 'cron' | 'oneshot'
  intervalMs?: number
  cronExpr?:   string
  oneshotIso?: string
  lastRun?:    string
}

// First fire when the job has never run before.
export function computeFirstFire(a: FireAnchor, now: number = Date.now()): Date | null {
  if (a.kind === 'interval' && a.intervalMs) {
    return new Date(now + a.intervalMs)
  }
  if (a.kind === 'cron' && a.cronExpr) {
    return nextCronFire(a.cronExpr, new Date(now))
  }
  if (a.kind === 'oneshot' && a.oneshotIso) {
    return new Date(Math.max(now, new Date(a.oneshotIso).getTime()))
  }
  return null
}

// Anchored next fire — interval kind anchors on lastRun so a process restart
// resumes the cadence. Stale anchors collapse to "now" (fire immediately).
export function computeNextFire(a: FireAnchor, now: number = Date.now()): Date | null {
  if (a.kind === 'interval' && a.intervalMs) {
    if (a.lastRun) {
      const anchored = new Date(a.lastRun).getTime() + a.intervalMs
      return new Date(Math.max(now, anchored))
    }
    return new Date(now + a.intervalMs)
  }
  if (a.kind === 'cron' && a.cronExpr) {
    return nextCronFire(a.cronExpr, new Date(now))
  }
  return null   // oneshot fires once and then auto-disables
}

export function humanizeCron(expr: string): string {
  // Lightweight summariser. We don't depend on cronstrue — for the common
  // patterns the raw expression is the most precise display anyway.
  const parts = expr.split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hr, dom, mon, dow] = parts

  if (mon === '*' && dom === '*' && dow === '*' && /^\d+$/.test(min) && /^\d+$/.test(hr)) {
    return `every day at ${pad(hr)}:${pad(min)}`
  }
  if (mon === '*' && dom === '*' && dow === '*' && hr === '*' && /^\*\/(\d+)$/.test(min)) {
    return `every ${min.replace('*/', '')} minute(s)`
  }
  if (mon === '*' && dom === '*' && dow === '*' && /^\*\/(\d+)$/.test(hr) && min === '0') {
    return `every ${hr.replace('*/', '')} hour(s) on the hour`
  }
  return expr
}

function pad(s: string): string {
  return s.length === 1 ? `0${s}` : s
}
