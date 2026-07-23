/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Single-owner fixed terminal bottom region.
 *
 * The owner reserves a variable-height boxed composer plus one status row.
 * Transcript, activity, and tool writes are restored to the scrollable region;
 * the hardware cursor is then returned to the draft insertion point. Modal
 * prompts release the complete surface and a balanced resume reconstructs it.
 *
 * AIDEN_COMPOSER_LANE=0 remains the compatibility escape hatch. Non-TTY output
 * never emits terminal-control sequences.
 */

const ESC = '\x1b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const SAVE_TRANSCRIPT = `${ESC}[s`;
const RESTORE_TRANSCRIPT = `${ESC}[u`;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidth: (value: string) => number = require('string-width');
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

function terminalWidth(text: string): number {
  return stringWidth(text.replace(ANSI_PATTERN, ''));
}

/**
 * Confine scrolling to the rows above the fixed region and place the transcript
 * cursor at the bottom of that scrollable area.
 */
export function reserveSeq(rows: number, laneRows = 2): string {
  const bottom = Math.max(1, rows - Math.max(1, laneRows));
  return `${ESC}[1;${bottom}r${ESC}[${bottom};1H`;
}

/** Paint one fixed row without disturbing the caller's saved cursor. */
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

/** Tail-fit compatibility helper retained for legacy importers. */
export function fitLane(text: string, cols: number): string {
  const width = Math.max(4, cols);
  if (terminalWidth(text) <= width) return text;
  const plain = text.replace(ANSI_PATTERN, '');
  let tail = '';
  for (const character of Array.from(plain).reverse()) {
    if (stringWidth(`…${character}${tail}`) > width) break;
    tail = character + tail;
  }
  return `…${tail}`;
}

type StatusSource = string | (() => string);

/** ANSI-aware front truncation used as the final no-wrap status guard. */
function fitStatus(text: string, cols: number): string {
  const width = Math.max(4, cols);
  if (terminalWidth(text) <= width) return text;
  let plain = '';
  let out = '';
  let sawAnsi = false;
  for (let i = 0; i < text.length;) {
    if (text[i] === ESC && text[i + 1] === '[') {
      const match = /^\x1b\[[0-9;]*[A-Za-z]/u.exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        sawAnsi = true;
        continue;
      }
    }
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (stringWidth(plain + character) > width) break;
    out += character;
    plain += character;
    i += character.length;
  }
  return sawAnsi ? `${out}${ESC}[0m` : out;
}

