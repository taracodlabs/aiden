/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — the reusable busy-input ENGINE additions on DuringTurnInput:
 * pause/resume gate, background-handoff intent, steer salvage, persisted
 * initial mode, and the plain-language indicator text. All pure and
 * renderer-agnostic (no stdin, no render, no timers) — the same engine the
 * terminal steering bar and the future dashboard both drive.
 */
import { describe, it, expect } from 'vitest';
import { DuringTurnInput } from '../../../cli/v4/duringTurnInput';

describe('DuringTurnInput — persisted initial mode', () => {
  it('restores a valid persisted mode', () => {
    expect(new DuringTurnInput('redirect').getMode()).toBe('redirect');
    expect(new DuringTurnInput('interrupt').getMode()).toBe('interrupt');
  });
  it('defaults to queue, and coerces a garbage persisted value to queue (never RAISES)', () => {
    expect(new DuringTurnInput().getMode()).toBe('queue');
    expect(new DuringTurnInput('nonsense' as never).getMode()).toBe('queue');
  });
});

describe('DuringTurnInput — pause / resume gate', () => {
  it('requestPause is idempotent; isPaused reflects it', () => {
    const d = new DuringTurnInput();
    expect(d.isPaused()).toBe(false);
    expect(d.requestPause()).toBe(true);
    expect(d.isPaused()).toBe(true);
    expect(d.requestPause()).toBe(false); // already paused
  });

  it('resume returns false when not paused, true when it was', () => {
    const d = new DuringTurnInput();
    expect(d.resume()).toBe(false);
    d.requestPause();
    expect(d.resume()).toBe(true);
    expect(d.isPaused()).toBe(false);
  });

  it('waitWhilePaused resolves IMMEDIATELY when not paused', async () => {
    const d = new DuringTurnInput();
    await expect(d.waitWhilePaused()).resolves.toBeUndefined();
  });

  it('waitWhilePaused BLOCKS while paused and wakes on resume', async () => {
    const d = new DuringTurnInput();
    d.requestPause();
    let resolved = false;
    const p = d.waitWhilePaused().then(() => { resolved = true; });
    await Promise.resolve();               // let microtasks flush
    expect(resolved).toBe(false);          // still frozen
    d.resume();
    await p;
    expect(resolved).toBe(true);
  });

  it('resume wakes MULTIPLE boundary waiters at once', async () => {
    const d = new DuringTurnInput();
    d.requestPause();
    const flags = [false, false, false];
    const ps = flags.map((_, i) => d.waitWhilePaused().then(() => { flags[i] = true; }));
    await Promise.resolve();
    expect(flags).toEqual([false, false, false]);
    d.resume();
    await Promise.all(ps);
    expect(flags).toEqual([true, true, true]);
  });

  it('an abort during a pause unblocks the boundary (Ctrl+C still cancels), pause flag untouched', async () => {
    const d = new DuringTurnInput();
    d.requestPause();
    const ac = new AbortController();
    let resolved = false;
    const p = d.waitWhilePaused(ac.signal).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    ac.abort();
    await p;
    expect(resolved).toBe(true);
    expect(d.isPaused()).toBe(true);        // abort resolves the waiter but does not un-pause
  });

  it('an already-aborted signal resolves immediately even while paused', async () => {
    const d = new DuringTurnInput();
    d.requestPause();
    const ac = new AbortController();
    ac.abort();
    await expect(d.waitWhilePaused(ac.signal)).resolves.toBeUndefined();
  });
});

describe('DuringTurnInput — background handoff intent', () => {
  it('is a one-shot: request → take(true) → take(false)', () => {
    const d = new DuringTurnInput();
    expect(d.hasBackgroundRequest()).toBe(false);
    expect(d.takeBackgroundRequest()).toBe(false);
    d.requestBackground();
    expect(d.hasBackgroundRequest()).toBe(true);
    expect(d.takeBackgroundRequest()).toBe(true);   // consumed
    expect(d.takeBackgroundRequest()).toBe(false);  // and cleared
    expect(d.hasBackgroundRequest()).toBe(false);
  });
});

describe('DuringTurnInput — steer salvage (never silently drop a nudge)', () => {
  it('moves a buffered steer into the queue and returns it', () => {
    const d = new DuringTurnInput();
    d.setPendingSteer('focus on the tests');
    const salvaged = d.salvageSteerToQueue();
    expect(salvaged).toBe('focus on the tests');
    expect(d.peek()).toEqual(['focus on the tests']); // now runs next
    expect(d.hasPendingSteer()).toBe(false);          // drained
  });
  it('accumulated nudges salvage as one queued message', () => {
    const d = new DuringTurnInput();
    d.setPendingSteer('a');
    d.setPendingSteer('b');
    expect(d.salvageSteerToQueue()).toBe('a\nb');
    expect(d.peek()).toEqual(['a\nb']);
  });
  it('returns null and leaves the queue untouched when nothing is pending', () => {
    const d = new DuringTurnInput();
    expect(d.salvageSteerToQueue()).toBeNull();
    expect(d.count()).toBe(0);
  });
});

describe('DuringTurnInput — plain-language indicator (shared with the dashboard)', () => {
  it('enterActionLabel names ONE clear action per mode', () => {
    const d = new DuringTurnInput();
    expect(d.enterActionLabel()).toBe('Enter → queue');
    d.setMode('interrupt');
    expect(d.enterActionLabel()).toBe('Enter → stop turn');
    d.setMode('redirect');
    expect(d.enterActionLabel()).toBe('Enter → steer');
  });
  it('busyHint shows the action + how to switch + how to stop', () => {
    const d = new DuringTurnInput();
    d.setMode('redirect');
    expect(d.busyHint()).toBe('Enter → steer · /busy to change · Ctrl+C stop');
  });
  it('a pause overrides the indicator with a resume hint', () => {
    const d = new DuringTurnInput();
    d.setMode('redirect');
    d.requestPause();
    expect(d.enterActionLabel()).toBe('paused');
    expect(d.busyHint()).toBe('Paused · /resume to continue · Ctrl+C stop');
  });
});
