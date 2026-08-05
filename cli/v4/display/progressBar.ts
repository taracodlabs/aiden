/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display/progressBar.ts — Phase v4.1.4 Part 1.6.
 *
 * Per-turn token progress bar. Renders `▰▰▰▰▰▱▱▱▱▱  412/4096 tokens`
 * on a single line below the activity indicator (or in place of it,
 * once the stream takes over). Event-driven: each `update(n, max)`
 * call redraws the bar with the new counter — no `setInterval`,
 * because the source of truth is the adapter's incremental
 * `progress` stream events, which already fire at the granularity
 * the model produces tokens.
 *
 * Honest degradation: if the adapter never calls `update()`, the bar
 * never paints. No client-side estimation (per v4.1.4 spec — token
 * count only, no time-based fakery).
 *
 * Visual:
 *
 *     ▰▰▰▰▰▱▱▱▱▱  412/4096 tokens
 *     │└────┬───┘  └────┬─────┘
 *     │     │           └── current/max (compact via formatCompactTokens)
 *     │     └── 10 cells, filled ratio ∝ outputTokens/maxTokens
 *     └── leading gutter aligns with frame
 *
 * Bar cells:
 *   - filled: ▰ (U+25B0, dark shade block-fill)
 *   - empty:  ▱ (U+25B1, light shade)
 *
 * Cursor invariant on render: bar OWNS one line. After each `update`
 * the cursor sits at column 0 of the bar line (single-line `\r\x1b[K`
 * overwrite pattern, same as activityIndicator). Callers that want to
 * write OTHER content below MUST call `hide()` first.
 *
 * Non-TTY: completely silent — pipes/CI/MCP serve mode get clean
 * output by default. The handle still accepts updates so callers
 * don't need to branch on TTY-ness.
 */

import type { SkinEngine } from '../skinEngine';
import { getIndent } from './frame';
import { formatCompactTokens } from '../display';

/**
 * Handle returned by `createProgressBar`. The display layer creates
 * one per turn; callers feed `update(n, max)` from adapter `progress`
 * events. `hide()` erases the line + freezes state; subsequent
 * `update` calls are no-ops until the next bar is created.
 */
export interface ProgressBarHandle {
  /**
   * Paint or re-paint the bar with the running token count. Idempotent
   * when `outputTokens` hasn't advanced — the renderer dedupes so a
   * stream of identical updates doesn't flicker.
   */
  update(outputTokens: number, maxTokens?: number): void;
  /**
   * Erase the line and stop accepting further updates. Terminal —
   * idempotent. Called when the stream completes OR a tool row is
   * about to write below the bar.
   */
  hide(): void;
  /** Test/inspection — current state snapshot. */
  isHidden(): boolean;
  getTokens(): { output: number; max: number | undefined };
}

export interface ProgressProjection {
  update(line: string): boolean;
  clear(): boolean;
  settle(line: string): boolean;
}

/**
 * Number of bar cells. 10 cells gives clean fractions (every 10% of
 * fill ratio == one cell). Wider bars feel noisy at the standard
 * frame width (75 visible cols on an 80-col terminal).
 */
const BAR_CELLS = 10;

/** Glyphs. Chosen for clean visual weight at the standard mono font. */
// v4.1.5 Phase 1d (Q-P1) — glyph palette switch.
//
// Was `▰` (U+25B0 BLACK RECTANGLE) + `▱` (U+25B1 WHITE RECTANGLE),
// from Unicode's "Geometric Shapes" block. NOT in CP437; Windows
// legacy console fonts (Lucida Console / Consolas defaults) render
// them as tofu boxes. User visual smoke confirmed the regression
// on Windows Terminal + ConPTY combinations.
//
// New: `▓` (U+2593 DARK SHADE) + `░` (U+2591 LIGHT SHADE), from
// Unicode's "Block Elements" block AND CP437 — universally
// supported on every Windows console going back to DOS. Same shade
// family the existing `statusFooter` (display.ts:773) has shipped
// with since v3 without ever being garbled. Cleaner palette
// coherence across all bar surfaces.
const FILLED = '▓';
const EMPTY  = '░';

