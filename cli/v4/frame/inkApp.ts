/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/frame/inkApp.ts — the Ink render tree for the single-owner frame.
 *
 * Renders a FrameState (nothing else): SETTLED transcript items flow into Ink's
 * <Static> (printed once, scrolled up into real scrollback ABOVE the live
 * frame); the LIVE tail (the still-streaming assistant + any running tool) + the
 * busy/status row + the ONE composer + overlays render in the live frame that
 * Ink owns at the bottom. Output can never overwrite the composer because ONE
 * renderer owns the whole frame + the final cursor.
 *
 * Pure view: no state, no I/O — props in, elements out. Built with
 * React.createElement (no JSX) to avoid flipping the project tsconfig, matching
 * cli/v4/frame/composer.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const React = require('react') as typeof import('react');

import type { FrameState, TranscriptItem } from './frameReducer';
import { composerView } from './composerModel';

export interface InkAppComponents {
  Box:    React.ComponentType<{ children?: React.ReactNode; flexDirection?: 'row' | 'column'; marginTop?: number }>;
  Text:   React.ComponentType<{ children?: React.ReactNode; color?: string; dimColor?: boolean; inverse?: boolean; bold?: boolean }>;
  Static: React.ComponentType<{ items: TranscriptItem[]; children: (item: TranscriptItem, index: number) => React.ReactNode }>;
}

/** Split the transcript into a SETTLED prefix (→ Static/scrollback) and a LIVE
 *  suffix (still-changing tail). Live = trailing run of a running tool or the
 *  streaming assistant at the tail while busy. Tools run sequentially + the
 *  assistant streams at the tail, so the live items are always a suffix. */
export function splitTranscript(t: TranscriptItem[], phase: 'idle' | 'busy'): { settled: TranscriptItem[]; live: TranscriptItem[] } {
  let liveStart = t.length;
  for (let i = t.length - 1; i >= 0; i -= 1) {
    const it = t[i];
    const isLive = (it.kind === 'tool' && it.status === 'running')
      || (it.kind === 'assistant' && i === t.length - 1 && phase === 'busy');
    if (isLive) liveStart = i; else break;
  }
  return { settled: t.slice(0, liveStart), live: t.slice(liveStart) };
}

/** One transcript row → its element. Kept pure + exported for view tests. */
export function itemLine(it: TranscriptItem): string {
  switch (it.kind) {
    case 'user':      return `▲ ${it.text}`;
    case 'assistant': return `┃ ${it.text}`;
    case 'note':      return `  ${it.text}`;
    case 'tool': {
      const glyph = it.status === 'running' ? '⋯' : it.status === 'ok' ? '✓' : '✗';
      return `  ${glyph} ${it.name}${it.detail ? ` — ${it.detail}` : ''}`;
    }
  }
}

export function makeInkApp(ink: InkAppComponents): React.ComponentType<{ state: FrameState }> {
  const { Box, Text, Static } = ink;

  function Row({ item }: { item: TranscriptItem }): React.ReactElement {
    const color = item.kind === 'user' ? 'cyan'
      : item.kind === 'tool' ? (item.status === 'error' ? 'red' : item.status === 'ok' ? 'green' : 'yellow')
      : undefined;
    return React.createElement(Text, { color, dimColor: item.kind === 'note' }, itemLine(item));
  }

  function StatusRow({ state }: { state: FrameState }): React.ReactElement | null {
    if (state.phase !== 'busy') return null;
    const s = state.status;
    const paused = state.paused ? ' · paused' : '';
    return React.createElement(Text, { dimColor: true },
      `  ${s.verb}… ${s.elapsedS}s${paused}`);
  }

  function Composer({ state }: { state: FrameState }): React.ReactElement {
    const view = composerView({ phase: state.phase, busyMode: state.busyMode, paused: state.paused });
    const { buffer, cursor } = state.composer;
    const before = buffer.slice(0, cursor);
    const at     = cursor < buffer.length ? buffer[cursor] : ' ';
    const after  = cursor < buffer.length ? buffer.slice(cursor + 1) : '';
    return React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
      // The input line: prompt + before-cursor + inverse cursor cell + after.
      React.createElement(Box, { flexDirection: 'row' },
        React.createElement(Text, { color: 'cyan' }, '▲ '),
        React.createElement(Text, null, before),
        React.createElement(Text, { inverse: true }, at),
        React.createElement(Text, null, after),
      ),
      // The plain-language hint line.
      React.createElement(Text, { dimColor: true }, `  ${view.hint}`),
    );
  }

  function Overlay({ state }: { state: FrameState }): React.ReactElement | null {
    const o = state.overlay;
    if (!o) return null;
    if (o.kind === 'slash') {
      return React.createElement(Box, { flexDirection: 'column' },
        ...o.items.map((cmd, i) => React.createElement(Text,
          { key: cmd, inverse: i === o.selected }, `  ${cmd}`)));
    }
    if (o.kind === 'approval') return React.createElement(Text, { color: 'yellow' }, `  ⚠ ${o.message}`);
    if (o.kind === 'queue') {
      return React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Text, { dimColor: true }, `  queued (${o.items.length}):`),
        ...o.items.map((q, i) => React.createElement(Text, { key: String(i), dimColor: true }, `    • ${q}`)));
    }
    return null;
  }

  return function InkApp({ state }: { state: FrameState }): React.ReactElement {
    const { settled, live } = splitTranscript(state.transcript, state.phase);
    return React.createElement(Box, { flexDirection: 'column' },
      // SETTLED history → Static → real scrollback above the live frame.
      React.createElement(Static as React.ComponentType<{ items: TranscriptItem[]; children: (i: TranscriptItem, n: number) => React.ReactNode }>,
        { items: settled, children: (item: TranscriptItem) => React.createElement(Row, { key: item.id, item }) }),
      // LIVE tail (streaming assistant + running tools), re-rendered each frame.
      ...live.map((item) => React.createElement(Row, { key: item.id, item })),
      React.createElement(StatusRow, { state }),
      React.createElement(Overlay, { state }),
      React.createElement(Composer, { state }),
    );
  };
}
