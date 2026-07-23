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
  ) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.scrollBottom = this.height - 1;
    this.cells = this.blankScreen();
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
    const next = Array.from({ length: nextHeight }, (_, row) => (
      Array.from({ length: nextWidth }, (_, col) => this.cells[row]?.[col] ?? ' ')
    ));
    this.width = nextWidth;
    this.height = nextHeight;
    this.cells = next;
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

  snapshot(): string {
    const lines = this.lines();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  private blankScreen(): string[][] {
    return Array.from(
      { length: this.height },
      () => Array.from({ length: this.width }, () => ' '),
    );
  }

  private applyCsi(rawParams: string, final: string): void {
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
        if (first === 2 || first === 3) this.cells = this.blankScreen();
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
  }

  private put(ch: string): void {
    if (this.col >= this.width) {
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
      this.cells.splice(this.scrollTop, 1);
      this.cells.splice(
        this.scrollBottom,
        0,
        Array.from({ length: this.width }, () => ' '),
      );
      return;
    }
    this.row = Math.min(this.height - 1, this.row + 1);
  }

  private clampCursor(): void {
    this.row = Math.min(this.height - 1, Math.max(0, this.row));
    this.col = Math.min(this.width - 1, Math.max(0, this.col));
  }
}
