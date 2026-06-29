/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 1 — Frame module public entry.
 *
 * Wired into chatSession's `readLine` seam. The legacy aidenPrompt
 * path is untouched: frame mode is OPT-IN via either
 *   - env var: `AIDEN_RENDERER=frame`, or
 *   - config:  `display.renderer === 'frame'`.
 *
 * The legacy spinner / indicator setInterval is EXPLICITLY paused
 * around frame readLine calls — see `pauseLegacyIndicator()`. Not a
 * silent disable: the legacy painter is gated through an audited
 * code path so we know when it's quiet.
 */

import {
  getFrameRuntime,
  type FrameRuntime,
  type ReadLineOptions,
} from './runtime';
import { isArmed, uninstallGuard } from './terminalDriver';

/**
 * Decide once per process whether frame mode is requested. Reads
 * - process.env.AIDEN_RENDERER (env wins; explicit override)
 * - the resolved Aiden config (if a `renderer` field is plumbed in)
 */
export function isFrameModeRequested(displayConfig?: { renderer?: string }): boolean {
  const env = (process.env.AIDEN_RENDERER ?? '').trim().toLowerCase();
  if (env === 'frame')  return true;
  if (env === 'legacy') return false;
  // Config fallback (display.renderer === 'frame').
  return (displayConfig?.renderer ?? '').toLowerCase() === 'frame';
}

/**
 * Read one line through the frame composer. Wraps the
 * pause-legacy-indicator dance so chatSession doesn't have to know
 * about it.
 *
 * Throws `Error('User force closed')` on Ctrl+C / Escape, matching
 * the legacy aidenPrompt contract.
 */
export async function readLineFramed(opts: ReadLineOptions): Promise<string> {
  const runtime: FrameRuntime = await getFrameRuntime();
  const release = pauseLegacyIndicator();
  try {
    return await runtime.readLine(opts);
  } finally {
    release();
  }
}

/**
 * Pause the legacy turn-status indicator (the setInterval-driven
 * spinner painter) for the duration of a frame mount. Returns a
 * release function — call it to resume.
 *
 * The indicator is a closure in cli/v4/display.ts that paints on a
 * setInterval. We can't reach into it from here directly; instead
 * we publish a global hook (`__aiden_legacy_indicator_pause`) that
 * the indicator checks on each tick. If the hook returns true, the
 * indicator skips its write. This keeps the audit trail explicit:
 * grep for `__aiden_legacy_indicator_pause` and you see every site
 * that touches the silence.
 */
export function pauseLegacyIndicator(): () => void {
  type Globals = typeof globalThis & { __aiden_legacy_indicator_paused?: boolean };
  const g = globalThis as Globals;
  const wasPaused = Boolean(g.__aiden_legacy_indicator_paused);
  g.__aiden_legacy_indicator_paused = true;
  return (): void => {
    g.__aiden_legacy_indicator_paused = wasPaused;
  };
}

/**
 * Called at the entry of runAgentTurn. The frame is unmounted by
 * readLineFramed's submit handler before runAgentTurn is invoked, so
 * this is currently advisory — but slices that switch to persistent
 * mount will need it.
 */
export async function pauseFrame(): Promise<void> {
  const runtime = await getFrameRuntime();
  runtime.pause();
}

/** Mirror of pauseFrame, called at runAgentTurn exit. */
export async function resumeFrame(): Promise<void> {
  const runtime = await getFrameRuntime();
  runtime.resume();
}

/**
 * Hard shutdown — used at REPL exit. Restores stdout's original
 * write function so callers that re-use the process see a clean
 * stream.
 */
export function shutdownFrame(): void {
  uninstallGuard();
}

/** Test/debug accessor: true iff the writer-singleton guard is currently active. */
export function isFrameArmed(): boolean {
  return isArmed();
}

export type { FrameRuntime, ReadLineOptions } from './runtime';
