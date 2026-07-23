/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Single-owner fixed terminal bottom region.
 *
 * One DEC scroll region keeps transcript, activity, and tool output above two
 * reserved rows. The second-last row is the composer and the last row is the
 * provider/model/context/timer status strip. Modal prompts release both rows
 * together; resize re-anchors and repaints both from their full source values.
 *
 * AIDEN_COMPOSER_LANE=0 remains the compatibility escape hatch. Non-TTY output
 * never emits terminal-control sequences.
 */

const ESC = '\x1b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;

/**
 * Confine scrolling to the rows above the fixed region and place the transcript
 * cursor at the bottom of that scrollable area. The explicit cursor placement
 * avoids restoring a cursor that was already inside a newly reserved row.
 */
export function reserveSeq(rows: number, laneRows = 2): string {
  const bottom = Math.max(1, rows - Math.max(1, laneRows));
  return `${ESC}[1;${bottom}r${ESC}[${bottom};1H`;
}

/** Paint one fixed row without disturbing the transcript cursor. */
export function paintSeq(rows: number, text: string, offsetFromBottom = 0): string {
  const row = Math.max(1, rows - Math.max(0, offsetFromBottom));
  return `${SAVE}${ESC}[${row};1H${ESC}[2K${text}${RESTORE}`;
}

/** Restore full-screen scrolling and clear every row owned by the region. */
export function teardownSeq(rows: number, laneRows = 2): string {
  let clear = '';
  for (let offset = Math.max(1, laneRows) - 1; offset >= 0; offset -= 1) {
    clear += `${ESC}[${Math.max(1, rows - offset)};1H${ESC}[2K`;
  }
  return `${ESC}[r${SAVE}${clear}${RESTORE}`;
}

/** Tail-fit composer text so the cursor end remains visible. */
export function fitLane(text: string, cols: number): string {
  const width = Math.max(4, cols);
  if (text.length <= width) return text;
  return '…' + text.slice(-(width - 1));
}

type StatusSource = string | (() => string);

/** ANSI-aware front truncation. Status formatters normally width-tier their
 * output; this is the final no-wrap guard for custom/test status strings. */
function fitStatus(text: string, cols: number): string {
  const width = Math.max(4, cols);
  let visible = 0;
  let out = '';
  for (let i = 0; i < text.length && visible < width;) {
    if (text[i] === ESC && text[i + 1] === '[') {
      const match = /^\x1b\[[0-9;]*[A-Za-z]/u.exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += text[i];
    visible += 1;
    i += 1;
  }
  return out;
}

export interface LaneSink {
  write: (s: string) => void;
  rows: () => number;
  cols: () => number;
  onResize: (fn: () => void) => () => void;
}

export class BottomRegion {
  private active = false;
  private composerSource = '';
  private statusSource: StatusSource = '';
  private lastComposer = '';
  private lastStatus = '';
  private unsubResize: (() => void) | null = null;

  constructor(private readonly sink: LaneSink) {}

  isActive(): boolean {
    return this.active;
  }

  /** Reserve and paint both rows. Repeated activation is an idempotent update. */
  activate(composer: string, status: StatusSource = this.statusSource): void {
    if (!this.active) {
      this.sink.write(reserveSeq(this.sink.rows()));
      this.unsubResize = this.sink.onResize(() => this.reanchor());
      this.active = true;
    }
    this.composerSource = composer;
    this.statusSource = status;
    this.paintAll();
  }

  /** Backward-compatible composer-row update. */
  paint(text: string): void {
    if (!this.active) return;
    this.composerSource = text;
    const fitted = fitLane(text, this.sink.cols());
    if (fitted === this.lastComposer) return;
    this.lastComposer = fitted;
    this.sink.write(paintSeq(this.sink.rows(), fitted, 1));
  }

  paintStatus(status: StatusSource): void {
    if (!this.active) return;
    this.statusSource = status;
    const raw = typeof status === 'function' ? status() : status;
    const fitted = fitStatus(raw, this.sink.cols());
    if (fitted === this.lastStatus) return;
    this.lastStatus = fitted;
    this.sink.write(paintSeq(this.sink.rows(), fitted, 0));
  }

  private paintAll(): void {
    this.paint(this.composerSource);
    this.paintStatus(this.statusSource);
  }

  private reanchor(): void {
    if (!this.active) return;
    this.sink.write(reserveSeq(this.sink.rows()));
    this.lastComposer = '';
    this.lastStatus = '';
    this.paintAll();
  }

  /** Release and clear both rows exactly once. Source values remain with the
   * display owner so a balanced modal resume can repaint them. */
  deactivate(): void {
    if (!this.active) return;
    this.sink.write(teardownSeq(this.sink.rows()));
    this.unsubResize?.();
    this.unsubResize = null;
    this.active = false;
    this.lastComposer = '';
    this.lastStatus = '';
  }
}

/** Existing importer compatibility; the implementation now owns both rows. */
export { BottomRegion as ComposerLane };

export function composerLaneEnabled(): boolean {
  return process.env.AIDEN_COMPOSER_LANE !== '0';
}
