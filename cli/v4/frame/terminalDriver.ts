/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 1 — Terminal Driver (the SOLE writer).
 *
 * Invariant: One frame owner. One cursor owner. Semantic events in.
 * Coherent frame out.
 *
 * This module wraps `process.stdout.write` so that while a frame is
 * armed, the ONLY caller permitted to write is the driver itself.
 * Every other caller (legacy display layer, indicator setInterval,
 * stray `console.log`) hits a LOUD throw — by design. The guard is
 * audited code, not a hope.
 *
 * Slice 1 owns the composer phase. Outside that phase (during
 * runAgentTurn handoff), `pause()` is called and the guard
 * disarms — legacy stream/tool/spinner painters resume unmolested.
 * When the turn completes, `resume()` re-arms.
 *
 * The driver itself is allowed to write because it stashes the
 * ORIGINAL bound `process.stdout.write` and routes through it via
 * the `unsafeWrite` exit. The guard inspects the call stack via a
 * single privileged token (`UNSAFE_TOKEN`) so the driver can pass
 * through without disabling the guard for everyone.
 */

type StdoutWrite = typeof process.stdout.write;

/** Symbol passed by the driver itself to bypass the guard. */
const UNSAFE_TOKEN: symbol = Symbol.for('aiden.frame.terminalDriver.unsafeWrite');

interface DriverState {
  /** True while a frame is live and the guard is armed. */
  armed: boolean;
  /** Captured before patching so we can restore on shutdown. */
  originalWrite: StdoutWrite | null;
  /** Tracks how many frames have armed the guard (for nested mounts). */
  armDepth: number;
}

const state: DriverState = {
  armed:         false,
  originalWrite: null,
  armDepth:      0,
};

/**
 * Install the writer-singleton guard. Patches `process.stdout.write`
 * exactly once per process. Subsequent calls are no-ops so multiple
 * REPL incarnations in the same process don't double-wrap.
 */
export function installGuard(): void {
  if (state.originalWrite) return;
  state.originalWrite = process.stdout.write.bind(process.stdout) as StdoutWrite;

  // Replace the write function. The guard inspects the first arg of
  // the call: if it's our token, this is a driver-internal call and
  // bypasses the check.
  process.stdout.write = ((
    chunk: unknown,
    encodingOrCb?: unknown,
    cb?: unknown,
  ): boolean => {
    // Driver bypass: first arg is the token sentinel, second is the
    // real payload. Strip the token and forward.
    if (chunk === UNSAFE_TOKEN) {
      return state.originalWrite!.call(
        process.stdout,
        encodingOrCb as Parameters<StdoutWrite>[0],
        cb as Parameters<StdoutWrite>[1],
      );
    }
    if (state.armed) {
      // Build a focused stack snippet so the throw points the
      // offending caller. We trim the throw site itself plus the
      // node-internal frames.
      const err = new Error(
        '[aiden.frame] Writer-singleton violation — non-driver caller wrote ' +
        'to process.stdout while a frame was armed.\n' +
        'Frame mode owns the screen during the composer phase. Any other ' +
        'painter must pause the frame first (frame.pause()) or wait for ' +
        'unmount.\n' +
        'Offending chunk: ' + JSON.stringify(
          String(chunk).slice(0, 80),
        ),
      );
      // LOUD: re-throw so it's never silently swallowed.
      throw err;
    }
    // Frame not armed — passthrough. Legacy painters work normally.
    return state.originalWrite!.call(
      process.stdout,
      chunk as Parameters<StdoutWrite>[0],
      encodingOrCb as Parameters<StdoutWrite>[1],
      cb as Parameters<StdoutWrite>[2],
    );
  }) as StdoutWrite;
}

/**
 * Arm the guard. Called by a frame as it mounts. Increments armDepth
 * so nested mounts don't disarm prematurely.
 */
export function arm(): void {
  if (!state.originalWrite) {
    throw new Error('[aiden.frame] arm() called before installGuard()');
  }
  state.armDepth++;
  state.armed = true;
}

/**
 * Disarm the guard. Called as a frame unmounts. Only fully disarms
 * when armDepth reaches zero (matches arm()).
 */
export function disarm(): void {
  state.armDepth = Math.max(0, state.armDepth - 1);
  if (state.armDepth === 0) state.armed = false;
}

/** True if the guard is currently rejecting non-driver writes. */
export function isArmed(): boolean {
  return state.armed;
}

/**
 * Driver-internal write. The frame renderer routes here. Bypasses
 * the guard via the token sentinel.
 *
 * In Slice 1 only Ink calls into here — and Ink writes through
 * whichever `stdout` we pass to `render()`. So the driver supplies a
 * shim stream (see `getDriverStream`) that funnels into this fn.
 */
export function unsafeWrite(chunk: string): boolean {
  if (!state.originalWrite) {
    // Guard never installed — fall back to native write. Lets tests
    // and headless harnesses exercise the driver without arming.
    return process.stdout.write(chunk);
  }
  // Pass the token as the first arg; the patched write reads it and
  // routes around the guard.
  return (process.stdout.write as unknown as (
    a: symbol,
    b: string,
  ) => boolean)(UNSAFE_TOKEN, chunk);
}

/**
 * Build a Node-stream-shaped object that Ink can use as its `stdout`.
 * We only implement the surface Ink reaches for (`write`, `columns`,
 * `rows`, event emitter shape). Everything else throws so we notice
 * if Ink starts reaching for new methods.
 */
export interface DriverStream {
  write: (chunk: string) => boolean;
  columns: number;
  rows: number;
  isTTY: boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => DriverStream;
  off: (event: string, listener: (...args: unknown[]) => void) => DriverStream;
  once: (event: string, listener: (...args: unknown[]) => void) => DriverStream;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => DriverStream;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** Make a fresh driver stream. New one per mount keeps Ink isolated. */
export function getDriverStream(): DriverStream {
  const stream: DriverStream = {
    write: (chunk: string) => unsafeWrite(chunk),
    columns: process.stdout.columns ?? 80,
    rows:    process.stdout.rows    ?? 24,
    isTTY:   Boolean(process.stdout.isTTY),
    on()   { return stream; },
    off()  { return stream; },
    once() { return stream; },
    removeListener() { return stream; },
    emit()  { return false; },
  };
  // Re-read columns/rows on every access so a SIGWINCH resize is
  // picked up by Ink's measure pass.
  Object.defineProperty(stream, 'columns', {
    get: () => process.stdout.columns ?? 80,
  });
  Object.defineProperty(stream, 'rows', {
    get: () => process.stdout.rows ?? 24,
  });
  return stream;
}

/**
 * Restore the original write fn. Used in tests + at REPL shutdown to
 * avoid leaving a wrapped stdout around if the user reuses the
 * process.
 */
export function uninstallGuard(): void {
  if (state.originalWrite) {
    process.stdout.write = state.originalWrite;
    state.originalWrite  = null;
    state.armed          = false;
    state.armDepth       = 0;
  }
}
