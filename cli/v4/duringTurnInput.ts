/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/duringTurnInput.ts — v4.12.1 Pillar 4 Slice 2a; extended v4.14.
 *
 * The pure, renderer-agnostic ENGINE for "type to Aiden while a turn is
 * running." It owns the type-next QUEUE, the busy-Enter MODE, the PAUSE gate,
 * the BACKGROUND-handoff intent, and the plain-language indicator text — no
 * stdin, no render, no timers, so it's fully unit-testable headlessly. Every
 * live-input surface drives this ONE engine: the terminal steering bar AND the
 * future dashboard are just adapters over it (this is the reusable-engine seam
 * — nothing terminal-specific lives here).
 *
 * Enter-modes (what Enter does mid-turn): 'queue' (queue the message for after
 * the turn — the safe default), 'interrupt' (cancel the turn), and 'redirect'
 * (v4.12.1 Slice 2b — inject a mid-turn nudge as tool-stream context at the
 * safe loop boundary; user-facing command is `/redirect`). `esc` is a distinct
 * always-live interrupt key handled by the keypress source, NOT a mode.
 *
 * Orthogonal controls (v4.14, driven by commands, not Enter-modes):
 *   • PAUSE — freeze the loop at its next safe boundary; resume on command. The
 *     engine holds only the flag + a waiter list; the loop awaits
 *     `waitWhilePaused` at the SAME boundary steer injects at.
 *   • BACKGROUND — a one-shot intent the session reads to hand the running turn
 *     to the durable-run substrate; the engine never touches the daemon.
 *   • Steer SALVAGE — if a turn ends with a steer still buffered (no safe
 *     boundary was reached), it's moved to the queue, never silently dropped.
 *
 * Internal identifiers (pendingSteer / drainSteer / clearSteer / the 'steered'
 * action) keep the original verb — only the user-facing surface says redirect.
 */

export type BusyEnterMode = 'queue' | 'interrupt' | 'redirect';

export const BUSY_ENTER_MODES: readonly BusyEnterMode[] = ['queue', 'interrupt', 'redirect'];

export function isBusyEnterMode(s: unknown): s is BusyEnterMode {
  return s === 'queue' || s === 'interrupt' || s === 'redirect';
}

/**
 * Read the persisted preferred busy-mode from config (`agent.busyMode`) so the
 * user's choice survives a restart — the boot path seeds `DuringTurnInput` with
 * it. A missing/garbage value coerces to the safe default 'queue' and never
 * RAISES to interrupt/redirect. Kept cli-side (config only needs `getValue`) so
 * core never depends on this module.
 */
export function resolveConfiguredBusyMode(
  config?: { getValue<T = unknown>(key: string, fallback?: T): T },
): BusyEnterMode {
  const raw = config?.getValue<string | undefined>('agent.busyMode', undefined);
  return isBusyEnterMode(raw) ? raw : 'queue';
}

/** What the keypress source should DO with an Enter pressed during a turn. */
export type BusyEnterAction =
  | { action: 'queued';  count: number; text: string }
  | { action: 'steered'; text: string }
  | { action: 'interrupt' }
  | { action: 'ignored' };

export class DuringTurnInput {
  private queue: string[] = [];
  private mode: BusyEnterMode;
  /**
   * v4.12.1 Slice 2b — the pending mid-turn steer. Buffered here (a member of
   * chatSession's controller, so "on the session" per the design) and drained
   * by the agent loop through a callback — the loop never owns the buffer.
   * Multiple nudges before the boundary accumulate (newline-joined).
   */
  private pendingSteer: string | null = null;

  // v4.14 — orthogonal controls (pause gate + background handoff intent).
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private backgroundRequested = false;

  /** `initialMode` restores a persisted preferred busy-mode at session boot. */
  constructor(initialMode: BusyEnterMode = 'queue') {
    this.mode = isBusyEnterMode(initialMode) ? initialMode : 'queue';
  }

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

  // ── Pause / Resume (v4.14) ────────────────────────────────────────────────
  /** Request a freeze. The loop, at its next safe boundary, awaits
   *  `waitWhilePaused`. Returns false if already paused (idempotent). */
  requestPause(): boolean {
    if (this.paused) return false;
    this.paused = true;
    return true;
  }

  isPaused(): boolean { return this.paused; }

  /** Resume from a pause; wakes every boundary awaiting `waitWhilePaused`.
   *  Returns true if it was actually paused. */
  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const w of waiters) w();
    return true;
  }

  /**
   * Await here at a safe loop boundary while paused. Resolves immediately when
   * not paused; otherwise when `resume()` fires — or when the turn's abort
   * signal aborts, so Ctrl+C during a pause still cancels cleanly (the loop
   * then sees `signal.aborted`). Renderer-agnostic: only a flag + waiter list,
   * no timers, no stdin.
   */
  waitWhilePaused(signal?: AbortSignal): Promise<void> {
    if (!this.paused || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  // ── Background handoff (v4.14) ────────────────────────────────────────────
  /** Flag the running turn to be handed to the durable-run substrate. The
   *  session reads this via `takeBackgroundRequest` and does the handoff — the
   *  engine never touches the daemon. */
  requestBackground(): void { this.backgroundRequested = true; }

  /** Read + clear the background-handoff intent (one-shot). */
  takeBackgroundRequest(): boolean {
    const b = this.backgroundRequested;
    this.backgroundRequested = false;
    return b;
  }

  hasBackgroundRequest(): boolean { return this.backgroundRequested; }

  // ── Steer salvage (v4.14) ─────────────────────────────────────────────────
  /**
   * Called when a turn ENDS with a steer still buffered — the loop never
   * reached a safe injection boundary (e.g. a text-only turn that finished
   * before any tool batch). Rather than silently dropping the nudge, move it to
   * the type-next queue so it runs next, and return it so the UI can show a
   * visible "couldn't steer mid-turn — queued instead" note. Null when there
   * was nothing pending.
   */
  salvageSteerToQueue(): string | null {
    const s = this.drainSteer();
    if (s === null) return null;
    this.enqueue(s);
    return s;
  }

  // ── Indicator text (v4.14) — shared by the terminal bar AND the dashboard ──
  /** ONE clear current action for the busy bar, in plain language. */
  enterActionLabel(): string {
    if (this.paused) return 'paused';
    switch (this.mode) {
      case 'interrupt': return 'Enter → stop turn';
      case 'redirect':  return 'Enter → steer';
      default:          return 'Enter → queue';
    }
  }

  /** The compact one-line busy hint: current action + how to switch + stop. */
  busyHint(): string {
    if (this.paused) return 'Paused · /resume to continue · Ctrl+C stop';
    return `${this.enterActionLabel()} · /busy to change · Ctrl+C stop`;
  }
}
