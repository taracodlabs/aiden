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

import {
  activeActivityRows,
  initialOperatorProjection,
  reduceOperatorProjection,
  transcriptSource,
  type OperatorActivityState,
  type OperatorProjectionState,
} from './operatorProjection';

const ESC = '\x1b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const SAVE_TRANSCRIPT = `${ESC}[s`;
const RESTORE_TRANSCRIPT = `${ESC}[u`;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidth: (value: string) => number = require('string-width');
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const TERMINAL_CONTROL_PATTERN = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[?0-9;]*[A-Za-z]|[78])/gu;

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

function wrapTranscriptText(text: string, width: number): string[] {
  const plain = text.replace(TERMINAL_CONTROL_PATTERN, '').replace(/\r/g, '');
  const rows: string[] = [];
  for (const logical of plain.split('\n')) {
    let row = '';
    for (const character of Array.from(logical)) {
      if (row && terminalWidth(row + character) > width) {
        rows.push(row);
        row = character;
      } else {
        row += character;
      }
    }
    rows.push(row);
  }
  if (plain.endsWith('\n')) rows.pop();
  return rows;
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

interface SurfaceGeometry {
  rows: number;
  cols: number;
  laneRows: number;
  topRow: number;
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
  private geometry: SurfaceGeometry | null = null;
  private resizeBurstActive = false;
  private trailingResize: ReturnType<typeof setImmediate> | null = null;
  private renderGeneration = 0;
  private projection: OperatorProjectionState = initialOperatorProjection();
  private projectionIdentity = 0;
  private static readonly MAX_TRANSCRIPT_CHARS = 250_000;

  constructor(private readonly sink: LaneSink) {}

  isActive(): boolean {
    return this.active;
  }

  /** Reserve and paint the complete surface. Repeated activation is an update. */
  activate(composer: ComposerSource, status: StatusSource = this.statusSource): void {
    this.composerSource = composer;
    this.statusSource = status;
    const resumingOwnership = !this.active;
    if (!this.active) {
      this.active = true;
      this.unsubResize = this.sink.onResize(() => this.onResize());
    }
    this.paintAll(resumingOwnership && this.projection.transcript.length > 0);
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

  /** Project one identity-backed live row above the composer. */
  setLiveRow(id: string, text: string): void {
    const normalized = text.replace(/\r?\n$/u, '');
    const current = this.projection.activities[id];
    const next = reduceOperatorProjection(this.projection, current
      ? { type: 'activity.progress', id, generation: current.generation, summary: normalized }
      : {
          type: 'activity.upsert',
          activity: {
            id, parentId: null, jobId: null, attemptId: null, generation: 0,
            startedSequence: this.projection.eventSequence + 1,
            state: 'running', startedAt: Date.now(), endedAt: null,
            summary: normalized, detailsRef: null,
          },
        });
    if (next === this.projection) return;
    this.projection = next;
    if (this.active) this.paintAll();
  }

  /** Hide a live row without adding it to transcript history. */
  removeLiveRow(id: string): void {
    const next = reduceOperatorProjection(this.projection, { type: 'activity.remove', id });
    if (next === this.projection) return;
    this.projection = next;
    if (this.active) this.paintAll();
  }

  /** Replace a live row with its final transcript row exactly once. */
  settleLiveRow(
    id: string,
    text: string,
    state: Extract<OperatorActivityState,
      'succeeded' | 'failed' | 'denied' | 'interrupted' | 'cancelled' | 'timed_out' | 'unknown' | 'stale'> = 'succeeded',
  ): void {
    const current = this.projection.activities[id];
    if (current) {
      this.projection = reduceOperatorProjection(this.projection, {
        type: 'activity.terminal', id, generation: current.generation,
        state, summary: text, endedAt: Date.now(),
      });
      this.projection = reduceOperatorProjection(this.projection, { type: 'activity.remove', id });
    }
    const terminal = text.endsWith('\n') ? text : `${text}\n`;
    this.recordTranscript(terminal);
    if (!this.active) {
      this.sink.write(terminal);
      return;
    }
    this.sink.write(`${RESTORE_TRANSCRIPT}${terminal}${SAVE_TRANSCRIPT}`);
    this.paintAll();
  }

  /** Move the transcript viewport away from or toward the live tail. */
  scrollTranscript(deltaRows: number): void {
    this.projection = reduceOperatorProjection(this.projection, {
      type: 'viewport.scroll', delta: deltaRows,
    });
    if (this.active) this.paintAll(true);
  }

  /** Return transcript projection to sticky-tail mode. */
  followTranscript(): void {
    this.projection = reduceOperatorProjection(this.projection, { type: 'viewport.follow' });
    if (this.active) this.paintAll(true);
  }

  newEventsBelow(): number {
    return this.projection.newEventsBelow;
  }

  /** Clear only the visual transcript; durable/session state is untouched. */
  clearTranscript(): void {
    this.projection = reduceOperatorProjection(this.projection, { type: 'transcript.clear' });
    if (this.active) this.paintAll(true);
  }

  /**
   * Write flowing output in the scrollable transcript, then return the hardware
   * cursor to the draft insertion point without repainting or mutating draft.
   */
  writeAbove(text: string): void {
    this.recordTranscript(text);
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
    const composer = renderBottomSurface(
      this.sink.rows(),
      this.sink.cols(),
      this.composerSource,
      rawStatus,
    );
    const availableWidth = Math.max(1, this.sink.cols() - 1);
    const allLive = activeActivityRows(this.projection).flatMap((activity) => (
      activity.summary.split('\n').map((line) => fitStatus(line, availableWidth))
    ));
    const maxLiveRows = Math.max(0, this.sink.rows() - composer.laneRows);
    const hiddenLiveRows = Math.max(0, allLive.length - maxLiveRows);
    const live = hiddenLiveRows > 0 && maxLiveRows > 0
      ? [fitStatus(`… ${hiddenLiveRows + 1} more active`, availableWidth), ...allLive.slice(-(maxLiveRows - 1))]
      : maxLiveRows === 0 ? [] : allLive.slice(-maxLiveRows);
    return {
      lines: [...live, ...composer.lines],
      laneRows: composer.laneRows + live.length,
      cursorRow: composer.cursorRow,
      cursorCol: composer.cursorCol,
    };
  }

  private recordTranscript(text: string): void {
    const semantic = text.replace(TERMINAL_CONTROL_PATTERN, '');
    if (!/[^\s]/u.test(semantic)) return;
    this.projection = reduceOperatorProjection(this.projection, {
      type: 'transcript.append',
      id: `transcript:${++this.projectionIdentity}`,
      kind: 'system',
      sourceText: text,
    });
    let transcript = transcriptSource(this.projection);
    if (transcript.length > BottomRegion.MAX_TRANSCRIPT_CHARS) {
      transcript = transcript.slice(-BottomRegion.MAX_TRANSCRIPT_CHARS);
      this.projection = {
        ...this.projection,
        transcript: [{
          id: `transcript:${++this.projectionIdentity}`,
          kind: 'system',
          sourceText: transcript,
          sequence: this.projection.eventSequence,
        }],
      };
    }
  }

  private transcriptFrame(surface: RenderedSurface): string {
    const bottom = Math.max(0, this.sink.rows() - surface.laneRows);
    if (bottom === 0) return '';
    const width = Math.max(1, this.sink.cols() - 1);
    const rows = wrapTranscriptText(transcriptSource(this.projection), width);
    const end = Math.max(0, rows.length - this.projection.scrollOffset);
    const visible = rows.slice(Math.max(0, end - bottom), end);
    if (!this.projection.followTail && bottom > 0) {
      const indicator = this.projection.newEventsBelow > 0
        ? `↓ ${this.projection.newEventsBelow} new events below · End to follow`
        : '↓ End to follow live output';
      if (visible.length === bottom) visible[visible.length - 1] = indicator;
      else visible.push(indicator);
    }
    const start = bottom - visible.length + 1;
    let sequence = '';
    for (let row = 1; row <= bottom; row += 1) {
      sequence += `${ESC}[${row};1H${ESC}[2K`;
    }
    visible.forEach((line, index) => {
      sequence += `${ESC}[${start + index};1H${fitStatus(line, width)}`;
    });
    return sequence;
  }

  private clearOwnedRows(count: number): string {
    let sequence = '';
    for (let offset = Math.max(1, count) - 1; offset >= 0; offset -= 1) {
      sequence += `${ESC}[${Math.max(1, this.sink.rows() - offset)};1H${ESC}[2K`;
    }
    return sequence;
  }

  private clearDamagedUnion(previous: SurfaceGeometry | null, next: SurfaceGeometry): string {
    const physicalRows = this.sink.rows();
    const rows = new Set<number>();
    const add = (geometry: SurfaceGeometry | null): void => {
      if (!geometry) return;
      for (let row = geometry.topRow; row <= geometry.rows; row += 1) {
        if (row >= 1 && row <= physicalRows) rows.add(row);
      }
    };
    add(previous);
    add(next);
    return [...rows]
      .sort((a, b) => a - b)
      .map((row) => `${ESC}[${row};1H${ESC}[2K`)
      .join('');
  }

  private establishGeometry(nextRows: number): string {
    const physicalRows = this.sink.rows();
    const physicalCols = this.sink.cols();
    const nextGeometry: SurfaceGeometry = {
      rows: physicalRows,
      cols: physicalCols,
      laneRows: nextRows,
      topRow: Math.max(1, physicalRows - nextRows + 1),
    };
    const previousGeometry = this.geometry;
    const dimensionsChanged = previousGeometry !== null && (
      previousGeometry.rows !== physicalRows || previousGeometry.cols !== physicalCols
    );
    if (this.laneRows === nextRows && this.laneRows > 0 && !dimensionsChanged) return '';
    const previousRows = this.laneRows;
    this.laneRows = nextRows;
    this.geometry = nextGeometry;
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
    const clear = dimensionsChanged
      ? this.clearDamagedUnion(previousGeometry, nextGeometry)
      : this.clearOwnedRows(Math.max(previousRows, nextRows));
    return `${RESTORE_TRANSCRIPT}${makeRoom}${ESC}[r` +
      `${clear}` +
      `${reserveSeq(this.sink.rows(), nextRows)}${SAVE_TRANSCRIPT}`;
  }

  private paintAll(rebuildTranscript = false): void {
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
    if (rebuildTranscript) sequence += this.transcriptFrame(surface);
    surface.lines.forEach((line, index) => {
      sequence += `${ESC}[${topRow + index};1H${ESC}[2K${line}`;
    });
    sequence += `${ESC}[${surface.cursorRow};${surface.cursorCol}H${ESC}[?25h`;
    this.sink.write(sequence);
  }

  private reanchor(): void {
    if (!this.active) return;
    const generation = ++this.renderGeneration;
    this.lastFrame = '';
    this.paintAll(true);
    if (generation !== this.renderGeneration) return;
  }

  private onResize(): void {
    if (!this.active) return;
    if (!this.resizeBurstActive) {
      this.resizeBurstActive = true;
      this.reanchor();
    }
    if (this.trailingResize) clearImmediate(this.trailingResize);
    this.trailingResize = setImmediate(() => {
      this.trailingResize = null;
      this.resizeBurstActive = false;
      this.reanchor();
    });
  }

  /** Release and clear the complete surface exactly once. */
  deactivate(): void {
    if (!this.active) return;
    this.sink.write(
      `${RESTORE_TRANSCRIPT}${ESC}[r${this.clearOwnedRows(this.laneRows)}`,
    );
    this.unsubResize?.();
    this.unsubResize = null;
    if (this.trailingResize) clearImmediate(this.trailingResize);
    this.trailingResize = null;
    this.resizeBurstActive = false;
    this.active = false;
    this.laneRows = 0;
    this.geometry = null;
    this.lastFrame = '';
  }
}

/** Existing importer compatibility. */
export { BottomRegion as ComposerLane };

export function composerLaneEnabled(): boolean {
  return process.env.AIDEN_COMPOSER_LANE !== '0';
}
