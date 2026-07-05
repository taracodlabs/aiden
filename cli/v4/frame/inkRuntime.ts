/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/frame/inkRuntime.ts — the single frame OWNER (Ink-backed).
 *
 * Mounts ONE persistent Ink tree that owns the terminal frame + final cursor
 * for the whole session. Every event goes `dispatch → frameReducer → FrameState
 * → Ink rerender`; stream deltas are coalesced (~24ms) so a fast model doesn't
 * thrash the reconciler (content is never dropped, only frames). Ink itself
 * redraws the full frame on resize. The terminalDriver writer-singleton guard
 * (armed here) makes any stray non-Ink stdout write throw — so nothing can race
 * the frame while Ink owns it.
 *
 * Gated by `inkEnabled()` (AIDEN_INK=1); the default render path never
 * constructs this. Ink no-ops its paint in CI, so this is import-safe in tests.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const React = require('react') as typeof import('react');

import { installGuard, arm, disarm, getDriverStream } from './terminalDriver';
import {
  frameReducer, initialFrameState, type FrameEvent, type FrameState,
} from './frameReducer';
import { makeCoalescer } from './coalescer';
import { makeInkApp, type InkAppComponents } from './inkApp';

// Minimal Ink surface (see runtime.ts for why the type is hand-rolled + the
// import is deferred past tsc's moduleResolution).
interface InkModule extends InkAppComponents {
  render: (node: React.ReactElement, opts?: {
    stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream; exitOnCtrlC?: boolean; patchConsole?: boolean;
  }) => { unmount: () => void; rerender: (n: React.ReactElement) => void; clear: () => void };
}
let inkModuleP: Promise<InkModule> | null = null;
const _dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
async function loadInk(): Promise<InkModule> {
  if (!inkModuleP) inkModuleP = _dynamicImport('ink') as Promise<InkModule>;
  return inkModuleP;
}

export interface InkRuntime {
  /** Apply an event and repaint. */
  dispatch(ev: FrameEvent): void;
  /** Push a coalesced stream delta (batched into ~1 frame per interval). */
  streamDelta(turnId: number, text: string): void;
  /** Flush any buffered delta immediately (e.g. at a tool boundary / turn end). */
  flush(): void;
  getState(): FrameState;
  shutdown(): void;
}

/** True when the Ink single-frame renderer is opted into (default OFF — the
 *  legacy path is untouched until this is smoke-proven on a real terminal). */
export function inkEnabled(): boolean {
  return process.env.AIDEN_INK === '1';
}

export async function createInkRuntime(
  opts: { nowFn?: () => number; coalesceMs?: number } = {},
): Promise<InkRuntime> {
  const nowFn = opts.nowFn ?? (() => Date.now());
  installGuard();
  const ink = await loadInk();
  const InkApp = makeInkApp({ Box: ink.Box, Text: ink.Text, Static: ink.Static });

  let state = initialFrameState();
  const coalescer = makeCoalescer(opts.coalesceMs ?? 24);
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let currentTurn: number | null = null;

  const stream = getDriverStream();
  const instance = ink.render(
    React.createElement(InkApp, { state }),
    { stdout: stream as unknown as NodeJS.WriteStream, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false },
  );
  arm();

  const repaint = (): void => { instance.rerender(React.createElement(InkApp, { state })); };
  const apply = (ev: FrameEvent): void => { state = frameReducer(state, ev); if (ev.type === 'turn/start') currentTurn = ev.turnId; };

  const drainDelta = (): void => {
    if (!coalescer.pending() || currentTurn === null) return;
    apply({ type: 'stream/delta', turnId: currentTurn, text: coalescer.flush(nowFn()) });
    repaint();
  };

  return {
    dispatch(ev) { apply(ev); if (ev.type === 'turn/end' || ev.type === 'turn/interrupt') { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } } repaint(); },
    streamDelta(turnId, text) {
      currentTurn = turnId;
      coalescer.push(text);
      if (flushTimer === null) {
        flushTimer = setTimeout(() => { flushTimer = null; drainDelta(); }, opts.coalesceMs ?? 24);
      }
    },
    flush() { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } drainDelta(); },
    getState() { return state; },
    shutdown() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      try { instance.clear(); } catch { /* noop */ }
      try { instance.unmount(); } catch { /* noop */ }
      disarm();
    },
  };
}
