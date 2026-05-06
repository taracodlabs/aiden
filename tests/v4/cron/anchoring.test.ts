// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// tests/v4/cron/anchoring.test.ts — drift-free interval scheduling.
// Verifies computeNextFire anchors on lastRun, restarts don't drift,
// and stale anchors collapse to "fire immediately".

import { describe, it, expect } from 'vitest'

import { computeFirstFire, computeNextFire, FireAnchor } from '../../../core/v4/cron/scheduleParser'

const HOUR_MS = 3_600_000

function intervalAnchor(intervalMs: number, lastRun?: string): FireAnchor {
  return { kind: 'interval', intervalMs, lastRun }
}

describe('computeNextFire — interval anchoring', () => {
  it('first fire (no lastRun) = now + interval', () => {
    const now = Date.UTC(2026, 4, 7, 10, 0, 0)
    const next = computeFirstFire(intervalAnchor(HOUR_MS), now)!
    expect(next.getTime()).toBe(now + HOUR_MS)
  })

  it('subsequent fire is anchored on lastRun, not on "now"', () => {
    const now      = Date.UTC(2026, 4, 7, 10, 30, 0)
    const lastRun  = new Date(now - 10 * 60_000).toISOString()  // 10 min ago
    const next     = computeNextFire(intervalAnchor(HOUR_MS, lastRun), now)!
    // Next fire = lastRun + 1h = (now - 10m) + 60m = now + 50m
    expect(next.getTime()).toBe(now + 50 * 60_000)
  })

  it('stale anchor collapses to "now" — fire immediately, no drift accrual', () => {
    const now     = Date.UTC(2026, 4, 7, 14, 0, 0)
    const lastRun = new Date(now - 5 * HOUR_MS).toISOString()    // 5h ago
    const next    = computeNextFire(intervalAnchor(HOUR_MS, lastRun), now)!
    expect(next.getTime()).toBe(now)
  })

  it('does not drift over 5 simulated restarts', () => {
    // Job fires every hour. We simulate 5 restarts at random within-hour
    // offsets and check that each next fire still lands on a multiple of
    // the interval offset from the very first lastRun.
    const t0       = Date.UTC(2026, 4, 7, 10, 0, 0)
    let   lastRun  = new Date(t0).toISOString()

    let anchorMs = t0
    for (let i = 1; i <= 5; i++) {
      // Process restarts at a random offset within the hour.
      const restartNow = anchorMs + Math.floor(Math.random() * (HOUR_MS - 60_000)) + 1
      const next = computeNextFire(intervalAnchor(HOUR_MS, lastRun), restartNow)!
      // Next fire is either (anchor + interval) — preserved — or "now" if
      // restartNow is already past the anchor. Since restartNow < anchor + interval,
      // we expect the anchored value:
      expect(next.getTime()).toBe(anchorMs + HOUR_MS)
      // Simulate the fire happening on schedule and update lastRun.
      anchorMs = next.getTime()
      lastRun  = new Date(anchorMs).toISOString()
    }
    // Five hours after t0, with no drift.
    expect(anchorMs - t0).toBe(5 * HOUR_MS)
  })
})

describe('computeNextFire — non-interval kinds', () => {
  it('cron kind delegates to croner regardless of lastRun (gap-stable)', () => {
    // Use "*/30 * * * *" because the gap between fires is exactly 30
    // minutes regardless of the host timezone — keeps the test
    // deterministic without pinning TZ.
    const now    = Date.UTC(2026, 4, 7, 10, 5, 0)
    const stale  = new Date(now - 25 * HOUR_MS).toISOString()
    const next1  = computeNextFire(
      { kind: 'cron', cronExpr: '*/30 * * * *', lastRun: stale },
      now,
    )!
    const next2  = computeNextFire(
      { kind: 'cron', cronExpr: '*/30 * * * *', lastRun: stale },
      next1.getTime() + 1,
    )!
    expect(next1.getTime()).toBeGreaterThan(now)
    expect(next2.getTime() - next1.getTime()).toBe(30 * 60_000)
  })

  it('oneshot returns null on computeNextFire (one-shots don\'t repeat)', () => {
    const next = computeNextFire(
      { kind: 'oneshot', oneshotIso: '2030-01-01T00:00:00Z' },
      Date.now(),
    )
    expect(next).toBeNull()
  })
})
