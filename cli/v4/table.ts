/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/table.ts — lightweight ASCII table renderer (Tier-3.1).
 *
 * Drop-in replacement for `Display.twoColumnBlock` style output at
 * call sites that want full multi-column tables (`/skills`,
 * `/cron list`, `/channel list`). No `cli-table3` dependency — the
 * renderer is ~150 lines, ANSI-aware via `string-width`, and uses
 * the same SkinEngine colour kinds as the rest of v4.
 *
 * Box drawing is sharp ASCII (`─ │ ┌ ┐ └ ┘ ├ ┤`) to stay aligned
 * with the rest of the v4.1-tier3.1 box pass.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidth: (s: string) => number = require('string-width');

import { getSkinEngine, ColorKind } from './skinEngine';
import { visibleLength, truncateVisible } from './box';
import { glyphs } from './design/tokens';

export type CellAlign = 'left' | 'right' | 'center';

export interface Column<T> {
  /** Object key (or computed via `format`) */
  key:        keyof T | string;
  header:     string;
  align?:     CellAlign;
  /** Custom value transformer — return the raw display string. */
  format?:    (v: any, row: T) => string;
  /** Skin colour kind for value cells (header is always heading). */
  color?:     (v: any, row: T) => ColorKind | undefined;
  /** Truncate the value to this many visible columns; ellipsised. */
  truncate?:  number;
  /** Min visible width for the column (ignored if header/value wider). */
  minWidth?:  number;
  /**
   * Tier-3.1b: when true, this column shrinks first under width
   * pressure and absorbs leftover horizontal space. When false (or
   * unset), the column gets its natural width if at all possible.
   * If no column declares `flex: true`, the LAST column is treated
   * as flex by default (description columns are the common case).
   */
  flex?:      boolean;
}

export interface RenderTableOptions {
  /** Render the header rule (`├─...─┤`)? Default true. */
  showHeaderRule?: boolean;
  /** Indent every row by this many spaces. Default 2. */
  indent?:         number;
  /**
   * Tier-3.1a: when false (default) emit a `├─...─┼─...─┤` separator
   * between each pair of data rows for stronger row delineation.
   * `compact: true` preserves the pre-tier3.1a behavior (no inter-
   * row separators).
   */
  compact?:        boolean;
  /**
   * Tier-3.1b: target maximum total width for the rendered table
   * (including the indent). Defaults to `process.stdout.columns ??
   * 100`. Columns are sized responsively up to this budget so wide
   * terminals stop wasting horizontal real estate on a fixed-width
   * description cap.
   */
  maxWidth?:       number;
  /**
   * v4.8.0 Slice 3 — embedded title in the top border.
   *   `┌─ title ──────────── totalCount ──┐`
   * `totalCount` right-aligns inside the title row (e.g. "81 skills").
   * Both fields optional; omit for the legacy borderless-title look.
   */
  title?:          string;
  totalCount?:     string;
  /**
   * v4.8.0 Slice 3 — pagination footer above the bottom border:
   *   `│ ← prev · page 2/5 · next →                              │`
   * Caller renders the page-state arrows muted; we paint the divider.
   * Omit for un-paginated tables.
   */
  page?:           { current: number; total: number };
  /**
   * v4.8.0 Slice 3 — message to render when `rows.length === 0`. The
   * full top + bottom border still paints so the empty state has the
   * same visual weight as a populated table.
   */
  emptyMessage?:   string;
}

/**
 * Visible (post-ANSI-strip) column width. Falls back to
 * `visibleLength` from box.ts when string-width is unavailable
 * (which would only happen if the dep was removed).
 */
function vWidth(s: string): number {
  try {
    return stringWidth(s);
  } catch {
    return visibleLength(s);
  }
}

/** Pad `s` to `w` visible columns using `align`. ANSI-safe. */
function pad(s: string, w: number, align: CellAlign = 'left'): string {
  const sw = vWidth(s);
  if (sw >= w) return s;
  const gap = w - sw;
  if (align === 'right')  return ' '.repeat(gap) + s;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + s + ' '.repeat(gap - l);
  }
  return s + ' '.repeat(gap);
}

/** Truncate to `max` visible columns with a single `…` tail. */
function truncCell(s: string, max: number): string {
  if (vWidth(s) <= max) return s;
  if (max <= 1) return '…';
  return truncateVisible(s, max - 1) + '…';
}

/** Resolve a column's display string for one row. */
function cellValue<T>(row: T, col: Column<T>): string {
  const raw = (row as any)[col.key as string];
  const v = col.format ? col.format(raw, row) : (raw == null ? '' : String(raw));
  if (col.truncate && vWidth(v) > col.truncate) {
    return truncCell(v, col.truncate);
  }
  return v;
}

/**
 * Tier-3.1b: word-boundary-aware truncate. Tries to cut at the last
 * space inside `[max*0.5, max-1]` and append `…`. Falls back to the
 * dumb mid-word cut when no space lives in that range. Never produces
 * a result wider than `max`.
 */