function padVisible(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - terminalWidth(text)))}`;
}

interface WrappedDraft {
  lines: string[];
  cursorLine: number;
  cursorCell: number;
}

function wrapDraft(
  text: string,
  width: number,
  maxLines: number,
  cursorIndex = text.length,
): WrappedDraft {
  const boundedCursor = Math.max(0, Math.min(text.length, cursorIndex));
  const beforeCursor = text.slice(0, boundedCursor)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ');
  const afterCursor = text.slice(boundedCursor)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ');
  const normalized = beforeCursor + afterCursor;
  const normalizedCursor = beforeCursor.length;
  const lines: string[] = [];
  let line = '';
  let offset = 0;
  let cursorLine = 0;
  let cursorCell = 0;
  let cursorCaptured = false;
  for (const character of Array.from(normalized)) {
    if (!cursorCaptured && offset === normalizedCursor) {
      cursorLine = lines.length;
      cursorCell = terminalWidth(line);
      cursorCaptured = true;
    }
    if (character === '\n') {
      lines.push(line);
      line = '';
      offset += character.length;
      continue;
    }
    if (terminalWidth(line + character) > width && line.length > 0) {
      lines.push(line);
      line = character;
    } else {
      line += character;
    }
    offset += character.length;
  }
  if (!cursorCaptured) {
    cursorLine = lines.length;
    cursorCell = terminalWidth(line);
  }
  lines.push(line);
  const visibleCount = Math.max(1, maxLines);
  const maxStart = Math.max(0, lines.length - visibleCount);
  const visibleStart = Math.max(
    0,
    Math.min(cursorLine - Math.floor(visibleCount / 2), maxStart),
  );
  return {
    lines: lines.slice(visibleStart, visibleStart + visibleCount),
    cursorLine: cursorLine - visibleStart,
    cursorCell,
  };
}

export type BottomComposerMode = 'idle' | 'queue' | 'interrupt' | 'redirect';

export interface BottomComposerSurface {
  draft: string;
  mode: BottomComposerMode;
  cursorIndex?: number;
}

type ComposerSource = string | BottomComposerSurface;

interface RenderedSurface {
  lines: string[];
  laneRows: number;
  cursorRow: number;
  cursorCol: number;
}

function normalizeComposer(source: ComposerSource): BottomComposerSurface {
  return typeof source === 'string'
    ? { draft: source, mode: 'idle' }
    : source;
}

function modeTitle(mode: BottomComposerMode): string {
  if (mode === 'idle') return '▲ You';
  if (mode === 'queue') return '▲ You · queue mode';
  if (mode === 'interrupt') return '▲ You · interrupt mode';
  return '▲ You · steer mode';
}

export function renderBottomSurface(
  rows: number,
  cols: number,
  composerSource: ComposerSource,
  status: string,
): RenderedSurface {
  const composer = normalizeComposer(composerSource);
  // Leave the final physical cell unused so Windows ConPTY never enters its
  // pending-wrap state after painting a border or status row.
  const outerWidth = Math.max(8, cols - 1);
  const innerWidth = Math.max(1, outerWidth - 4);
  const maxContentLines = Math.max(1, rows - 4);
  const wrapped = wrapDraft(
    composer.draft,
    innerWidth,
    maxContentLines,
    composer.cursorIndex,
  );
  const content = wrapped.lines;
  const laneRows = Math.min(rows - 1, content.length + 3);
  const title = modeTitle(composer.mode);
  const titleRoom = Math.max(1, outerWidth - 5);
  const fittedTitle = terminalWidth(title) <= titleRoom ? title : fitStatus(title, titleRoom);
  const topPrefix = `╭─ ${fittedTitle} `;
  const top = `${topPrefix}${'─'.repeat(Math.max(0, outerWidth - terminalWidth(topPrefix) - 1))}╮`;
  const body = content.map((line) => `│ ${padVisible(line, innerWidth)} │`);
  const bottom = `╰${'─'.repeat(Math.max(0, outerWidth - 2))}╯`;
  const fittedStatus = fitStatus(status, outerWidth);
  const topRow = rows - laneRows + 1;
  return {
    lines: [top, ...body, bottom, fittedStatus],
    laneRows,
    cursorRow: topRow + 1 + wrapped.cursorLine,
    cursorCol: Math.min(outerWidth - 1, 3 + wrapped.cursorCell),
  };
}

export interface LaneSink {
  write: (s: string) => void;
  rows: () => number;
  cols: () => number;
  onResize: (fn: () => void) => () => void;
}

export class BottomRegion {
  private active = false;
  private composerSource: ComposerSource = { draft: '', mode: 'idle' };
  private statusSource: StatusSource = '';
  private laneRows = 0;
  private lastFrame = '';
  private unsubResize: (() => void) | null = null;

  constructor(private readonly sink: LaneSink) {}

  isActive(): boolean {
    return this.active;
  }

  /** Reserve and paint the complete surface. Repeated activation is an update. */
  activate(composer: ComposerSource, status: StatusSource = this.statusSource): void {
    this.composerSource = composer;
    this.statusSource = status;
    if (!this.active) {
      this.active = true;
      this.unsubResize = this.sink.onResize(() => this.reanchor());
    }
    this.paintAll();
  }

  /** Backward-compatible composer update. */
  paint(composer: ComposerSource): void {
    if (!this.active) return;
    this.composerSource = composer;
    this.paintAll();
  }

  paintStatus(status: StatusSource): void {
    if (!this.active) return;
    this.statusSource = status;
    this.paintAll();
  }

  /**
   * Write flowing output in the scrollable transcript, then return the hardware
   * cursor to the draft insertion point without repainting or mutating draft.
   */
  writeAbove(text: string): void {
    if (!this.active) {
      this.sink.write(text);
      return;
    }
    const surface = this.surface();
    this.sink.write(
      `${RESTORE_TRANSCRIPT}${text}${SAVE_TRANSCRIPT}` +
      `${ESC}[${surface.cursorRow};${surface.cursorCol}H${ESC}[?25h`,
    );
  }

  /** Emit a control-only marker after cursor ownership is established. */
  writeAfterCursor(text: string): void {
    if (!this.active) {
      this.sink.write(text);
      return;
    }
    const surface = this.surface();
    this.sink.write(
      `${ESC}[${surface.cursorRow};${surface.cursorCol}H${ESC}[?25h${text}`,
    );
  }

  private surface(): RenderedSurface {
    const rawStatus = typeof this.statusSource === 'function'
      ? this.statusSource()
      : this.statusSource;
    return renderBottomSurface(
      this.sink.rows(),
      this.sink.cols(),
      this.composerSource,
      rawStatus,
    );
  }

  private clearOwnedRows(count: number): string {
    let sequence = '';
    for (let offset = Math.max(1, count) - 1; offset >= 0; offset -= 1) {
      sequence += `${ESC}[${Math.max(1, this.sink.rows() - offset)};1H${ESC}[2K`;
    }
    return sequence;
  }

  private establishGeometry(nextRows: number): string {
    if (this.laneRows === nextRows && this.laneRows > 0) return '';
    const previousRows = this.laneRows;
    this.laneRows = nextRows;
    if (previousRows === 0) {
      // Make physical room before reserving the footer. Painting directly over
      // the last rows would destroy startup/transcript content already there.
      // Line feeds at the full-screen bottom move those rows into normal
      // scrollback and leave clean cells for the new fixed surface.
      return `${ESC}[r${ESC}[${this.sink.rows()};1H${'\n'.repeat(nextRows)}` +
        `${reserveSeq(this.sink.rows(), nextRows)}${SAVE_TRANSCRIPT}`;
    }
    const growth = Math.max(0, nextRows - previousRows);
    const previousTranscriptBottom = Math.max(1, this.sink.rows() - previousRows);
    // When a wrapped draft grows upward, scroll transcript rows before claiming
    // the additional cells. This preserves the newest transcript content above
    // the composer instead of erasing it during the geometry change.
    const makeRoom = growth > 0
      ? `${ESC}[${previousTranscriptBottom};1H${'\n'.repeat(growth)}`
      : '';
    return `${RESTORE_TRANSCRIPT}${makeRoom}${ESC}[r` +
      `${this.clearOwnedRows(Math.max(previousRows, nextRows))}` +
      `${reserveSeq(this.sink.rows(), nextRows)}${SAVE_TRANSCRIPT}`;
  }

  private paintAll(): void {
    if (!this.active) return;
    const surface = this.surface();
    const frame = surface.lines.join('\n');
    const geometry = this.establishGeometry(surface.laneRows);
    if (!geometry && frame === this.lastFrame) {
      this.sink.write(`${ESC}[${surface.cursorRow};${surface.cursorCol}H${ESC}[?25h`);
      return;
    }
    this.lastFrame = frame;
    const topRow = this.sink.rows() - surface.laneRows + 1;
    let sequence = geometry;
    surface.lines.forEach((line, index) => {
      sequence += `${ESC}[${topRow + index};1H${ESC}[2K${line}`;
    });
    sequence += `${ESC}[${surface.cursorRow};${surface.cursorCol}H${ESC}[?25h`;
    this.sink.write(sequence);
  }

  private reanchor(): void {
    if (!this.active) return;
    this.lastFrame = '';
    const previousRows = this.laneRows;
    this.laneRows = 0;
    this.sink.write(`${RESTORE_TRANSCRIPT}${ESC}[r${this.clearOwnedRows(previousRows)}`);
    this.paintAll();
  }

  /** Release and clear the complete surface exactly once. */
  deactivate(): void {
    if (!this.active) return;
    this.sink.write(
      `${RESTORE_TRANSCRIPT}${ESC}[r${this.clearOwnedRows(this.laneRows)}`,
    );
    this.unsubResize?.();
    this.unsubResize = null;
    this.active = false;
    this.laneRows = 0;
    this.lastFrame = '';
  }
}

/** Existing importer compatibility. */
export { BottomRegion as ComposerLane };

export function composerLaneEnabled(): boolean {
  return process.env.AIDEN_COMPOSER_LANE !== '0';
}
