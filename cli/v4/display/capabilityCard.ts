/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display/capabilityCard.ts — Aiden v4.1.3-essentials.
 *
 * Renders the structured "capability card" tools return on certain
 * failure classes:
 *   1. Platform unsupported (e.g. media_transport called on Linux)
 *   2. Auth missing (provider 401/403, or a tool that needs a specific
 *      OAuth/API key)
 *
 * Distinct from the one-line tool-trail row (`display.toolRow`) because
 * it's a different category of information — a state assessment of
 * what the user CAN still do versus what they CANNOT, with a one-line
 * fix hint. Rendered as a box-bordered multi-line block.
 *
 * Pure module — takes the data + a colorize callback, returns lines.
 * No I/O, no SkinEngine reach-through. Caller writes the result.
 */

import type { CapabilityCardData } from '../../../providers/v4/types';
import type { ColorKind } from '../skinEngine';
import { boxSharp, truncateVisible, visibleLength } from '../box';

type Colorize = (text: string, kind: ColorKind) => string;

/** Total card width (chars). Wide enough for typical action labels;
 *  short enough to stay readable on narrow terminals. */
const CARD_WIDTH = 64;
/** Box-content width = CARD_WIDTH minus 2 border chars and 2 padding. */
const CONTENT_WIDTH = CARD_WIDTH - 4;

/**
 * Render a capability card from `data`. Returns an array of lines
 * (no trailing newlines). Caller writes them with appended `\n`:
 *
 *   for (const line of renderCapabilityCard(data, colorize)) {
 *     display.write(line + '\n');
 *   }
 *
 * Layout:
 *
 *   ┌── ⚠ <title> ──────────────────────────────┐
 *   │                                           │
 *   │ Can still:                                │
 *   │   ✓ <action 1>                            │
 *   │   ✓ <action 2>                            │
 *   │                                           │
 *   │ Cannot reliably:                          │
 *   │   ✗ <action 1>                            │
 *   │   ✗ <action 2>                            │
 *   │                                           │
 *   │ Fix: <one-line guidance>                  │
 *   └───────────────────────────────────────────┘
 *
 * Empty `canStill` or `cannotReliably` arrays cause the corresponding
 * section to be omitted (no empty heading). Always renders at least
 * the title + fix line so the user has actionable signal.
 */
export function renderCapabilityCard(
  data:     CapabilityCardData,
  colorize: Colorize,
): string[] {
  // Pre-color the section headings + bullet markers.
  const heading = (s: string): string => colorize(s, 'warn');
  const okMark  = colorize('✓', 'success');
  const noMark  = colorize('✗', 'error');
  const fixLbl  = colorize('Fix:', 'tool');

  // Compose the inner rows that boxSharp will wrap. Each row is the
  // CONTENT (no border) — boxSharp adds the side borders + padding.
  const rows: string[] = [];

  // v4.2 Phase 3 — optional "what happened" one-liner above the
  // canStill section. Rendered as a muted-tone line so it reads as
  // context, not action. Skipped cleanly when absent → v4.1.3
  // capability-card behaviour preserved for non-Phase-3 callers.
  if (data.whatHappened) {
    rows.push('');
    rows.push(colorize(truncToContent(data.whatHappened), 'muted'));
  }

  // v4.2 Phase 3 — optional failure-category pill row. Each entry
  // renders as `<category>(<count>)` separated by " · " bullets.
  // Pre-sorted by the generator (desc count then category priority);
  // renderer just formats. Skipped cleanly when absent.
  if (data.failuresByCategory && data.failuresByCategory.length > 0) {
    const pills = data.failuresByCategory
      .map((p) => `${p.category}(${p.count})`)
      .join(' · ');
    const label = colorize('Failures:', 'error');
    rows.push(`${label} ${truncToContent(pills)}`);
  }

  // v4.3 Phase 5 — optional one-line browser context summary
  // (active tab, blocker kind, other-tab count, stale-ref retries).
  // Already pre-formatted by recoveryReport's `buildBrowserContextLine`.
  // Rendered as a muted-tone line below the Failures: row when present.
  if (data.browserContext) {
    rows.push(colorize(truncToContent(data.browserContext), 'muted'));
  }

  if (data.canStill.length > 0) {
    rows.push('');
    rows.push(heading('Can still:'));
    for (const action of data.canStill) {
      rows.push(`  ${okMark} ${truncToContent(action)}`);
    }
  }

  if (data.cannotReliably.length > 0) {
    rows.push('');
    rows.push(heading('Cannot reliably:'));
    for (const action of data.cannotReliably) {
      rows.push(`  ${noMark} ${truncToContent(action)}`);
    }
  }

  rows.push('');
  // Fix line — split-wrap to two lines if needed so long guidance
  // doesn't get cut off mid-sentence by boxSharp's clipper.
  const fixText = data.fix;
  const fixPrefix = 'Fix: ';
  const fixPrefixVis = visibleLength(fixPrefix);
  if (visibleLength(fixText) + fixPrefixVis <= CONTENT_WIDTH) {
    rows.push(`${fixLbl} ${fixText}`);
  } else {
    rows.push(fixLbl);
    // Wrap the fix text across content-width lines.
    let remaining = fixText;
    const wrapLimit = CONTENT_WIDTH - 2; // 2-space indent
    while (remaining.length > 0) {
      const chunk = remaining.length <= wrapLimit
        ? remaining
        : breakAtWord(remaining, wrapLimit);
      rows.push(`  ${chunk}`);
      remaining = remaining.slice(chunk.length).trimStart();
    }
  }
  rows.push('');

  // Title is rendered into the top border by boxSharp. Prefix with
  // a warning glyph (yellow) so the user reads it as an attention card.
  const title = `${colorize('⚠', 'warn')} ${data.title}`;

  return boxSharp(rows, CARD_WIDTH, title).split('\n');
}

/**
 * Shorten an action label so it fits the bullet column with room for
 * the marker ("  ✓ ") and the border padding. Appends an ellipsis when
 * truncated. Pure — exported for unit tests.
 */
export function truncToContent(s: string): string {
  // Reserve 6 chars for "  ✓ " prefix + 2 for border padding margin.
  const cap = CONTENT_WIDTH - 6;
  if (visibleLength(s) <= cap) return s;
  return `${truncateVisible(s, cap - 1)}…`;
}

/**
 * Break `s` at the last word boundary at-or-before `limit`. Falls back
 * to a hard cut at `limit` when no whitespace appears in the prefix.
 * Pure helper used by the Fix-line wrapper.
 */
function breakAtWord(s: string, limit: number): string {
  if (s.length <= limit) return s;
  const slice = s.slice(0, limit);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
}
