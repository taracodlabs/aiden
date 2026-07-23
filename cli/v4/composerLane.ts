/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/composerLane.ts — v4.14 the single-owner FIXED bottom composer lane.
 *
 * THE PROBLEM it solves: today the during-turn composer is only a SUFFIX woven
 * into whichever transient status row is live (the activity indicator, a tool
 * row), and it is cleared the moment token streaming begins — so while a turn
 * streams there is no anchored input line, and typing is blind. There is no
 * single renderer that owns a fixed composer region.
 *
 * THE FIX: ONE owner reserves the bottom terminal row via a DEC scroll region
 * (DECSTBM). All turn output — streaming text, tool rows, the indicator —
 * scrolls inside the region ABOVE the lane; the terminal itself guarantees the
 * bottom row is never touched by that output, so the composer can never be
 * overwritten, pushed, or garbled. The lane repaints ONLY on a keystroke /
 * hint change / resize — no per-write flicker. This is the reusable
 * composer-ownership seam the future dashboard's steering bar drives too.
 *
 * Enabled for interactive terminals by default. AIDEN_COMPOSER_LANE=0 is an
 * emergency compatibility escape hatch; non-interactive output never uses the
 * lane.
 *
 * The escape-sequence builders are pure + unit-tested; the owner wires them to
 * a write sink + a terminal-dimensions source and tracks activate/resize state.
 */

// ── pure escape-sequence builders (unit-tested; no I/O) ──────────────────────

const ESC = '\x1b';
/** DECSC / DECRC — save / restore cursor (position, not content). */
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;

/**
 * Reserve the bottom `laneRows` rows by confining the scroll region to the rows
 * ABOVE them (DECSTBM `CSI top;bottom r`). Cursor-safe: DECSTBM homes the
 * cursor, so we save before and restore after — output keeps flowing from where
 * it was, now bounded to the region. `rows` = terminal height (1-based).
 */
export function reserveSeq(rows: number, laneRows = 1): string {
  const bottom = Math.max(1, rows - Math.max(1, laneRows));
  return `${SAVE}${ESC}[1;${bottom}r${RESTORE}`;
}

/**
 * Paint `text` on the reserved bottom row, cursor-safe: save → jump to the
 * bottom row col 1 → clear line → write → restore. The saved/restored cursor is
 * the output cursor inside the region, so painting the lane never disturbs the
 * flowing output above it. `text` must already be width-fit (no wrap).
 */
export function paintSeq(rows: number, text: string): string {
  return `${SAVE}${ESC}[${rows};1H${ESC}[2K${text}${RESTORE}`;
}

/**
 * Tear down: restore full-screen scrolling (`CSI r` with no params) and clear
 * the lane row so nothing is left pinned once the turn ends.
 */
export function teardownSeq(rows: number): string {
  return `${ESC}[r${SAVE}${ESC}[${rows};1H${ESC}[2K${RESTORE}`;
}

/** Tail-fit `text` to `cols` columns (visible width), ellipsis at the FRONT so
 *  the most-recent keystrokes (the cursor end) stay visible. ANSI-free input. */
export function fitLane(text: string, cols: number): string {
  const width = Math.max(4, cols);
  if (text.length <= width) return text;
  return '…' + text.slice(-(width - 1));
}

// ── the owner ────────────────────────────────────────────────────────────────

export interface LaneSink {
  write: (s: string) => void;
  /** Terminal height in rows; may change on resize. */
  rows: () => number;
  /** Terminal width in columns. */
  cols: () => number;
  /** Subscribe to terminal resize; returns an unsubscribe fn. */
  onResize: (fn: () => void) => () => void;
}

/**
 * Owns the fixed bottom composer lane for the duration of a turn. Idempotent
 * activate/deactivate; repaints on demand and re-anchors on resize. Holds the
 * last painted text so a resize can restore it without the caller re-supplying.
 */
export class ComposerLane {
  private active = false;
  private sourceText = '';
  private lastText = '';
  private unsubResize: (() => void) | null = null;

  constructor(private readonly sink: LaneSink) {}

  isActive(): boolean { return this.active; }

  /** Reserve the lane and paint `text`. Idempotent — a second activate just
   *  repaints. Subscribes to resize so the lane re-anchors cleanly. */
  activate(text: string): void {
    const rows = this.sink.rows();
    if (!this.active) {
      this.sink.write(reserveSeq(rows));
      this.unsubResize = this.sink.onResize(() => this.reanchor());
      this.active = true;
    }
    this.paint(text);
  }

  /** Repaint the lane with new text (keystroke / hint change). No-op when the
   *  text is unchanged, so a redundant paint never flickers. */
  paint(text: string): void {
    if (!this.active) return;
    this.sourceText = text;
    const fitted = fitLane(text, this.sink.cols());
    if (fitted === this.lastText) return;
    this.lastText = fitted;
    this.sink.write(paintSeq(this.sink.rows(), fitted));
  }

  /** Resize: re-reserve the region for the new height and repaint in place. */
  private reanchor(): void {
    if (!this.active) return;
    const rows = this.sink.rows();
    this.sink.write(reserveSeq(rows));
    const text = this.sourceText;
    this.lastText = '';        // force the repaint (dims changed)
    this.paint(text);
  }

  /** Restore full-screen scrolling + clear the lane. Idempotent. */
  deactivate(): void {
    if (!this.active) return;
    this.sink.write(teardownSeq(this.sink.rows()));
    this.unsubResize?.();
    this.unsubResize = null;
    this.active = false;
    this.sourceText = '';
    this.lastText = '';
  }
}

/** True unless the fixed-lane renderer is explicitly disabled. Display also
 * requires a TTY before emitting terminal control sequences. */
export function composerLaneEnabled(): boolean {
  return process.env.AIDEN_COMPOSER_LANE !== '0';
}
