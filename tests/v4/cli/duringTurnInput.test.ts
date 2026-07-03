/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 4 Slice 2a — the during-turn input controller (queue + mode).
 */
import { describe, it, expect } from 'vitest';
import { DuringTurnInput, isBusyEnterMode } from '../../../cli/v4/duringTurnInput';

describe('DuringTurnInput — queue', () => {
  it('enqueue/dequeue is FIFO; empty/whitespace ignored', () => {
    const c = new DuringTurnInput();
    expect(c.enqueue('first')).toBe(1);
    expect(c.enqueue('   ')).toBe(1);      // whitespace ignored, count unchanged
    expect(c.enqueue('second')).toBe(2);
    expect(c.count()).toBe(2);
    expect(c.dequeue()).toBe('first');
    expect(c.dequeue()).toBe('second');
    expect(c.dequeue()).toBeNull();
  });

  it('enqueue trims; peek is a copy; clear empties + returns count', () => {
    const c = new DuringTurnInput();
    c.enqueue('  padded  ');
    expect(c.peek()).toEqual(['padded']);
    const copy = c.peek(); copy.push('mutated');
    expect(c.count()).toBe(1);             // peek copy didn't mutate internal
    expect(c.clear()).toBe(1);
    expect(c.count()).toBe(0);
    expect(c.clear()).toBe(0);
  });
});

describe('DuringTurnInput — mode + onBusyEnter', () => {
  it('default mode is queue', () => {
    expect(new DuringTurnInput().getMode()).toBe('queue');
  });

  it('queue mode: Enter appends and reports the new count', () => {
    const c = new DuringTurnInput();
    expect(c.onBusyEnter('hello')).toEqual({ action: 'queued', count: 1, text: 'hello' });
    expect(c.onBusyEnter('world')).toEqual({ action: 'queued', count: 2, text: 'world' });
    expect(c.count()).toBe(2);
  });

  it('interrupt mode: Enter signals interrupt and does NOT queue', () => {
    const c = new DuringTurnInput();
    c.setMode('interrupt');
    expect(c.onBusyEnter('cancel please')).toEqual({ action: 'interrupt' });
    expect(c.count()).toBe(0);
  });

  it('empty Enter is ignored in either mode', () => {
    const c = new DuringTurnInput();
    expect(c.onBusyEnter('   ')).toEqual({ action: 'ignored' });
    c.setMode('interrupt');
    expect(c.onBusyEnter('')).toEqual({ action: 'ignored' });
  });

  it('isBusyEnterMode guards input', () => {
    expect(isBusyEnterMode('queue')).toBe(true);
    expect(isBusyEnterMode('interrupt')).toBe(true);
    expect(isBusyEnterMode('redirect')).toBe(true); // Slice 2b
    expect(isBusyEnterMode('x')).toBe(false);
  });
});

describe('DuringTurnInput — redirect (Slice 2b)', () => {
  it('redirect mode: Enter buffers a nudge (does not queue, does not interrupt)', () => {
    const c = new DuringTurnInput();
    c.setMode('redirect');
    expect(c.onBusyEnter('use pnpm not npm')).toEqual({ action: 'steered', text: 'use pnpm not npm' });
    expect(c.count()).toBe(0);                       // not queued
    expect(c.hasPendingSteer()).toBe(true);
  });

  it('multiple nudges accumulate (newline-joined); drainSteer takes + clears', () => {
    const c = new DuringTurnInput();
    c.setMode('redirect');
    c.onBusyEnter('use pnpm');
    c.onBusyEnter('skip the tests');
    expect(c.drainSteer()).toBe('use pnpm\nskip the tests');
    expect(c.drainSteer()).toBeNull();               // cleared after drain
    expect(c.hasPendingSteer()).toBe(false);
  });

  it('clearSteer drops a pending nudge WITHOUT injecting (interrupt supersedes)', () => {
    const c = new DuringTurnInput();
    c.setPendingSteer('stale nudge');
    expect(c.clearSteer()).toBe(true);
    expect(c.drainSteer()).toBeNull();               // nothing leaks forward
    expect(c.clearSteer()).toBe(false);              // nothing to clear now
  });

  it('QUEUE and REDIRECT are independent — they do not interfere', () => {
    const c = new DuringTurnInput();
    c.enqueue('run after turn');                      // queued
    c.setPendingSteer('adjust mid-turn');             // steer
    // draining the steer leaves the queue intact...
    expect(c.drainSteer()).toBe('adjust mid-turn');
    expect(c.count()).toBe(1);
    // ...and dequeuing leaves no steer resurrected.
    expect(c.dequeue()).toBe('run after turn');
    expect(c.hasPendingSteer()).toBe(false);
  });
});