function smartTrunc(s: string, max: number): string {
  if (vWidth(s) <= max) return s;
  if (max <= 1) return '…';
  const candidate = truncateVisible(s, max - 1);
  // Word-boundary search — only honour spaces that leave at least
  // half the column populated, otherwise the cell looks empty.
  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace >= Math.floor(max * 0.5)) {
    return candidate.slice(0, lastSpace) + '…';
  }
  return candidate + '…';
}

/**
 * Tier-3.1b: allocate per-column widths to fit `available` chars.
 * Non-flex columns prefer their natural width; flex columns absorb
 * the leftover space proportional to their natural sizes. When even
 * fixed columns overflow, every column is shrunk proportionally with
 * a hard floor of 8 chars per column.
 */
function allocateWidths<T>(
  cols: Column<T>[],
  natural: number[],
  available: number,
): number[] {
  const numCols = cols.length;
  const totalNatural = natural.reduce((a, b) => a + b, 0);
  if (totalNatural <= available) return natural.slice();

  // If any column declared flex:true, treat those as flex; otherwise
  // the last column carries the flex flag (description-most case).
  const explicitFlex = cols.some((c) => c.flex === true);
  const flexFlags = cols.map((c, i) =>
    explicitFlex ? c.flex === true : i === numCols - 1,
  );

  const fixedSum = natural.reduce(
    (s, w, i) => s + (flexFlags[i] ? 0 : w),
    0,
  );
  const flexNaturalSum = natural.reduce(
    (s, w, i) => s + (flexFlags[i] ? w : 0),
    0,
  );

  if (fixedSum >= available || flexNaturalSum === 0) {
    // Even fixed columns don't fit — proportional shrink everything.
    const ratio = available / Math.max(1, totalNatural);
    return natural.map((w) => Math.max(8, Math.floor(w * ratio)));
  }

  const remainingForFlex = available - fixedSum;
  return natural.map((w, i) => {
    if (!flexFlags[i]) return w;
    return Math.max(8, Math.floor(remainingForFlex * (w / flexNaturalSum)));
  });
}

/**
 * Render `rows` as an ASCII table. Returns the multi-line string
 * (with a trailing `\n`); caller writes it via the display.
 */
