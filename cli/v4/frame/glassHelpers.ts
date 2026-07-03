/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/frame/glassHelpers.ts — v4.12.1 Pillar 4 Slice 1.
 *
 * Small pure helpers for the glass dashboard: the action footer (what
 * interrupt actions are available while busy), the N-behind update segment
 * (reusing the existing update-check status), and the cost-tick throttle (so
 * a live cost event fires at most ~1/sec, never per token).
 */

// ── Action footer (interrupt hints) ──────────────────────────────────────────

/**
 * Render the footer of available actions. Only shown while a turn runs.
 * v4.12.1 Slice 2a — surfaces the busy-Enter MODE and the type-next QUEUE
 * count so the user always knows what Enter does and that queued input wasn't
 * lost. `mode`/`queueCount` are optional for back-compat with Slice-1 callers.
 */
export function renderFooter(
  opts: { busy: boolean; activeSubagents: number; mode?: 'queue' | 'interrupt' | 'redirect'; queueCount?: number },
  width = 80,
): string {
  if (!opts.busy) return '';
  const hints: string[] = [];
  // What Enter does right now (mode-dependent), then esc always cancels.
  if (opts.mode === 'queue')      hints.push('enter = queue next');
  else if (opts.mode === 'interrupt') hints.push('enter = cancel turn');
  else if (opts.mode === 'redirect') hints.push('enter = redirect');
  hints.push('esc = cancel turn');
  if (opts.activeSubagents > 0) {
    hints.push(`ctrl+k = cancel 1 of ${opts.activeSubagents} subagent${opts.activeSubagents === 1 ? '' : 's'}`);
  }
  if (opts.queueCount && opts.queueCount > 0) {
    hints.push(`${opts.queueCount} queued`);
  }
  const line = hints.join('  ·  ');
  return line.length > width ? line.slice(0, Math.max(0, width - 1)) + '…' : line;
}

// ── N-behind update segment ──────────────────────────────────────────────────

/** The subset of the existing update-check status the bar needs. */
export interface UpdateSnapshot {
  installed?:      string;
  latest?:         string | null;
  updateAvailable?: boolean;
}

/**
 * A compact "newer version available" segment, or null when up to date /
 * unknown / on failure. Passive + silent — shows NOTHING unless behind. Does
 * not claim the RUNNING process is updated: it only reports a newer version
 * exists (restart is the boundary).
 */
export function formatNBehind(status: UpdateSnapshot | null | undefined): string | null {
  if (!status || !status.updateAvailable || !status.latest) return null;
  return `${status.latest} ↑`;
}

// ── Cost-tick throttle ───────────────────────────────────────────────────────

/**
 * Gates the `cost_updated` event to at most one per `minIntervalMs`. A live
 * cost tick must never fire per token — it would flood the stream and the
 * dashboard. First call always passes (so the initial reading shows promptly).
 */
export class CostTicker {
  private lastMs: number | null = null;
  constructor(private readonly minIntervalMs = 1000) {}

  shouldEmit(nowMs: number): boolean {
    if (this.lastMs === null || nowMs - this.lastMs >= this.minIntervalMs) {
      this.lastMs = nowMs;
      return true;
    }
    return false;
  }

  /** Force the next shouldEmit to pass (e.g. at turn end for a final reading). */
  reset(): void { this.lastMs = null; }
}
