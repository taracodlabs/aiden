/**
 * v4.11 Slice 1 — frame public-entry tests.
 *
 * Locks the env-var + config resolution order for
 * `isFrameModeRequested()` and the audit pattern for
 * `pauseLegacyIndicator()`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isFrameModeRequested,
  pauseLegacyIndicator,
} from '../../../../cli/v4/frame';

type Globals = typeof globalThis & { __aiden_legacy_indicator_paused?: boolean };

beforeEach(() => {
  delete process.env.AIDEN_RENDERER;
  delete (globalThis as Globals).__aiden_legacy_indicator_paused;
});
afterEach(() => {
  delete process.env.AIDEN_RENDERER;
  delete (globalThis as Globals).__aiden_legacy_indicator_paused;
});

describe('isFrameModeRequested', () => {
  it('returns false when neither env nor config set', () => {
    expect(isFrameModeRequested()).toBe(false);
  });

  it('AIDEN_RENDERER=frame → true', () => {
    process.env.AIDEN_RENDERER = 'frame';
    expect(isFrameModeRequested()).toBe(true);
  });

  it('AIDEN_RENDERER=frame is case-insensitive', () => {
    process.env.AIDEN_RENDERER = 'FRAME';
    expect(isFrameModeRequested()).toBe(true);
  });

  it('AIDEN_RENDERER=legacy → false (env wins over config)', () => {
    process.env.AIDEN_RENDERER = 'legacy';
    expect(isFrameModeRequested({ renderer: 'frame' })).toBe(false);
  });

  it('config { renderer: "frame" } → true when env unset', () => {
    expect(isFrameModeRequested({ renderer: 'frame' })).toBe(true);
  });

  it('config { renderer: "legacy" } → false', () => {
    expect(isFrameModeRequested({ renderer: 'legacy' })).toBe(false);
  });

  it('unknown env value falls back to config', () => {
    process.env.AIDEN_RENDERER = 'sparkle';
    expect(isFrameModeRequested({ renderer: 'frame' })).toBe(true);
  });
});

describe('pauseLegacyIndicator — audited silence path', () => {
  it('sets the global flag while paused; release restores prior value', () => {
    const g = globalThis as Globals;
    expect(g.__aiden_legacy_indicator_paused).toBeFalsy();
    const release = pauseLegacyIndicator();
    expect(g.__aiden_legacy_indicator_paused).toBe(true);
    release();
    expect(g.__aiden_legacy_indicator_paused).toBeFalsy();
  });

  it('nested pauses preserve outer state on inner release', () => {
    const g = globalThis as Globals;
    const release1 = pauseLegacyIndicator();
    const release2 = pauseLegacyIndicator();
    expect(g.__aiden_legacy_indicator_paused).toBe(true);
    release2();
    // Outer pause still active — flag stays true.
    expect(g.__aiden_legacy_indicator_paused).toBe(true);
    release1();
    expect(g.__aiden_legacy_indicator_paused).toBeFalsy();
  });
});
