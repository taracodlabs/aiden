/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/duringTurnInput.ts — v4.12.1 Pillar 4 Slice 2a.
 *
 * The pure, renderer-agnostic controller for "type to Aiden while a turn is
 * running." It owns the type-next QUEUE and the busy-Enter MODE — no stdin, no
 * render, so it's fully unit-testable headlessly. Both the frame and legacy
 * keypress sources feed this one controller.
 *
 * Modes: 'queue' (Enter-while-busy queues the message for after the turn — the
 * safe default), 'interrupt' (Enter cancels the turn), and 'redirect' (v4.12.1
 * Slice 2b — Enter injects a mid-turn nudge as tool-stream context at the safe
 * loop boundary; user-facing command is `/redirect`). `esc` is a distinct
 * always-live interrupt key handled by the keypress source, NOT a mode.
 *
 * Internal identifiers (pendingSteer / drainSteer / clearSteer / the 'steered'
 * action) keep the original verb — only the user-facing surface says redirect.
 */

export type BusyEnterMode = 'queue' | 'interrupt' | 'redirect';

export const BUSY_ENTER_MODES: readonly BusyEnterMode[] = ['queue', 'interrupt', 'redirect'];

export function isBusyEnterMode(s: unknown): s is BusyEnterMode {
  return s === 'queue' || s === 'interrupt' || s === 'redirect';
}

/** What the keypress source should DO with an Enter pressed during a turn. */
export type BusyEnterAction =
  | { action: 'queued';  count: number; text: string }
  | { action: 'steered'; text: string }
  | { action: 'interrupt' }
  | { action: 'ignored' };

export class DuringTurnInput {
  private queue: string[] = [];
  private mode: BusyEnterMode = 'queue';
  /**
   * v4.12.1 Slice 2b — the pending mid-turn steer. Buffered here (a member of
   * chatSession's controller, so "on the session" per the design) and drained
   * by the agent loop through a callback — the loop never owns the buffer.
   * Multiple nudges before the boundary accumulate (newline-joined).
   */
  private pendingSteer: string | null = null;

  // ── Mode ─────────────────────────────────────────────────────────────────
  setMode(mode: BusyEnterMode): void { this.mode = mode; }
  getMode(): BusyEnterMode { return this.mode; }

  // ── Queue ────────────────────────────────────────────────────────────────
  /** Append a message to the type-next queue. Empty/whitespace is ignored.
   *  Returns the new pending count. */
  enqueue(text: string): number {
    const t = text.trim();
    if (t.length > 0) this.queue.push(t);
    return this.queue.length;
  }

  /** Pop the oldest queued message (FIFO), or null when empty. Called at the
   *  REPL idle boundary to run a queued message instead of blocking on input. */
  dequeue(): string | null {
    return this.queue.shift() ?? null;
  }

  /** A copy of the pending queue (for `/queue` list). */
  peek(): string[] { return [...this.queue]; }
  count(): number { return this.queue.length; }
  hasQueued(): boolean { return this.queue.length > 0; }

  /** Empty the queue (force-exit, or `/queue clear`). Returns how many dropped. */
  clear(): number {
    const n = this.queue.length;
    this.queue = [];
    return n;
  }

  // ── Steer (Slice 2b) ──────────────────────────────────────────────────────
  /** Buffer a mid-turn steer; multiple nudges accumulate (newline-joined). */
  setPendingSteer(text: string): void {
    const t = text.trim();
    if (t.length === 0) return;
    this.pendingSteer = this.pendingSteer ? `${this.pendingSteer}\n${t}` : t;
  }

  /** Take + clear the pending steer (the loop's `drainSteer` callback). Null
   *  when none. Independent of the queue — steer lands mid-turn, queue after. */
  drainSteer(): string | null {
    const s = this.pendingSteer;
    this.pendingSteer = null;
    return s;
  }

  /** Drop any pending steer WITHOUT injecting — an interrupt supersedes a
   *  steer, so a stale nudge never leaks onto the next turn. */
  clearSteer(): boolean {
    const had = this.pendingSteer !== null;
    this.pendingSteer = null;
    return had;
  }

  hasPendingSteer(): boolean { return this.pendingSteer !== null; }

  /**
   * Resolve an Enter pressed DURING a turn per the active mode. The keypress
   * source acts on the returned action: queue → show a confirmation; steer →
   * buffer the nudge; interrupt → fire the turn-scoped abort.
   */
  onBusyEnter(text: string): BusyEnterAction {
    if (text.trim().length === 0) return { action: 'ignored' };
    if (this.mode === 'interrupt') return { action: 'interrupt' };
    if (this.mode === 'redirect') {
      this.setPendingSteer(text);
      return { action: 'steered', text: text.trim() };
    }
    const count = this.enqueue(text);
    return { action: 'queued', count, text: text.trim() };
  }
}
