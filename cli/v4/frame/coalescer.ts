/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/frame/coalescer.ts — render coalescing for the Ink frame.
 *
 * Fast model streams emit many tiny deltas; repainting the whole frame on each
 * one thrashes the reconciler. This batches deltas and signals a flush at most
 * once per `intervalMs` (~16–33ms = 30–60fps). It NEVER drops content — only
 * FRAMES: on flush the whole accumulated text is returned. The clock is
 * injected so it's deterministic + headless-testable.
 */
export interface DeltaCoalescer {
  /** Accumulate a delta (content is never lost). */
  push(text: string): void;
  /** True when there's buffered content AND enough time has passed to paint. */
  shouldFlush(nowMs: number): boolean;
  /** Drain the accumulated text and stamp the flush time. */
  flush(nowMs: number): string;
  /** True when any content is buffered (e.g. flush the tail at turn end). */
  pending(): boolean;
}

export function makeCoalescer(intervalMs = 24): DeltaCoalescer {
  let buf = '';
  let lastFlush = -Infinity;
  return {
    push(text) { if (text) buf += text; },
    shouldFlush(nowMs) { return buf.length > 0 && nowMs - lastFlush >= intervalMs; },
    flush(nowMs) { const out = buf; buf = ''; lastFlush = nowMs; return out; },
    pending() { return buf.length > 0; },
  };
}
