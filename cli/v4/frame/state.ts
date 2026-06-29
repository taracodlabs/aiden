/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 1 — FrameState shape + minimal reducer.
 *
 * Lane discipline (locked invariant): each turn-state concern owns
 * its own slice of FrameState. Slice 1 only wires `composer` and
 * `status`. Later slices add `stream`, `tools`, `todos`, `reasoning`
 * — each in its own lane, never colliding.
 */

/** Composer lane — what the user is typing right now. */
export interface ComposerState {
  /** Live input value. */
  value:  string;
  /** Caret column, 0-indexed from the start of `value`. */
  cursor: number;
  /** Prompt prefix (e.g. "› "). */
  prompt: string;
}

/** Status lane — the pinned heartbeat row. */
export interface StatusState {
  /**
   * idle = no status row rendered. busy = "thinking… Ns" rendered.
   * Slice 1 only ever transitions idle → busy at submit, then the
   * frame unmounts and the next prompt remounts idle.
   */
  phase:    'idle' | 'busy';
  /** Verb shown next to the spinner ("thinking", "calling", etc.). */
  verb:     string;
  /** Monotonic ms timestamp when busy started; null when idle. */
  sinceMs:  number | null;
  /** Most recent elapsed reading in seconds (driven by the heartbeat). */
  elapsedS: number;
}

export interface FrameState {
  composer: ComposerState;
  status:   StatusState;
}

export function makeInitialState(prompt: string): FrameState {
  return {
    composer: { value: '', cursor: 0, prompt },
    status:   { phase: 'idle', verb: 'thinking', sinceMs: null, elapsedS: 0 },
  };
}

// ── Reducer ────────────────────────────────────────────────────────
//
// We use a tiny tagged-union reducer rather than ad-hoc setState
// patches. Reasons: (1) it keeps the surface tested and discoverable,
// (2) later slices will add stream/tools lanes and benefit from the
// same discipline, (3) the reducer is pure → easy to unit-test
// without mounting Ink.

export type FrameAction =
  | { type: 'composer/setValue'; value: string; cursor?: number }
  | { type: 'composer/setCursor'; cursor: number }
  | { type: 'status/markBusy'; verb?: string; sinceMs: number }
  | { type: 'status/tick';     elapsedS: number }
  | { type: 'status/reset' };

export function reducer(prev: FrameState, action: FrameAction): FrameState {
  switch (action.type) {
    case 'composer/setValue': {
      return {
        ...prev,
        composer: {
          ...prev.composer,
          value:  action.value,
          cursor: action.cursor ?? action.value.length,
        },
      };
    }
    case 'composer/setCursor': {
      const clamped = Math.max(0, Math.min(action.cursor, prev.composer.value.length));
      return { ...prev, composer: { ...prev.composer, cursor: clamped } };
    }
    case 'status/markBusy': {
      return {
        ...prev,
        status: {
          phase:    'busy',
          verb:     action.verb ?? prev.status.verb,
          sinceMs:  action.sinceMs,
          elapsedS: 0,
        },
      };
    }
    case 'status/tick': {
      if (prev.status.phase !== 'busy') return prev;
      return { ...prev, status: { ...prev.status, elapsedS: action.elapsedS } };
    }
    case 'status/reset': {
      return { ...prev, status: { phase: 'idle', verb: prev.status.verb, sinceMs: null, elapsedS: 0 } };
    }
    default: {
      return prev;
    }
  }
}
