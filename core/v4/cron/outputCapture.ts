// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// core/v4/cron/outputCapture.ts — per-run log + 4 KB summary.
//
// Every fire of a cron job appends a STARTED / output / DONE
// block to ~/.aiden/cron-logs/<job-id>.log and returns a
// truncated summary suitable for embedding in cron_jobs.json.

import * as fsp  from 'fs/promises'
import * as path from 'path'

export const OUTPUT_TRUNCATE_BYTES = 4 * 1024
const TRUNCATE_SUFFIX = '\n... [truncated]'

export type RunResult = 'ok' | 'fail'

export interface CaptureOutcome {
  result:           RunResult
  output:           string  // truncated to 4 KB
  fullOutputBytes:  number
  durationMs:       number
  startedAt:        string
  finishedAt:       string
  logPath:          string
}

export interface CaptureSource {
  output:  string
  failed?: boolean
}

export async function captureRun(
  jobId:     string,
  jobName:   string,
  logsDir:   string,
  exec:      () => Promise<CaptureSource>,
): Promise<CaptureOutcome> {
  await fsp.mkdir(logsDir, { recursive: true })
  const logPath   = path.join(logsDir, `${jobId}.log`)
  const startedAt = new Date().toISOString()
  const t0        = Date.now()

  let raw:    string = ''
  let failed: boolean = false

  try {
    const r = await exec()
    raw    = r.output ?? ''
    failed = Boolean(r.failed)
  } catch (e: any) {
    failed = true
    raw    = e?.stack ?? e?.message ?? String(e)
  }

  const durationMs = Date.now() - t0
  const finishedAt = new Date().toISOString()
  const result: RunResult = failed ? 'fail' : 'ok'

  const block =
    `[${startedAt}] STARTED ${jobName}\n` +
    `${raw}${raw.endsWith('\n') ? '' : '\n'}` +
    `[${finishedAt}] DONE ${result} (${durationMs}ms)\n`

  try {
    await fsp.appendFile(logPath, block, { mode: 0o600 })
  } catch {
    // Logging failure must never break the run; the in-memory summary
    // returned below is still authoritative for cron_jobs.json.
  }

  return {
    result,
    output:          truncateBytes(raw, OUTPUT_TRUNCATE_BYTES),
    fullOutputBytes: Buffer.byteLength(raw, 'utf8'),
    durationMs,
    startedAt,
    finishedAt,
    logPath,
  }
}

export function truncateBytes(s: string, max: number): string {
  if (!s) return s
  const buf = Buffer.from(s, 'utf8')
  if (buf.byteLength <= max) return s
  // Cut on a UTF-8 boundary so we never emit a half-character. Slicing the
  // buffer and decoding with the replacement-fatal flag handles that for us.
  const room  = Math.max(0, max - Buffer.byteLength(TRUNCATE_SUFFIX, 'utf8'))
  const head  = buf.subarray(0, room)
  const text  = head.toString('utf8').replace(/�+$/, '')  // drop trailing replacement chars
  return text + TRUNCATE_SUFFIX
}
