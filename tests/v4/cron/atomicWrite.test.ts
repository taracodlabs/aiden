// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// tests/v4/cron/atomicWrite.test.ts — verify writeJsonAtomic
// keeps the destination file consistent across crashes and
// concurrent writers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs   from 'fs'
import * as fsp  from 'fs/promises'
import * as path from 'path'
import * as os   from 'os'

import { writeJsonAtomic, awaitAllPending } from '../../../core/v4/cron/atomicWrite'

let tmpDir:  string
let target:  string

beforeEach(async () => {
  tmpDir  = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiden-cron-aw-'))
  target  = path.join(tmpDir, 'cron.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('writes JSON to disk in valid form', async () => {
    await writeJsonAtomic(target, { jobs: [{ id: '1' }, { id: '2' }] })
    const text = await fsp.readFile(target, 'utf8')
    expect(JSON.parse(text)).toEqual({ jobs: [{ id: '1' }, { id: '2' }] })
  })

  it('leaves no orphan tmp file and does not corrupt the destination when rename fails', async () => {
    // Seed an existing valid file at `target` first.
    await fsp.writeFile(target, JSON.stringify({ marker: 'ORIGINAL' }), 'utf8')

    // Make the destination a sibling that points at a directory — fs.rename
    // refuses to overwrite a directory with a file, on every platform we
    // ship to. This exercises the same error path as a mid-write crash
    // without needing to monkey-patch ESM exports.
    const dirAsTarget = path.join(tmpDir, 'should-fail')
    await fsp.mkdir(dirAsTarget)

    await expect(
      writeJsonAtomic(dirAsTarget, { marker: 'NEW' }),
    ).rejects.toThrow()

    // The original file beside it is untouched.
    const after = JSON.parse(await fsp.readFile(target, 'utf8'))
    expect(after).toEqual({ marker: 'ORIGINAL' })

    // No orphan tmp files remain in the destination directory.
    const leftovers = (await fsp.readdir(tmpDir))
      .filter(n => n.startsWith('.') && n.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('serialises concurrent writes (final state is one of the inputs, never garbage)', async () => {
    const writes = Array.from({ length: 12 }, (_, i) =>
      writeJsonAtomic(target, { seq: i }))

    await Promise.all(writes)
    await awaitAllPending()

    const final = JSON.parse(await fsp.readFile(target, 'utf8'))
    expect(typeof final.seq).toBe('number')
    expect(final.seq).toBeGreaterThanOrEqual(0)
    expect(final.seq).toBeLessThan(12)
  })

  it('creates the destination directory if it does not yet exist', async () => {
    const nested = path.join(tmpDir, 'sub', 'cron_jobs.json')
    await writeJsonAtomic(nested, [])
    expect(fs.existsSync(nested)).toBe(true)
  })
})