export function renderTable<T>(
  rows: T[],
  cols: Column<T>[],
  opts: RenderTableOptions = {},
): string {
  const skin = getSkinEngine();
  const indent = opts.indent ?? 2;
  const showRule = opts.showHeaderRule !== false;

  // Pre-compute uncoloured cell values so width math sees exact text.
  const valueGrid: string[][] = rows.map((row) =>
    cols.map((c) => cellValue(row, c)),
  );

  // Natural widths — max(header, longest cell, minWidth).
  const naturalWidths = cols.map((c, i) => {
    let w = vWidth(c.header);
    for (const rowVals of valueGrid) {
      const cw = vWidth(rowVals[i]);
      if (cw > w) w = cw;
    }
    if (c.minWidth && c.minWidth > w) w = c.minWidth;
    return w;
  });

  // Tier-3.1b: responsive width allocation. Total table chars =
  // indent + 1 (left border) + sum(width+2) + (numCols-1) inner
  // separators + 1 (right border). Solve for content budget given
  // the caller-provided maxWidth (or terminal columns).
  const numCols = cols.length;
  const overhead = indent + 3 * numCols + 1;
  // Honor an explicit override first, then the live TTY width, then
  // the COLUMNS env var (set by `term`-aware shells and most spawned
  // subprocess wrappers — process.stdout.columns is `undefined` when
  // stdout is a pipe, so falling back to env keeps tables responsive
  // for piped consumers like /ui dashboards). Final fallback: 100.
  const envCols = process.env.COLUMNS ? parseInt(process.env.COLUMNS, 10) : 0;
  const maxWidth =
    opts.maxWidth ??
    process.stdout.columns ??
    (envCols > 0 ? envCols : 100);
  const availableForContent = Math.max(numCols * 8, maxWidth - overhead);
  const widths = allocateWidths(cols, naturalWidths, availableForContent);

  // Apply smart truncation to any cell whose content exceeds its
  // allocated width. Non-flex columns at natural width never trigger
  // this branch; flex columns may.
  for (let i = 0; i < numCols; i += 1) {
    const w = widths[i];
    for (const rowVals of valueGrid) {
      if (vWidth(rowVals[i]) > w) {
        rowVals[i] = smartTrunc(rowVals[i], w);
      }
    }
  }

  // Border characters — token-sourced from design/tokens.ts (v4.8.0 Slice 3).
  const { topLeft: TL, topRight: TR, botLeft: BL, botRight: BR } = glyphs.chrome;
  const { teeDown: T, teeUp: B, teeRight: L, teeLeft: R } = glyphs.chrome;
  const { cross: X, hLine: H, vLine: V } = glyphs.chrome;

  const ind = ' '.repeat(indent);

  // Total inner content width across all cells + inner separators.
  // Used by title-embedded top border + page footer.
  const innerWidth = widths.reduce((s, w) => s + w + 2, 0) + (numCols - 1);

  // v4.8.0 Slice 3 — top border with optional embedded title + count.
  // Format: `┌─ title ──────────── totalCount ──┐`
  // Pads the centre with `─` so the right edge stays aligned regardless
  // of title / count length. Falls back to the legacy plain top border
  // when neither field is supplied.
  let top: string;
  if (opts.title || opts.totalCount) {
    const titleText = opts.title ? ` ${opts.title} ` : '';
    const countText = opts.totalCount ? ` ${opts.totalCount} ` : '';
    const fixed = vWidth(titleText) + vWidth(countText);
    const filler = Math.max(0, innerWidth - fixed);
    const titlePainted = opts.title ? skin.applyColors(titleText, 'heading') : '';
    const countPainted = opts.totalCount ? skin.applyColors(countText, 'muted') : '';
    top = TL + H + titlePainted + H.repeat(filler) + countPainted + H + TR;
  } else {
    top = TL + widths.map((w) => H.repeat(w + 2)).join(T) + TR;
  }

  // Header row — heading colour, padded. Truncate first if the
  // header itself is wider than the allocated width (rare, but
  // keeps borders aligned under aggressive narrow-width pressure).
  const headerCells = cols.map((c, i) => {
    const w = widths[i];
    const text = vWidth(c.header) > w ? smartTrunc(c.header, w) : c.header;
    const padded = pad(text, w, c.align ?? 'left');
    return ' ' + skin.applyColors(padded, 'heading') + ' ';
  });
  const headerRow = V + headerCells.join(V) + V;

  // Header rule.
  const rule = L + widths.map((w) => H.repeat(w + 2)).join(X) + R;

  // Body rows.
  const bodyLines: string[] = [];
  const compact = opts.compact === true;
  valueGrid.forEach((rowVals, rIdx) => {
    if (!compact && rIdx > 0) {
      // Tier-3.1a: inter-row separator using `├─…─┼─…─┤` glyphs.
      bodyLines.push(L + widths.map((w) => H.repeat(w + 2)).join(X) + R);
    }
    const cells = cols.map((c, i) => {
      const raw = rowVals[i];
      const padded = pad(raw, widths[i], c.align ?? 'left');
      const colorKind = c.color ? c.color((rows[rIdx] as any)[c.key as string], rows[rIdx]) : undefined;
      const painted = colorKind ? skin.applyColors(padded, colorKind) : padded;
      return ' ' + painted + ' ';
    });
    bodyLines.push(V + cells.join(V) + V);
  });

  // v4.8.0 Slice 3 — pagination footer above the bottom border. Renders
  // `← prev · page X/Y · next →` centred inside the inner width. Side
  // arrows are dim when the page is at the edge so users can read
  // "at-end" cleanly. Caller wires hotkeys; we just paint the chrome.
  let pageFooter: string | null = null;
  if (opts.page) {
    const { current, total } = opts.page;
    const atStart = current <= 1;
    const atEnd   = current >= total;
    const leftKind: ColorKind  = atStart ? 'muted' : 'session';
    const rightKind: ColorKind = atEnd   ? 'muted' : 'session';
    const left  = skin.applyColors('← prev', leftKind);
    const mid   = skin.applyColors(`page ${current}/${total}`, 'muted');
    const right = skin.applyColors('next →', rightKind);
    const sep   = skin.applyColors(' · ', 'muted');
    const body  = `${left}${sep}${mid}${sep}${right}`;
    const bodyW = vWidth('← prev') + vWidth(` · page ${current}/${total} · `) + vWidth('next →');
    const padW  = Math.max(0, innerWidth - bodyW);
    const lpad  = Math.floor(padW / 2);
    const rpad  = padW - lpad;
    pageFooter  = V + ' '.repeat(lpad) + body + ' '.repeat(rpad) + V;
  }

  // Bottom border. Skip the inner tees when the title-style top was
  // used (legacy plain bottom keeps column alignment for un-titled
  // tables; a title-only border on top reads cleanest with a plain
  // bottom mirror).
  const bot = (opts.title || opts.totalCount)
    ? BL + H.repeat(innerWidth) + BR
    : BL + widths.map((w) => H.repeat(w + 2)).join(B) + BR;

  // v4.8.0 Slice 3 — empty-state path. Borders stay so the layout
  // weight matches a populated table; the body is one centered line.
  if (rows.length === 0 && opts.emptyMessage) {
    const msg = skin.applyColors(opts.emptyMessage, 'muted');
    const pad = Math.max(0, innerWidth - vWidth(opts.emptyMessage));
    const lpad = Math.floor(pad / 2);
    const emptyRow = V + ' '.repeat(lpad) + msg + ' '.repeat(pad - lpad) + V;
    return [top, emptyRow, bot].map((l) => ind + l).join('\n') + '\n';
  }

  const allLines = [
    top,
    headerRow,
    ...(showRule ? [rule] : []),
    ...bodyLines,
    ...(pageFooter ? [pageFooter] : []),
    bot,
  ].map((l) => ind + l);

  return allLines.join('\n') + '\n';
}
