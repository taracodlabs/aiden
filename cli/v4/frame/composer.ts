/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 1 — Composer component (renderer-owned).
 *
 * The composer is the single React component that owns the input
 * line and its cursor. Cursor position is DECLARED via Ink's
 * `showCursor` + the `Text` layout — never embedded as a CSI escape
 * in a string. This is the discipline that prevents the Bug-D class
 * of bug (ghost text drifting into the prompt line).
 *
 * Slice 1 deliberately keeps the input minimal: printable chars,
 * Enter (submit), Backspace, Left/Right caret movement. Slash
 * dropdown, ghost text, history nav are downstream slices — they
 * plug into the same FrameState lanes.
 *
 * Written as `.ts` with `React.createElement` (no JSX) so we don't
 * have to flip `jsx` in the project tsconfig. Same runtime, smaller
 * blast radius.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const React = require('react') as typeof import('react');
// `ink` is ESM-only; we import lazily inside startFrameRepl and pass
// the captured `Box/Text/useInput` refs in via a context object. This
// keeps the file CJS-clean.

import { type FrameState } from './state';
import { makeStatus } from './status';
import { stripAllPasteMarkers } from '../bracketedPaste';

// Control bytes that must never land in the visible composer value. Matches
// the during-turn listener's scrub (keeps tab/newline; drops ESC/CSI leftovers
// and other C0/C1 controls that would corrupt the single owned prompt row).
// eslint-disable-next-line no-control-regex
const CTRL_STRIP = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export interface ComposerCallbacks {
  onChange: (value: string, cursor: number) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export interface InkComponents {
  Box:     React.ComponentType<{
    children?: React.ReactNode;
    flexDirection?: 'row' | 'column';
    marginTop?: number;
  }>;
  Text:    React.ComponentType<{
    children?: React.ReactNode;
    color?: string;
    dimColor?: boolean;
    inverse?: boolean;
  }>;
  useInput: (
    handler: (input: string, key: {
      return?:    boolean;
      backspace?: boolean;
      delete?:    boolean;
      leftArrow?: boolean;
      rightArrow?: boolean;
      ctrl?:      boolean;
      escape?:    boolean;
    }) => void,
    opts?: { isActive?: boolean },
  ) => void;
}

/**
 * Build a composer component bound to the supplied Ink primitives.
 * Returning a factory keeps the import order clean: the runtime does
 * `await import('ink')` once, then passes Box/Text/useInput here so
 * we don't repeat the dynamic import per render.
 */
export function makeComposer(ink: InkComponents): React.ComponentType<{
  state:     FrameState;
  callbacks: ComposerCallbacks;
}> {
  const { Box, Text, useInput } = ink;
  // Status component is owned by its own module; composer renders
  // it as a sibling. Both lanes (composer / status) are independent
  // — keeps each surface auditable on its own.
  const Status = makeStatus(ink);

  function Composer(props: { state: FrameState; callbacks: ComposerCallbacks }): React.ReactElement {
    const { state, callbacks } = props;
    const { value, cursor, prompt } = state.composer;
    const isBusy = state.status.phase === 'busy';

    // Block input while busy (we render one "thinking…" tick then
    // unmount — but if anything keeps us alive briefly, the user's
    // keypresses shouldn't leak into the next prompt).
    useInput((input, key) => {
      if (isBusy) return;
      if (key.ctrl && input === 'c') { callbacks.onCancel(); return; }
      if (key.escape)                { callbacks.onCancel(); return; }
      if (key.return)                { callbacks.onSubmit(value); return; }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          const next = value.slice(0, cursor - 1) + value.slice(cursor);
          callbacks.onChange(next, cursor - 1);
        }
        return;
      }
      if (key.leftArrow)  { callbacks.onChange(value, Math.max(0, cursor - 1)); return; }
      if (key.rightArrow) { callbacks.onChange(value, Math.min(value.length, cursor + 1)); return; }
      // Printable input (Ink delivers it as a possibly-multi-char
      // string for fast typing / paste).
      if (input && !key.ctrl) {
        // v4.12.1 — class fix for the main-prompt paste leak. When bracketed
        // paste is enabled, a paste burst reaches Ink's useInput with the raw
        // \x1b[200~ / \x1b[201~ markers embedded in `input` (Ink doesn't
        // understand them, and the stdin interceptor doesn't reliably tap
        // Ink's read path). Strip the markers + control bytes here so they
        // never enter `value` — which is both rendered live AND echoed to
        // scrollback on submit. This is the miss that surfaced `[200~…` on the
        // frame renderer's main prompt.
        const clean = stripAllPasteMarkers(input).replace(CTRL_STRIP, '');
        if (clean.length === 0) return;
        const next = value.slice(0, cursor) + clean + value.slice(cursor);
        callbacks.onChange(next, cursor + clean.length);
      }
    }, { isActive: true });

    // Cursor is DECLARED by Ink rendering an inverse char at the
    // caret position — not embedded as a CSI escape in the string.
    // Three segments: before-cursor, at-cursor (inverse), after.
    const before = value.slice(0, cursor);
    const at     = cursor < value.length ? value[cursor] : ' ';
    const after  = cursor < value.length ? value.slice(cursor + 1) : '';

    return React.createElement(
      Box,
      { flexDirection: 'column' },
      // Prompt line
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(Text, { color: 'cyan' }, prompt),
        React.createElement(Text, null, before),
        React.createElement(Text, { inverse: true }, at),
        React.createElement(Text, null, after),
      ),
      // Status row — its own component, sibling to the prompt line.
      // Returns null when idle, so the layout collapses cleanly.
      React.createElement(Status, { status: state.status }),
    );
  }

  return Composer;
}
