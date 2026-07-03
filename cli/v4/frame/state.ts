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

/** Status lane — the pinned heartbeat row + v4.12.1 glass status-bar fields. */
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
  // ── v4.12.1 Pillar 4 — pinned status-bar inputs (rendered via
  //    statusBar.renderStatusBar; all default-safe so Slice-1 callers that
  //    don't set them still get a valid bar). ─────────────────────────────
  model:           string;
  contextTokens:   number;
  contextMax:      number | null;
  activeSubagents: number;
  cwd:             string;
  pendingApproval: boolean;
  /** Update segment ('v4.13 ↑') or null when up to date / unknown. */
  nBehind:         string | null;
}

export interface FrameState {
  composer: ComposerState;
  status:   StatusState;
}

export function makeInitialState(prompt: string): FrameState {
  return {
    composer: { value: '', cursor: 0, prompt },
    status:   {
      phase: 'idle', verb: 'thinking', sinceMs: null, elapsedS: 0,
      model: '', contextTokens: 0, contextMax: null,
      activeSubagents: 0, cwd: '', pendingApproval: false, nBehind: null,
    },
  };
}

/** Build the pure status-bar model from the status lane. */
export function barModelFromStatus(s: StatusState): import('./statusBar').StatusBarModel {
  return {
    busy: s.phase === 'busy', verb: s.verb, elapsedS: s.elapsedS,
    model: s.model, contextTokens: s.contextTokens, contextMax: s.contextMax,
    activeSubagents: s.activeSubagents, cwd: s.cwd,
    pendingApproval: s.pendingApproval, nBehind: s.nBehind,
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
  | { type: 'status/reset' }
  // v4.12.1 Pillar 4 — patch any subset of the glass status-bar fields.
  | { type: 'status/setBar'; patch: Partial<Pick<StatusState,
      'model' | 'contextTokens' | 'contextMax' | 'activeSubagents' | 'cwd' | 'pendingApproval' | 'nBehind' | 'verb'>> };

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
          ...prev.status,           // preserve model / cwd / nBehind across turns
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
      // Reset the heartbeat + subagent count; PERSIST session-level bar fields
      // (model / cwd / nBehind) across turns so the bar stays populated idle.
      return {
        ...prev,
        status: {
          ...prev.status,
          phase: 'idle', sinceMs: null, elapsedS: 0,
          activeSubagents: 0, pendingApproval: false,
        },
      };
    }
    case 'status/setBar': {
      return { ...prev, status: { ...prev.status, ...action.patch } };
    }
    default: {
      return prev;
    }
  }
}
