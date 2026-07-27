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

export interface OperatorProjectionState {
  transcript: readonly TranscriptProjection[];
  activities: Readonly<Record<string, ActivityProjection>>;
  eventSequence: number;
  followTail: boolean;
  scrollOffset: number;
  newEventsBelow: number;
}

export type OperatorProjectionEvent =
  | { type: 'transcript.append'; id: string; kind: TranscriptKind; sourceText: string }
  | { type: 'transcript.replace'; id: string; sourceText: string }
  | { type: 'transcript.clear' }
  | { type: 'activity.upsert'; activity: ActivityProjection }
  | { type: 'activity.progress'; id: string; generation: number; summary: string }
  | { type: 'activity.terminal'; id: string; generation: number; state: Extract<OperatorActivityState,
      'succeeded' | 'failed' | 'denied' | 'interrupted' | 'cancelled' | 'timed_out' | 'unknown' | 'stale'>;
      summary: string; endedAt: number }
  | { type: 'activity.remove'; id: string }
  | { type: 'viewport.scroll'; delta: number }
  | { type: 'viewport.follow' };

const TERMINAL_ACTIVITY_STATES = new Set<OperatorActivityState>([
  'succeeded', 'failed', 'denied', 'interrupted', 'cancelled', 'timed_out', 'unknown', 'stale',
]);

export function initialOperatorProjection(): OperatorProjectionState {
  return {
    transcript: [], activities: {}, eventSequence: 0,
    followTail: true, scrollOffset: 0, newEventsBelow: 0,
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
        newEventsBelow: state.followTail ? 0 : state.newEventsBelow + 1,
      };
    }
    case 'transcript.replace': {
      const index = state.transcript.findIndex((item) => item.id === event.id);
      if (index < 0 || state.transcript[index].sourceText === event.sourceText) return state;
      const transcript = [...state.transcript];
      transcript[index] = { ...transcript[index], sourceText: event.sourceText };
      return { ...state, eventSequence: nextSequence, transcript };
    }
    case 'transcript.clear':
      return { ...state, eventSequence: nextSequence, transcript: [], newEventsBelow: 0 };
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
      const scrollOffset = Math.max(0, state.scrollOffset + event.delta);
      return {
        ...state,
        followTail: scrollOffset === 0,
        scrollOffset,
        newEventsBelow: scrollOffset === 0 ? 0 : state.newEventsBelow,
      };
    }
    case 'viewport.follow':
      return { ...state, followTail: true, scrollOffset: 0, newEventsBelow: 0 };
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
