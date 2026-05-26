/**
 * v4.11 Slice 1 — FrameState reducer purity tests.
 *
 * Confirms the tagged-union reducer transitions are stable and
 * predictable. Slice 1 only ships composer + status lanes; this
 * suite locks the contract before later slices add stream/tools.
 */
import { describe, it, expect } from 'vitest';
import {
  makeInitialState,
  reducer,
  type FrameState,
} from '../../../../cli/v4/frame/state';

const START_TS = 1_700_000_000_000;

function init(prompt = '› '): FrameState {
  return makeInitialState(prompt);
}

describe('FrameState reducer — composer lane', () => {
  it('makeInitialState builds an empty composer at the prompt', () => {
    const s = init('▲ ');
    expect(s.composer).toEqual({ value: '', cursor: 0, prompt: '▲ ' });
    expect(s.status.phase).toBe('idle');
  });

  it('composer/setValue updates value + auto-positions cursor at end', () => {
    const s = reducer(init(), { type: 'composer/setValue', value: 'hi' });
    expect(s.composer.value).toBe('hi');
    expect(s.composer.cursor).toBe(2);
  });

  it('composer/setValue with explicit cursor honours it', () => {
    const s = reducer(init(), { type: 'composer/setValue', value: 'hello', cursor: 2 });
    expect(s.composer.cursor).toBe(2);
  });

  it('composer/setCursor clamps below zero and above length', () => {
    const a = reducer(init(), { type: 'composer/setValue', value: 'abc' });
    const lo = reducer(a, { type: 'composer/setCursor', cursor: -5 });
    expect(lo.composer.cursor).toBe(0);
    const hi = reducer(a, { type: 'composer/setCursor', cursor: 99 });
    expect(hi.composer.cursor).toBe(3);
  });

  it('reducer is pure — never mutates the prior state', () => {
    const a = init();
    const b = reducer(a, { type: 'composer/setValue', value: 'x' });
    expect(a.composer.value).toBe('');
    expect(b).not.toBe(a);
    expect(b.composer).not.toBe(a.composer);
  });
});

describe('FrameState reducer — status lane', () => {
  it('status/markBusy flips phase + records sinceMs + resets elapsed', () => {
    const s = reducer(init(), { type: 'status/markBusy', sinceMs: START_TS });
    expect(s.status.phase).toBe('busy');
    expect(s.status.sinceMs).toBe(START_TS);
    expect(s.status.elapsedS).toBe(0);
  });

  it('status/markBusy with custom verb overrides default', () => {
    const s = reducer(init(), { type: 'status/markBusy', sinceMs: START_TS, verb: 'calling' });
    expect(s.status.verb).toBe('calling');
  });

  it('status/tick advances elapsedS only when busy', () => {
    const idle = reducer(init(), { type: 'status/tick', elapsedS: 5 });
    expect(idle.status.elapsedS).toBe(0);  // ignored while idle
    const busy = reducer(idle, { type: 'status/markBusy', sinceMs: START_TS });
    const tickd = reducer(busy, { type: 'status/tick', elapsedS: 3 });
    expect(tickd.status.elapsedS).toBe(3);
  });

  it('status/reset returns to idle and zeros the counters', () => {
    const busy = reducer(init(), { type: 'status/markBusy', sinceMs: START_TS });
    const reset = reducer(busy, { type: 'status/reset' });
    expect(reset.status.phase).toBe('idle');
    expect(reset.status.sinceMs).toBeNull();
    expect(reset.status.elapsedS).toBe(0);
  });

  it('unknown action returns the same reference (no-op)', () => {
    const a = init();
    // @ts-expect-error — testing the default branch
    const b = reducer(a, { type: 'unknown' });
    expect(b).toBe(a);
  });
});
