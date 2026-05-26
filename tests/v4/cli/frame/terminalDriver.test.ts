/**
 * v4.11 Slice 1 — terminalDriver writer-singleton guard tests.
 *
 * Verifies the LOUD-throw contract: while a frame is armed, any
 * non-driver write to process.stdout MUST throw. The driver itself
 * (via unsafeWrite) bypasses cleanly. disarm restores passthrough.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installGuard,
  uninstallGuard,
  arm,
  disarm,
  isArmed,
  unsafeWrite,
  getDriverStream,
} from '../../../../cli/v4/frame/terminalDriver';

beforeEach(() => {
  installGuard();
});
afterEach(() => {
  // Always disarm/uninstall — otherwise a failed assertion leaves
  // process.stdout patched and breaks downstream tests.
  while (isArmed()) disarm();
  uninstallGuard();
});

describe('terminalDriver — guard semantics', () => {
  it('installGuard is idempotent (second call is a no-op)', () => {
    installGuard();
    installGuard();
    // No throw, no behaviour change.
    expect(isArmed()).toBe(false);
  });

  it('passthrough writes work while disarmed', () => {
    // We cannot easily intercept process.stdout's underlying write
    // here, but we can at least confirm no throw.
    expect(() => process.stdout.write('')).not.toThrow();
  });

  it('non-driver write throws LOUDLY while armed', () => {
    arm();
    expect(isArmed()).toBe(true);
    expect(() => process.stdout.write('hello')).toThrow(/Writer-singleton violation/);
  });

  it('error message includes the offending chunk prefix', () => {
    arm();
    let caught: Error | null = null;
    try { process.stdout.write('secret-payload-xyz'); } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('secret-payload-xyz');
  });

  it('disarm restores passthrough', () => {
    arm();
    expect(() => process.stdout.write('x')).toThrow();
    disarm();
    expect(isArmed()).toBe(false);
    expect(() => process.stdout.write('')).not.toThrow();
  });

  it('arm depth nests — disarm only fully clears at depth zero', () => {
    arm();
    arm();
    expect(isArmed()).toBe(true);
    disarm();
    expect(isArmed()).toBe(true);  // still armed (depth = 1)
    disarm();
    expect(isArmed()).toBe(false); // now clear
  });

  it('disarm floors at zero (extra calls are safe)', () => {
    disarm();
    disarm();
    expect(isArmed()).toBe(false);
  });

  it('unsafeWrite bypasses the guard while armed', () => {
    arm();
    // No assertion on output stream content — just that the call
    // does NOT throw. unsafeWrite passes the token sentinel, which
    // the patched write recognises and routes around the guard.
    expect(() => unsafeWrite('')).not.toThrow();
  });
});

describe('terminalDriver — DriverStream shape', () => {
  it('provides write + dimensions + isTTY for Ink', () => {
    const s = getDriverStream();
    expect(typeof s.write).toBe('function');
    expect(typeof s.columns).toBe('number');
    expect(typeof s.rows).toBe('number');
    expect(typeof s.isTTY).toBe('boolean');
  });

  it('write routes through unsafeWrite (no throw while armed)', () => {
    arm();
    const s = getDriverStream();
    expect(() => s.write('frame-content')).not.toThrow();
  });

  it('columns + rows reflect live process.stdout dimensions', () => {
    const s = getDriverStream();
    // Just confirm they're integers in a reasonable range. The
    // getter re-reads process.stdout each time.
    expect(Number.isInteger(s.columns)).toBe(true);
    expect(s.columns).toBeGreaterThan(0);
  });
});

describe('terminalDriver — uninstall safety', () => {
  it('uninstallGuard restores native write + disarms', () => {
    arm();
    expect(isArmed()).toBe(true);
    uninstallGuard();
    expect(isArmed()).toBe(false);
    expect(() => process.stdout.write('')).not.toThrow();
  });
});
