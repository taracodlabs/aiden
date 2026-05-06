// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// tests/v4/cron/outputCapture.test.ts — captureRun writes a
// STARTED/output/DONE block per fire and returns a 4 KB summary.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fsp  from 'fs/promises'
import * as path from 'path'
import * as os   from 'os'

import {
  captureRun, truncateBytes, OUTPUT_TRUNCATE_BYTES,
} from '../../../core/v4/cron/outputCapture'

let tmpDir:  string
let logsDir: string

beforeEach(async () => {
  tmpDir  = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiden-cron-oc-'))
  logsDir = path.join(tmpDir, 'cron-logs')
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('captureRun', () => {
  it('records STARTED + output + DONE ok for a successful run', async () => {
    const out = await captureRun('job-a', 'hello-job', logsDir, async () => ({
      output: 'first line\nsecond line',
      failed: false,
    }))

    expect(out.result).toBe('ok')
    expect(out.output).toContain('first line')

    const log = await fsp.readFile(path.join(logsDir, 'job-a.log'), 'utf8')
    expect(log).toMatch(/\[.+\] STARTED hello-job/)
    expect(log).toContain('first line')
    expect(log).toContain('second line')
    expect(log).toMatch(/\[.+\] DONE ok \(\d+ms\)/)
  })

  it('records DONE fail when the exec returns failed=true', async () => {
    const out = await captureRun('job-b', 'shell-fail', logsDir, async () => ({
      output: 'command not found: xyz',
      failed: true,
    }))

    expect(out.result).toBe('fail')
    const log = await fsp.readFile(path.join(logsDir, 'job-b.log'), 'utf8')
    expect(log).toMatch(/DONE fail/)
    expect(log).toContain('command not found: xyz')
  })

  it('records DONE fail when the exec throws', async () => {
    const out = await captureRun('job-c', 'thrower', logsDir, async () => {
      throw new Error('boom')
    })

    expect(out.result).toBe('fail')
    expect(out.output).toContain('boom')
    const log = await fsp.readFile(path.join(logsDir, 'job-c.log'), 'utf8')
    expect(log).toMatch(/DONE fail/)
  })

  it('truncates the returned summary at 4 KB but keeps full output in the log', async () => {
    const big = 'X'.repeat(OUTPUT_TRUNCATE_BYTES * 2)   // 8 KB
    const out = await captureRun('job-d', 'big-output', logsDir, async () => ({
      output: big,
      failed: false,
    }))

    // Summary truncated.
    expect(Buffer.byteLength(out.output, 'utf8')).toBeLessThanOrEqual(OUTPUT_TRUNCATE_BYTES)
    expect(out.output.endsWith('[truncated]')).toBe(true)
    expect(out.fullOutputBytes).toBe(OUTPUT_TRUNCATE_BYTES * 2)

    // Log file complete.
    const log = await fsp.readFile(path.join(logsDir, 'job-d.log'), 'utf8')
    const xCount = (log.match(/X/g) ?? []).length
    expect(xCount).toBe(OUTPUT_TRUNCATE_BYTES * 2)
  })

  it('appends — does not overwrite — across multiple captures of the same job', async () => {
    await captureRun('job-e', 'first', logsDir, async () => ({ output: 'one', failed: false }))
    await captureRun('job-e', 'first', logsDir, async () => ({ output: 'two', failed: false }))
    const log = await fsp.readFile(path.join(logsDir, 'job-e.log'), 'utf8')
    expect(log).toContain('one')
    expect(log).toContain('two')
    // Two STARTED markers.
    expect((log.match(/STARTED/g) ?? []).length).toBe(2)
  })
})

describe('truncateBytes', () => {
  it('returns the input unchanged when it fits', () => {
    expect(truncateBytes('hello', 32)).toBe('hello')
  })
  it('cuts on a UTF-8 boundary and appends a marker', () => {
    const s = '😀'.repeat(2000)
    const r = truncateBytes(s, 64)
    expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(64)
    expect(r.endsWith('[truncated]')).toBe(true)
    // No replacement chars.
    expect(r.includes('�')).toBe(false)
  })
})
