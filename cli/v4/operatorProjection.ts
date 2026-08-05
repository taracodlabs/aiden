/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

export type OperatorActivityState =
  | 'scheduled' | 'preparing' | 'awaiting_approval' | 'running' | 'waiting'
  | 'retrying' | 'reconciling' | 'verifying' | 'succeeded' | 'failed'
  | 'denied' | 'interrupted' | 'cancelled' | 'timed_out' | 'unknown' | 'stale';

export type TranscriptKind = 'user' | 'assistant' | 'activity' | 'notice' | 'system';

export interface TranscriptProjection {
  id: string;
  kind: TranscriptKind;
  sourceText: string;
  sequence: number;
}

export interface ActivityProjection {
  id: string;
  parentId: string | null;
  jobId: string | null;
  attemptId: string | null;
  generation: number;
  startedSequence: number;
  state: OperatorActivityState;
  startedAt: number;
  endedAt: number | null;
  summary: string;
  detailsRef: string | null;
}

export interface ViewportProjectionState {
  epoch: number;
  hiddenBeforeSequence: number;
  scrollOffset: number;
  stickyTail: boolean;
  selectedRow: string | null;
  cachedWidth: number | null;
  cachedHeight: number | null;
  newEventsBelow: number;
}

export interface OperatorProjectionState {
  transcript: readonly TranscriptProjection[];
  activities: Readonly<Record<string, ActivityProjection>>;
  eventSequence: number;
  viewport: ViewportProjectionState;
}

export type OperatorProjectionEvent =
  | { type: 'transcript.append'; id: string; kind: TranscriptKind; sourceText: string }
  | { type: 'transcript.replace'; id: string; sourceText: string }
  | { type: 'viewport.clear' }
  | { type: 'activity.upsert'; activity: ActivityProjection }
  | { type: 'activity.progress'; id: string; generation: number; summary: string }
  | { type: 'activity.terminal'; id: string; generation: number; state: Extract<OperatorActivityState,
      'succeeded' | 'failed' | 'denied' | 'interrupted' | 'cancelled' | 'timed_out' | 'unknown' | 'stale'>;
      summary: string; endedAt: number }
  | { type: 'activity.remove'; id: string }
  | { type: 'viewport.scroll'; delta: number; maxOffset?: number }
  | { type: 'viewport.follow' }
  | { type: 'viewport.measure'; width: number; height: number };

const TERMINAL_ACTIVITY_STATES = new Set<OperatorActivityState>([
  'succeeded', 'failed', 'denied', 'interrupted', 'cancelled', 'timed_out', 'unknown', 'stale',
]);

export function initialOperatorProjection(): OperatorProjectionState {
  return {
    transcript: [], activities: {}, eventSequence: 0,
    viewport: {
      epoch: 0,
      hiddenBeforeSequence: 0,
      scrollOffset: 0,
      stickyTail: true,
      selectedRow: null,
      cachedWidth: null,
      cachedHeight: null,
      newEventsBelow: 0,
    },
  };
}

export function reduceOperatorProjection(
  state: OperatorProjectionState,
  event: OperatorProjectionEvent,
): OperatorProjectionState {
  const nextSequence = state.eventSequence + 1;
  switch (event.type) {
    case 'transcript.append': {
      if (state.transcript.some((item) => item.id === event.id)) return state;
      return {
        ...state,
        eventSequence: nextSequence,
        transcript: [...state.transcript, {
          id: event.id,
          kind: event.kind,
          sourceText: event.sourceText,
          sequence: nextSequence,
        }],
        viewport: {
          ...state.viewport,
          newEventsBelow: state.viewport.stickyTail ? 0 : state.viewport.newEventsBelow + 1,
        },
      };
    }
    case 'transcript.replace': {
      const index = state.transcript.findIndex((item) => item.id === event.id);
      if (index < 0 || state.transcript[index].sourceText === event.sourceText) return state;
      const transcript = [...state.transcript];
      transcript[index] = { ...transcript[index], sourceText: event.sourceText };
      return { ...state, eventSequence: nextSequence, transcript };
    }
    case 'viewport.clear':
      return {
        ...state,
        eventSequence: nextSequence,
        viewport: {
          epoch: state.viewport.epoch + 1,
          hiddenBeforeSequence: nextSequence,
          scrollOffset: 0,
          stickyTail: true,
          selectedRow: null,
          cachedWidth: null,
          cachedHeight: null,
          newEventsBelow: 0,
        },
      };
    case 'activity.upsert': {
      const current = state.activities[event.activity.id];
      if (current && (
        current.generation > event.activity.generation
        || TERMINAL_ACTIVITY_STATES.has(current.state)
      )) return state;
      return {
        ...state,
        eventSequence: nextSequence,
        activities: { ...state.activities, [event.activity.id]: { ...event.activity } },
      };
    }
    case 'activity.progress': {
      const current = state.activities[event.id];
      if (!current || current.generation !== event.generation || TERMINAL_ACTIVITY_STATES.has(current.state)) {
        return state;
      }
      if (current.summary === event.summary) return state;
      return {
        ...state,
        eventSequence: nextSequence,
        activities: { ...state.activities, [event.id]: { ...current, summary: event.summary } },
      };
    }
    case 'activity.terminal': {
      const current = state.activities[event.id];
      if (!current || current.generation !== event.generation || TERMINAL_ACTIVITY_STATES.has(current.state)) {
        return state;
      }
      return {
        ...state,
        eventSequence: nextSequence,
        activities: {
          ...state.activities,
          [event.id]: { ...current, state: event.state, summary: event.summary, endedAt: event.endedAt },
        },
      };
    }
    case 'activity.remove': {
      if (!state.activities[event.id]) return state;
      const activities = { ...state.activities };
      delete activities[event.id];
      return { ...state, eventSequence: nextSequence, activities };
    }
    case 'viewport.scroll': {
      const maximum = event.maxOffset === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor(event.maxOffset));
      const scrollOffset = Math.min(
        maximum,
        Math.max(0, state.viewport.scrollOffset + event.delta),
      );
      return {
        ...state,
        viewport: {
          ...state.viewport,
          stickyTail: scrollOffset === 0,
          scrollOffset,
          newEventsBelow: scrollOffset === 0 ? 0 : state.viewport.newEventsBelow,
        },
      };
    }
    case 'viewport.follow':
      return {
        ...state,
        viewport: { ...state.viewport, stickyTail: true, scrollOffset: 0, newEventsBelow: 0 },
      };
    case 'viewport.measure':
      if (state.viewport.cachedWidth === event.width && state.viewport.cachedHeight === event.height) return state;
      return {
        ...state,
        viewport: { ...state.viewport, cachedWidth: event.width, cachedHeight: event.height },
      };
  }
}

export function activeActivityRows(state: OperatorProjectionState): ActivityProjection[] {
  return Object.values(state.activities)
    .filter((activity) => !TERMINAL_ACTIVITY_STATES.has(activity.state))
    .sort((left, right) => left.startedSequence - right.startedSequence || left.id.localeCompare(right.id));
}

export function transcriptSource(state: OperatorProjectionState): string {
  return state.transcript.map((item) => item.sourceText).join('');
}

export function visibleTranscriptSource(state: OperatorProjectionState): string {
  return state.transcript
    .filter((item) => item.sequence > state.viewport.hiddenBeforeSequence)
    .map((item) => item.sourceText)
    .join('');
}
