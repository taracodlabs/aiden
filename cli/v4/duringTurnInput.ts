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
 * Modes (Slice 2a): 'queue' (Enter-while-busy queues the message for after the
 * turn — the safe, non-destructive default) and 'interrupt' (Enter cancels the
 * turn). `esc` is a distinct always-live interrupt key handled by the keypress
 * source, NOT a mode. 'steer' (inject mid-turn) is Slice 2b.
 */

export type BusyEnterMode = 'queue' | 'interrupt';

export const BUSY_ENTER_MODES: readonly BusyEnterMode[] = ['queue', 'interrupt'];

export function isBusyEnterMode(s: unknown): s is BusyEnterMode {
  return s === 'queue' || s === 'interrupt';
}

/** What the keypress source should DO with an Enter pressed during a turn. */
export type BusyEnterAction =
  | { action: 'queued'; count: number; text: string }
  | { action: 'interrupt' }
  | { action: 'ignored' };

export class DuringTurnInput {
  private queue: string[] = [];
  private mode: BusyEnterMode = 'queue';

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

  /**
   * Resolve an Enter pressed DURING a turn per the active mode. The keypress
   * source calls this and acts on the returned action (queue → show a
   * confirmation; interrupt → fire the turn-scoped abort).
   */
  onBusyEnter(text: string): BusyEnterAction {
    if (text.trim().length === 0) return { action: 'ignored' };
    if (this.mode === 'interrupt') return { action: 'interrupt' };
    const count = this.enqueue(text);
    return { action: 'queued', count, text: text.trim() };
  }
}
