// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// tests/v4/cron/cronExpression.test.ts — schedule parser:
// cron expressions, intervals, one-shots, error paths.

import { describe, it, expect } from 'vitest'

import {
  parseSchedule, nextCronFire,
} from '../../../core/v4/cron/scheduleParser'

describe('parseSchedule — cron expressions', () => {
  it('parses "0 9 * * *" as a cron schedule', () => {
    const spec = parseSchedule('0 9 * * *')
    expect(spec.kind).toBe('cron')
    if (spec.kind === 'cron') {
      expect(spec.cronExpr).toBe('0 9 * * *')
      expect(spec.display).toMatch(/09:00|0 9 \* \* \*/)
    }
  })

  it('parses "*/30 * * * *" as a cron schedule firing every 30 minutes', () => {
    const spec = parseSchedule('*/30 * * * *')
    expect(spec.kind).toBe('cron')

    const a = nextCronFire('*/30 * * * *', new Date('2026-05-07T10:05:00Z'))!
    const b = nextCronFire('*/30 * * * *', a)!
    const gapMs = b.getTime() - a.getTime()
    expect(gapMs).toBe(30 * 60 * 1000)
  })

  it('rejects malformed cron expressions with a clear error', () => {
    expect(() => parseSchedule('99 99 * * *')).toThrow(/cron|invalid/i)
  })
})

describe('parseSchedule — intervals (regression)', () => {
  it.each([
    ['every 30 minutes', 30 * 60_000],
    ['every 2 hours',    2 * 3_600_000],
    ['every 1 day',      86_400_000],
    ['every minute',     60_000],
    ['hourly',           3_600_000],
    ['daily',            86_400_000],
    ['30m',              30 * 60_000],
    ['2h',               2 * 3_600_000],
    ['1d',               86_400_000],
    ['45s',              45_000],
  ])('"%s" → %i ms', (input, expected) => {
    const spec = parseSchedule(input)
    expect(spec.kind).toBe('interval')
    if (spec.kind === 'interval') {
      expect(spec.intervalMs).toBe(expected)
    }
  })
})

describe('parseSchedule — one-shot ISO timestamps', () => {
  it('parses "2026-12-31T23:59" as a one-shot', () => {
    const spec = parseSchedule('2026-12-31T23:59')
    expect(spec.kind).toBe('oneshot')
    if (spec.kind === 'oneshot') {
      expect(new Date(spec.runAtIso).getUTCFullYear()).toBe(2026)
    }
  })
})

describe('parseSchedule — invalid input', () => {
  it('throws on empty string', () => {
    expect(() => parseSchedule('')).toThrow(/empty/i)
  })
  it('throws on garbage', () => {
    expect(() => parseSchedule('not a real schedule')).toThrow(/cannot parse/i)
  })
})
