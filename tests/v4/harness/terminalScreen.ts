/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

/**
 * Small ANSI terminal screen model for CLI acceptance tests.
 *
 * It intentionally implements only the cursor, erase, scroll-region and resize
 * operations emitted by the v4 CLI. Assertions use the rendered screen rather
 * than treating terminal control bytes as an append-only transcript.
 */
export class TerminalScreen {
  private cells: string[][];
  private wrappedRows: boolean[];
  private readonly scrollback: string[][] = [];
  private readonly scrollbackWrappedRows: boolean[] = [];
  private readonly reviewableMainRows: string[] = [];
  private alternateBuffer = false;
  private hostSnapshotRedraw = false;
  private mainBuffer: {
    cells: string[][];
    wrappedRows: boolean[];
    row: number;
    col: number;
    savedRow: number;
    savedCol: number;
    scrollTop: number;
    scrollBottom: number;
  } | null = null;
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;
  private scrollTop = 0;
  private scrollBottom: number;
  private pending = '';

  constructor(
    private width: number,
    private height: number,
    private readonly options: { retainResizeHistory?: boolean } = {},
  ) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.scrollBottom = this.height - 1;
    this.cells = this.blankScreen();
    this.wrappedRows = Array.from({ length: this.height }, () => false);
  }

  write(chunk: string | Buffer): void {
    const input = this.pending + chunk.toString();
    this.pending = '';

    for (let i = 0; i < input.length;) {
      const ch = input[i];

      if (ch === '\x1b') {
        if (i + 1 >= input.length) {
          this.pending = input.slice(i);
          break;
        }

        const next = input[i + 1];
        if (next === '[') {
          const match = /^\x1b\[([?0-9;]*)([A-Za-z])/u.exec(input.slice(i));
          if (!match) {
            this.pending = input.slice(i);
            break;
          }
          this.applyCsi(match[1], match[2]);
          i += match[0].length;
          continue;
        }

        if (next === ']') {
          const bell = input.indexOf('\x07', i + 2);
          const stringTerminator = input.indexOf('\x1b\\', i + 2);
          const end = bell >= 0 && (stringTerminator < 0 || bell < stringTerminator)
            ? bell + 1
            : stringTerminator >= 0
              ? stringTerminator + 2
              : -1;
          if (end < 0) {
            this.pending = input.slice(i);
            break;
          }
          i = end;
          continue;
        }

        if (next === '7') {
          this.savedRow = this.row;
          this.savedCol = this.col;
        } else if (next === '8') {
          this.row = this.savedRow;
          this.col = this.savedCol;
          this.clampCursor();
        }
        i += 2;
        continue;
      }

      if (ch === '\r') {
        this.col = 0;
      } else if (ch === '\n') {
        this.lineFeed();
      } else if (ch === '\b') {
        this.col = Math.max(0, this.col - 1);
      } else if (ch >= ' ') {
        this.put(ch);
      }
      i += 1;
    }
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    if (!this.alternateBuffer && !this.options.retainResizeHistory
      && (nextWidth !== this.width || nextHeight !== this.height)) {
      this.rememberReviewableRows([
        ...this.scrollback.map((line) => line.join('').trimEnd()),
        ...this.cells.map((line) => line.join('').trimEnd()),
      ]);
    }
    if (!this.alternateBuffer && this.options.retainResizeHistory
      && (nextWidth !== this.width || nextHeight !== this.height)) {
      this.reflowMainBuffer(nextWidth, nextHeight);
      return;
    }
    const next = Array.from({ length: nextHeight }, (_, row) => (
      Array.from({ length: nextWidth }, (_, col) => this.cells[row]?.[col] ?? ' ')
    ));
    this.width = nextWidth;
    this.height = nextHeight;
    this.cells = next;
    this.wrappedRows = Array.from(
      { length: nextHeight },
      (_, row) => this.wrappedRows[row] ?? false,
    );
    this.scrollTop = 0;
    this.scrollBottom = nextHeight - 1;
    this.clampCursor();
  }

  lines(): string[] {
    return this.cells.map((line) => line.join('').trimEnd());
  }

  bottomLine(): string {
    return this.lines()[this.height - 1] ?? '';
  }

  cursorPosition(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }

  snapshot(): string {
    const lines = this.lines();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /** Main-buffer history plus the current viewport; alternate buffers have no scrollback. */
  bufferSnapshot(): string {
    if (this.alternateBuffer) return this.snapshot();
    const lines = [
      ...this.scrollback.map((line) => line.join('').trimEnd()),
      ...this.lines(),
    ];
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  scrollbackSnapshot(): string {
    return this.scrollback.map((line) => line.join('').trimEnd()).join('\n');
  }

  /** Logical main-buffer rows retained across host reflow for scrollback assertions. */
  reviewableSnapshot(): string {
    return this.reviewableMainRows.join('\n');
  }

  activeComposerSurfaces(): Array<{
    topSeparatorRow: number;
    labelRow: number;
    bottomSeparatorRow: number;
    footerRow: number;
  }> {
    const lines = this.lines();
    const surfaces: Array<{
      topSeparatorRow: number;
      labelRow: number;
      bottomSeparatorRow: number;
      footerRow: number;
    }> = [];
    const isSeparator = (line: string): boolean => /^(?:─{20,}|-{20,})$/u.test(line);
    const isLabel = (line: string): boolean => /^(?:▲|>) You(?: · queue mode)?$/u.test(line);
    const isDivider = (line: string): boolean => /^(?:─{21}|-{21})$/u.test(line);
    const isFooter = (line: string): boolean => /^(?:◆|\*)/u.test(line);

    for (let labelRow = 1; labelRow < lines.length - 3; labelRow += 1) {
      if (!isLabel(lines[labelRow]) || !isSeparator(lines[labelRow - 1])
        || !isDivider(lines[labelRow + 1])) continue;
      for (let bottomSeparatorRow = labelRow + 2;
        bottomSeparatorRow < lines.length - 1;
        bottomSeparatorRow += 1) {
        if (!isSeparator(lines[bottomSeparatorRow])
          || !isFooter(lines[bottomSeparatorRow + 1])) continue;
        surfaces.push({
          topSeparatorRow: labelRow - 1,
          labelRow,
          bottomSeparatorRow,
          footerRow: bottomSeparatorRow + 1,
        });
        break;
      }
    }
    return surfaces;
  }

  /**
   * Removes the old volatile bottom surface from a Windows host snapshot.
   * Durable prompts are indented transcript rows and never have an adjacent
   * runtime footer, so they are deliberately excluded.
   */
  discardHostSnapshotComposer(): boolean {
    const lines = this.lines();
    const divider = /^(?:─{21}|-{21})$/u;
    let startsAt = -1;
    for (let row = 0; row < lines.length; row += 1) {
      const marker = lines[row].includes('▲ You') || lines[row].includes('> You');
      if (!marker) continue;
      const embeddedAfterSeparator = /(?:─{20,}|-{20,})\s*(?:▲|>) You/u.test(lines[row]);
      const standalone = /^(?:▲|>) You(?: · queue mode)?$/u.test(lines[row]);
      if (!embeddedAfterSeparator && !(standalone && divider.test(lines[row + 1] ?? ''))) {
        continue;
      }
      const prior = lines[row - 1] ?? '';
      startsAt = /^(?:─+|-+)$/u.test(prior) ? row - 1 : row;
      break;
    }
    if (startsAt < 0) return false;

    for (let row = startsAt; row < this.height; row += 1) {
      this.cells[row] = Array.from({ length: this.width }, () => ' ');
      this.wrappedRows[row] = false;
    }
    this.row = Math.max(0, startsAt);
    this.col = 0;
    return true;
  }

  private blankScreen(): string[][] {
    return Array.from(
      { length: this.height },
      () => Array.from({ length: this.width }, () => ' '),
    );
  }

  private applyCsi(rawParams: string, final: string): void {
    if (rawParams === '?25' && (final === 'l' || final === 'h')) return;
    if (rawParams === '?1049' && final === 'h') {
      this.enterAlternateBuffer();
      return;
    }
    if (rawParams === '?1049' && final === 'l') {
      this.leaveAlternateBuffer();
      return;
    }
    const params = rawParams.replace(/^\?/u, '').split(';').map((value) => (
      value === '' ? 0 : Number.parseInt(value, 10)
    ));
    const first = params[0] ?? 0;
    const amount = Math.max(1, first || 1);

    switch (final) {
      case 'A':
        this.row -= amount;
        break;
      case 'B':
        this.row += amount;
        break;
      case 'C':
        this.col += amount;
        break;
      case 'D':
        this.col -= amount;
        break;
      case 'G':
        this.col = Math.max(0, amount - 1);
        break;
      case 'H':
      case 'f':
        this.row = Math.max(0, (params[0] || 1) - 1);
        this.col = Math.max(0, (params[1] || 1) - 1);
        break;
      case 'J':
        // Windows documents ED 0, 1 and 2. ED 3 is not a reliable way to
        // erase terminal-owned scrollback in the classic console host.
        if (first === 0) {
          for (let col = this.col; col < this.width; col += 1) {
            this.cells[this.row][col] = ' ';
          }
          this.wrappedRows[this.row] = false;
          for (let row = this.row + 1; row < this.height; row += 1) {
            this.cells[row] = Array.from({ length: this.width }, () => ' ');
            this.wrappedRows[row] = false;
          }
        } else if (first === 1) {
          for (let row = 0; row < this.row; row += 1) {
            this.cells[row] = Array.from({ length: this.width }, () => ' ');
            this.wrappedRows[row] = false;
          }
          for (let col = 0; col <= this.col; col += 1) {
            this.cells[this.row][col] = ' ';
          }
        } else if (first === 2) {
          this.cells = this.blankScreen();
          this.wrappedRows = Array.from({ length: this.height }, () => false);
        }
        break;
      case 'K':
        this.eraseLine(first);
        break;
      case 'r':
        if (rawParams === '') {
          this.scrollTop = 0;
          this.scrollBottom = this.height - 1;
        } else {
          this.scrollTop = Math.max(0, (params[0] || 1) - 1);
          this.scrollBottom = Math.min(this.height - 1, (params[1] || this.height) - 1);
          if (this.scrollBottom < this.scrollTop) {
            this.scrollTop = 0;
            this.scrollBottom = this.height - 1;
          }
        }
        this.row = 0;
        this.col = 0;
        break;
      case 's':
        this.savedRow = this.row;
        this.savedCol = this.col;
        break;
      case 'u':
        this.row = this.savedRow;
        this.col = this.savedCol;
        break;
      default:
        break;
    }
    this.clampCursor();
  }

  private eraseLine(mode: number): void {
    const start = mode === 1 || mode === 2 ? 0 : this.col;
    const end = mode === 0 || mode === 2 ? this.width : this.col + 1;
    for (let col = start; col < end; col += 1) this.cells[this.row][col] = ' ';
    if (mode === 2) this.wrappedRows[this.row] = false;
  }

  private put(ch: string): void {
    if (this.col >= this.width) {
      this.wrappedRows[this.row] = true;
      this.col = 0;
      this.lineFeed();
    }
    this.cells[this.row][this.col] = ch;
    this.col += 1;
  }

  private lineFeed(): void {
    // Windows ConPTY applies output newline processing for CLI writes, so LF
    // advances to the next line at column one.
    this.col = 0;
    if (this.row === this.scrollBottom) {
      const removed = this.cells.splice(this.scrollTop, 1)[0];
      const removedWrapped = this.wrappedRows.splice(this.scrollTop, 1)[0] ?? false;
      if (!this.alternateBuffer && this.scrollTop === 0
        && !this.hostSnapshotRedraw
        && this.scrollBottom === this.height - 1 && removed) {
        this.scrollback.push([...removed]);
        this.scrollbackWrappedRows.push(removedWrapped);
      }
      this.cells.splice(
        this.scrollBottom,
        0,
        Array.from({ length: this.width }, () => ' '),
      );
      this.wrappedRows.splice(this.scrollBottom, 0, false);
      return;
    }
    this.row = Math.min(this.height - 1, this.row + 1);
  }

  private clampCursor(): void {
    this.row = Math.min(this.height - 1, Math.max(0, this.row));
    this.col = Math.min(this.width - 1, Math.max(0, this.col));
  }

  private reflowMainBuffer(nextWidth: number, nextHeight: number): void {
    const physicalRows = [
      ...this.scrollback.map((line, index) => ({
        text: (this.scrollbackWrappedRows[index] ?? false)
          ? line.join('')
          : line.join('').trimEnd(),
        wrapped: this.scrollbackWrappedRows[index] ?? false,
      })),
      ...this.cells.map((line, index) => ({
        text: (this.wrappedRows[index] ?? false)
          ? line.join('')
          : line.join('').trimEnd(),
        wrapped: this.wrappedRows[index] ?? false,
      })),
    ];
    const cursorPhysicalRow = this.scrollback.length + this.row;
    const savedPhysicalRow = this.scrollback.length + this.savedRow;
    const logicalRows: Array<{
      text: string;
      sourceStart: number;
      sourceEnd: number;
    }> = [];
    let logicalText = '';
    let logicalStart = 0;
    for (let index = 0; index < physicalRows.length; index += 1) {
      if (logicalText.length === 0) logicalStart = index;
      logicalText += physicalRows[index].text;
      if (!physicalRows[index].wrapped) {
        logicalRows.push({ text: logicalText, sourceStart: logicalStart, sourceEnd: index });
        logicalText = '';
      }
    }
    if (logicalText.length > 0) {
      logicalRows.push({
        text: logicalText,
        sourceStart: logicalStart,
        sourceEnd: physicalRows.length - 1,
      });
    }
    this.rememberReviewableRows(logicalRows.map(({ text }) => text));
    const locateCursor = (physicalRow: number, column: number): {
      logicalIndex: number;
      offset: number;
    } => {
      const logicalIndex = Math.max(0, logicalRows.findIndex(({ sourceStart, sourceEnd }) => (
        physicalRow >= sourceStart && physicalRow <= sourceEnd
      )));
      const logical = logicalRows[logicalIndex];
      const rowsBefore = Math.max(0, physicalRow - logical.sourceStart);
      return { logicalIndex, offset: rowsBefore * this.width + column };
    };
    const cursor = locateCursor(cursorPhysicalRow, this.col);
    const saved = locateCursor(savedPhysicalRow, this.savedCol);
    const reflowed: Array<{ text: string; wrapped: boolean; logicalIndex: number }> = [];
    const logicalStarts: number[] = [];
    logicalRows.forEach((logical, logicalIndex) => {
      logicalStarts[logicalIndex] = reflowed.length;
      if (logical.text.length === 0) {
        reflowed.push({ text: '', wrapped: false, logicalIndex });
        return;
      }
      for (let offset = 0; offset < logical.text.length; offset += nextWidth) {
        const text = logical.text.slice(offset, offset + nextWidth);
        reflowed.push({
          text,
          wrapped: offset + nextWidth < logical.text.length,
          logicalIndex,
        });
      }
    });
    const nextCursorPhysical = (logicalStarts[cursor.logicalIndex] ?? 0)
      + Math.floor(cursor.offset / nextWidth);
    const nextSavedPhysical = (logicalStarts[saved.logicalIndex] ?? 0)
      + Math.floor(saved.offset / nextWidth);
    const historyCount = Math.max(0, reflowed.length - nextHeight);
    const viewport = reflowed.slice(historyCount);
    const history = reflowed.slice(0, historyCount);
    this.scrollback.splice(0, this.scrollback.length, ...history.map(({ text }) => (
      Array.from({ length: nextWidth }, (_, col) => text[col] ?? ' ')
    )));
    this.scrollbackWrappedRows.splice(
      0,
      this.scrollbackWrappedRows.length,
      ...history.map(({ wrapped }) => wrapped),
    );
    this.width = nextWidth;
    this.height = nextHeight;
    this.cells = Array.from({ length: nextHeight }, (_, row) => {
      const sourceLine = viewport[row - (nextHeight - viewport.length)]?.text ?? '';
      return Array.from({ length: nextWidth }, (_, col) => sourceLine[col] ?? ' ');
    });
    this.wrappedRows = Array.from(
      { length: nextHeight },
      (_, row) => viewport[row - (nextHeight - viewport.length)]?.wrapped ?? false,
    );
    this.row = Math.min(nextHeight - 1, Math.max(0, nextCursorPhysical - historyCount));
    this.col = Math.min(nextWidth - 1, Math.max(0, cursor.offset % nextWidth));
    this.savedRow = Math.min(nextHeight - 1, Math.max(0, nextSavedPhysical - historyCount));
    this.savedCol = Math.min(nextWidth - 1, Math.max(0, saved.offset % nextWidth));
    this.scrollTop = 0;
    this.scrollBottom = nextHeight - 1;
  }

  private rememberReviewableRows(lines: string[]): void {
    for (const line of lines) {
      const key = line.trim();
      if (key === '') continue;
      const existingIndex = this.reviewableMainRows.findIndex((existing) => (
        existing.trim() === key
        || existing.trim().startsWith(key)
        || key.startsWith(existing.trim())
      ));
      if (existingIndex < 0) {
        this.reviewableMainRows.push(line);
      } else if (line.length > this.reviewableMainRows[existingIndex].length) {
        this.reviewableMainRows[existingIndex] = line;
      }
    }
  }

  private enterAlternateBuffer(): void {
    if (this.alternateBuffer) return;
    this.mainBuffer = {
      cells: this.cells.map((line) => [...line]),
      wrappedRows: [...this.wrappedRows],
      row: this.row,
      col: this.col,
      savedRow: this.savedRow,
      savedCol: this.savedCol,
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
    };
    this.alternateBuffer = true;
    this.cells = this.blankScreen();
    this.wrappedRows = Array.from({ length: this.height }, () => false);
    this.row = 0;
    this.col = 0;
    this.savedRow = 0;
    this.savedCol = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.height - 1;
  }

  private leaveAlternateBuffer(): void {
    if (!this.alternateBuffer) return;
    const main = this.mainBuffer;
    this.alternateBuffer = false;
    this.mainBuffer = null;
    if (!main) {
      this.cells = this.blankScreen();
      this.wrappedRows = Array.from({ length: this.height }, () => false);
      this.row = 0;
      this.col = 0;
      this.scrollTop = 0;
      this.scrollBottom = this.height - 1;
      return;
    }
    this.cells = main.cells;
    this.wrappedRows = main.wrappedRows;
    this.row = main.row;
    this.col = main.col;
    this.savedRow = main.savedRow;
    this.savedCol = main.savedCol;
    this.scrollTop = main.scrollTop;
    this.scrollBottom = main.scrollBottom;
    this.resize(this.width, this.height);
    this.clampCursor();
  }

  /**
   * Prepare for the authoritative full-viewport redraw emitted by Windows
   * ConPTY after a host resize. The redraw itself performs reflow; applying
   * synthetic reflow here as well would duplicate volatile rows.
   */
  prepareHostResize(width: number, height: number): void {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    if (!this.alternateBuffer) {
      this.rememberReviewableRows([
        ...this.scrollback.map((line) => line.join('').trimEnd()),
        ...this.cells.map((line) => line.join('').trimEnd()),
      ]);
    }
    this.width = nextWidth;
    this.height = nextHeight;
    this.cells = this.blankScreen();
    this.wrappedRows = Array.from({ length: nextHeight }, () => false);
    this.row = 0;
    this.col = 0;
    this.savedRow = 0;
    this.savedCol = 0;
    this.scrollTop = 0;
    this.scrollBottom = nextHeight - 1;
    this.hostSnapshotRedraw = true;
  }

  completeHostResizeSnapshot(): void {
    this.hostSnapshotRedraw = false;
  }
}
