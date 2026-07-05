/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/frame/frameReducer.ts — the single UI store for the Ink frame owner.
 *
 * THE CORE PRINCIPLE: one renderer owns the terminal frame. The model stream,
 * tool rows, spinner, status, and keystrokes are all EVENTS into this ONE pure
 * reducer → FrameState → Ink renders it. Nothing writes to stdout directly
 * while Ink owns the screen. Raw content (the transcript items) is CANONICAL;
 * the painted frame is disposable and re-derivable from state.
 *
 * turnId discipline: every turn-scoped event carries the turn's id. An event
 * whose id doesn't match the active turn is a LATE event from a finished or
 * interrupted turn — it is IGNORED, never resurrected. Non-turn events
 * (composer keystrokes, overlays) apply in any state, including idle.
 *
 * Pure + headless-testable: no I/O, no Ink, no timers.
 */

// ── State ────────────────────────────────────────────────────────────────────

export type ToolStatus = 'running' | 'ok' | 'error';

/** One canonical transcript item. Assistant items accumulate stream deltas. */
export type TranscriptItem =
  | { kind: 'user';      id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool';      id: string; name: string; status: ToolStatus; detail: string }
  | { kind: 'note';      id: string; text: string };   // queued/steer confirmations, etc.

export interface StatusLane {
  verb:          string;   // "thinking" | "researching" | …
  elapsedS:      number;
  model:         string;
  contextTokens: number;
  contextMax:    number | null;
}

export interface ComposerLaneState {
  buffer: string;
  cursor: number;
}

export type Overlay =
  | null
  | { kind: 'slash';    items: string[]; selected: number }
  | { kind: 'approval'; message: string }
  | { kind: 'queue';    items: string[] };

export interface FrameState {
  /** Active turn id, or null when idle. Drives phase + late-event filtering. */
  turnId:     number | null;
  phase:      'idle' | 'busy';
  transcript: TranscriptItem[];
  status:     StatusLane;
  composer:   ComposerLaneState;
  busyMode:   'queue' | 'interrupt' | 'redirect';
  paused:     boolean;
  overlay:    Overlay;
}

export function initialFrameState(): FrameState {
  return {
    turnId: null,
    phase: 'idle',
    transcript: [],
    status: { verb: 'thinking', elapsedS: 0, model: '', contextTokens: 0, contextMax: null },
    composer: { buffer: '', cursor: 0 },
    busyMode: 'queue',
    paused: false,
    overlay: null,
  };
}

// ── Events ───────────────────────────────────────────────────────────────────

export type FrameEvent =
  // ── turn lifecycle ──
  | { type: 'turn/start';     turnId: number }
  | { type: 'turn/end';       turnId: number }
  | { type: 'turn/interrupt'; turnId: number }
  // ── turn-scoped render events (carry turnId; late ones ignored) ──
  | { type: 'stream/delta';   turnId: number; text: string }
  | { type: 'tool/start';     turnId: number; id: string; name: string; detail?: string }
  | { type: 'tool/progress';  turnId: number; id: string; detail: string }
  | { type: 'tool/complete';  turnId: number; id: string; status: 'ok' | 'error'; detail?: string }
  | { type: 'status/set';     turnId: number; patch: Partial<StatusLane> }
  | { type: 'note';           turnId: number; text: string }
  // ── non-turn events (apply any time, incl. idle) ──
  | { type: 'user/message';   text: string }
  | { type: 'composer/set';   buffer: string; cursor: number }
  | { type: 'busyMode/set';   mode: 'queue' | 'interrupt' | 'redirect' }
  | { type: 'pause/set';      paused: boolean }
  | { type: 'overlay/set';    overlay: Overlay };

/** Turn-scoped event types — gated by the turnId guard. */
const TURN_SCOPED = new Set<FrameEvent['type']>([
  'stream/delta', 'tool/start', 'tool/progress', 'tool/complete', 'status/set', 'note',
]);

let seq = 0;
/** Monotonic id for transcript items (pure: derived from a module counter, not
 *  a clock, so tests are deterministic across a process run). */
function nextId(prefix: string): string { seq += 1; return `${prefix}${seq}`; }

// ── Reducer ──────────────────────────────────────────────────────────────────

export function frameReducer(prev: FrameState, ev: FrameEvent): FrameState {
  // ── turnId guard: a turn-scoped event whose id isn't the ACTIVE turn is a
  //    late/foreign event (from a finished/interrupted turn) → drop it. ──
  if (TURN_SCOPED.has(ev.type)) {
    const turnId = (ev as { turnId: number }).turnId;
    if (prev.turnId === null || turnId !== prev.turnId) return prev;
  }

  switch (ev.type) {
    case 'turn/start':
      return { ...prev, turnId: ev.turnId, phase: 'busy', paused: false,
        status: { ...prev.status, elapsedS: 0 } };

    case 'turn/end':
    case 'turn/interrupt': {
      if (prev.turnId !== ev.turnId) return prev;   // stale end/interrupt → ignore
      // Any still-running tool is closed (interrupt) so it never lingers.
      const transcript = ev.type === 'turn/interrupt'
        ? prev.transcript.map((t) => t.kind === 'tool' && t.status === 'running'
            ? { ...t, status: 'error' as const, detail: 'interrupted' } : t)
        : prev.transcript;
      return { ...prev, turnId: null, phase: 'idle', paused: false, overlay: null, transcript };
    }

    case 'stream/delta': {
      const last = prev.transcript[prev.transcript.length - 1];
      if (last && last.kind === 'assistant') {
        const transcript = prev.transcript.slice(0, -1).concat({ ...last, text: last.text + ev.text });
        return { ...prev, transcript };
      }
      return { ...prev, transcript: prev.transcript.concat({ kind: 'assistant', id: nextId('a'), text: ev.text }) };
    }

    case 'tool/start':
      return { ...prev, transcript: prev.transcript.concat({
        kind: 'tool', id: ev.id, name: ev.name, status: 'running', detail: ev.detail ?? '' }) };

    case 'tool/progress':
      return { ...prev, transcript: prev.transcript.map((t) =>
        t.kind === 'tool' && t.id === ev.id ? { ...t, detail: ev.detail } : t) };

    case 'tool/complete':
      return { ...prev, transcript: prev.transcript.map((t) =>
        t.kind === 'tool' && t.id === ev.id
          ? { ...t, status: ev.status, detail: ev.detail ?? t.detail } : t) };

    case 'status/set':
      return { ...prev, status: { ...prev.status, ...ev.patch } };

    case 'note':
      return { ...prev, transcript: prev.transcript.concat({ kind: 'note', id: nextId('n'), text: ev.text }) };

    case 'user/message':
      return { ...prev, transcript: prev.transcript.concat({ kind: 'user', id: nextId('u'), text: ev.text }) };

    case 'composer/set':
      return { ...prev, composer: { buffer: ev.buffer, cursor: ev.cursor } };

    case 'busyMode/set':
      return { ...prev, busyMode: ev.mode };

    case 'pause/set':
      return { ...prev, paused: ev.paused };

    case 'overlay/set':
      return { ...prev, overlay: ev.overlay };

    default:
      return prev;
  }
}

/** Test-only — reset the item-id counter so ids are stable across test files. */
export function _resetFrameIds(): void { seq = 0; }
