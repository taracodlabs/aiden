/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 1 — Status heartbeat row (pinned, composer-phase only).
 *
 * Renders the "thinking… Ns" row that appears the instant the user
 * presses Enter — BEFORE the legacy stream/tool/spinner painters
 * take over. This is the "feels stuck" fix: the user sees instant
 * feedback that submit was received, even if first token is seconds
 * away.
 *
 * Slice 1 lifecycle:
 *   1. Composer renders, status idle (component returns `null`).
 *   2. Submit fires → reducer sets status.phase = 'busy'.
 *   3. ONE render tick paints the heartbeat row.
 *   4. Frame unmounts, runAgentTurn handles the rest.
 *
 * The status row never ticks past that first paint in Slice 1.
 * Slice 2 will add mid-stream status updates and the actual
 * elapsed-time counter.
 *
 * Written as `.ts` with `React.createElement` (no JSX) so we don't
 * have to flip the project tsconfig's `jsx` setting. Same runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const React = require('react') as typeof import('react');

import { type StatusState, barModelFromStatus } from './state';
import { type InkComponents } from './composer';
import { renderStatusBar } from './statusBar';

/** Build the status component bound to the supplied Ink primitives. */
export function makeStatus(ink: InkComponents): React.ComponentType<{
  status: StatusState;
}> {
  const { Box, Text } = ink;

  function Status(props: { status: StatusState }): React.ReactElement | null {
    const { status } = props;
    if (status.phase !== 'busy') return null;
    // v4.12.1 Pillar 4 — the pinned glass status bar. Rendered as ONE
    // width-budgeted line via the pure renderStatusBar (the frame renderer
    // owns the paint; no ad-hoc ANSI). Falls back gracefully when the
    // bar fields are unset (Slice-1 callers) — model/ctx just show empty/0.
    const width = (process.stdout && process.stdout.columns) ? process.stdout.columns : 80;
    const bar = renderStatusBar(barModelFromStatus(status), Math.max(20, width - 2));
    return React.createElement(
      Box,
      // marginTop: 1 inserts a blank row between the composer's
      // prompt line and the heartbeat — the v4.11 Slice 1 Phase C
      // visual review flagged the prior zero-gap layout as cramped.
      { flexDirection: 'row', marginTop: 1 },
      React.createElement(
        Text,
        { color: 'yellow' },
        spinnerGlyph(status.elapsedS),
        ' ',
      ),
      React.createElement(
        Text,
        { dimColor: true },
        bar,
      ),
    );
  }

  return Status;
}

/** 10-frame braille spinner indexed by elapsed seconds * 4. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function spinnerGlyph(elapsedS: number): string {
  // Slice 1 only renders one tick before unmount; the index math
  // exists so later slices that keep the heartbeat mounted during
  // streaming see continuous motion.
  return SPINNER[(elapsedS * 4) % SPINNER.length] ?? '⠋';
}