/**
 * Create a progress-bar handle bound to a writable stream + skin.
 * The bar paints on the next `update` call — there's no initial
 * paint at creation time, because we don't know the token counts yet.
 *
 * `out` is the stream to write on (usually `process.stdout` via
 * `Display.out`). `skin` is the active skin engine. Both are captured
 * by closure — the handle survives skin swaps for the rest of the turn.
 */
export function createProgressBar(
  out:  NodeJS.WriteStream,
  skin: SkinEngine,
  projection?: ProgressProjection,
): ProgressBarHandle {
  const isTty = !!out.isTTY;

  let outputTokens = 0;
  let maxTokens:   number | undefined = undefined;
  let printed     = false;
  let hidden      = false;
  let lastPaintTokens = -1;
  let projected = false;
  let rawPrinted = false;

  const buildLine = (): string => {
    // Fill ratio: 0..1, then snap to a cell count 0..BAR_CELLS.
    const denom = maxTokens && maxTokens > 0 ? maxTokens : 0;
    const ratio = denom > 0 ? Math.min(1, outputTokens / denom) : 0;
    const filled = Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS));
    const empty  = BAR_CELLS - filled;
    const bar    = skin.applyColors(FILLED.repeat(filled), 'brand') +
                   skin.applyColors(EMPTY.repeat(empty),  'muted');
    // Label: compact "412/4096 tokens". If no maxTokens, render
    // "412 tokens" (denominator unknown). The model name doesn't
    // belong here — that's the status footer's job post-turn.
    const left  = formatCompactTokens(outputTokens);
    const right = denom > 0 ? formatCompactTokens(denom) : '?';
    const label = denom > 0
      ? skin.applyColors(`${left}/${right} tokens`, 'muted')
      : skin.applyColors(`${left} tokens`, 'muted');
    const gutter = getIndent(0);
    return `${gutter}${bar}  ${label}`;
  };

  // v4.1.5 Part 1a — Issue M (Windows ConPTY buffering fix).
  //
  // Mirrors the activityIndicator pattern: the bar OWNS one terminal
  // row. Every paint ends with `\n` so the buffer flushes; the cursor
  // sits on the row BELOW the bar while it's visible. Erase walks
  // up + clears the bar's row, leaving the cursor at col 0 of the
  // now-empty row for the caller's next write. See activityIndicator
  // for the full rationale (Windows ConPTY buffers no-newline writes
  // until a `\n` arrives — without this, long-running stream paints
  // never visually appeared).
  const ANSI_UP_ERASE = '\x1b[1A\x1b[2K';

  const paint = (): void => {
    if (!isTty || hidden) return;
    const line = buildLine();
    if (projection?.update(line)) {
      printed = true;
      projected = true;
      lastPaintTokens = outputTokens;
      return;
    }
    if (rawPrinted) {
      // Subsequent paint: walk up to the bar's row, clear it, rewrite,
      // drop a newline so the cursor lands on the row BELOW the bar.
      out.write(`${ANSI_UP_ERASE}${line}\n`);
    } else {
      // First paint: just write the bar + `\n`. Cursor moves to the
      // row below, ready for subsequent walk-up-and-erase ticks.
      out.write(`${line}\n`);
      printed = true;
      rawPrinted = true;
    }
    lastPaintTokens = outputTokens;
  };

  const erase = (): void => {
    if (projected && projection?.clear()) return;
    // Walk up to the bar's row and clear it. No trailing `\n` — the
    // caller will write content here and include its own newline.
    if (isTty && rawPrinted) out.write(ANSI_UP_ERASE);
  };

  return {
    update(n: number, max?: number): void {
      if (hidden) return;
      // Coerce + clamp. Non-finite or negative inputs are ignored —
      // never crash the stream consumer with a malformed event.
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
        outputTokens = Math.floor(n);
      }
      if (typeof max === 'number' && Number.isFinite(max) && max > 0) {
        maxTokens = Math.floor(max);
      }
      // Dedup: skip the repaint if the visible state didn't change.
      // Anthropic emits message_delta events with the SAME running
      // counter when no new tokens were produced; without this
      // gate we'd flicker on every duplicate.
      if (outputTokens === lastPaintTokens && printed) return;
      paint();
    },
    hide(): void {
      if (hidden) return;
      hidden = true;
      erase();
    },
    isHidden(): boolean { return hidden; },
    getTokens(): { output: number; max: number | undefined } {
      return { output: outputTokens, max: maxTokens };
    },
  };
}
