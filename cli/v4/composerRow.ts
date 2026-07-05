/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/composerRow.ts — v4.12.1 Pillar 4 Slice 2c.
 *
 * The pure render of the live during-turn composer: what the user has typed so
 * far, prefixed with the active busy-mode label so they always know what Enter
 * does. No I/O — display.ts weaves the returned string into whichever owned
 * bottom row is live (activity indicator during thinking, tool row during a
 * tool call), so it survives long tool calls.
 *
 * Empty buffer → '' (nothing appended — never noisy). Text present → the mode
 * label + the live text, tail-truncated (keeps the most-recent keystrokes, the
 * end where the cursor is) so a long line can't overflow the owned row.
 */

export type ComposerMode = 'queue' | 'interrupt' | 'redirect';

/** Plain-language verb for what Enter does in this mode (v4.14 — was the raw
 *  mode name; users read "steer ▸ …" more clearly than "redirect ▸ …"). */
const PLAIN_LABEL: Readonly<Record<ComposerMode, string>> = {
  queue: 'queue', interrupt: 'stop', redirect: 'steer',
};
export function modeLabel(mode: ComposerMode): string {
  return PLAIN_LABEL[mode];
}

/**
 * Render the composer suffix. Empty buffer → '' (append nothing). Otherwise
 * `<mode> ▸ <text>`, tail-truncated to `maxWidth` columns so it can never
 * overflow the owned bottom row.
 */
export function renderComposerBuffer(buffer: string, mode: ComposerMode, maxWidth = 60): string {
  if (!buffer) return '';
  const label = `${modeLabel(mode)} ▸ `;
  const room = Math.max(4, maxWidth - label.length);
  const text = buffer.length > room ? '…' + buffer.slice(-(room - 1)) : buffer;
  return `${label}${text}`;
}
