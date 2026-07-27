/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import { describe, expect, it } from 'vitest';

import {
  activeActivityRows,
  initialOperatorProjection,
  reduceOperatorProjection,
  transcriptSource,
  type ActivityProjection,
  type OperatorProjectionState,
} from '../../../cli/v4/operatorProjection';

function activity(id: string, generation = 1, startedSequence = 1): ActivityProjection {
  return {
    id, parentId: null, jobId: 'job_1', attemptId: 'attempt_1', generation,
    startedSequence, state: 'running', startedAt: 10, endedAt: null,
    summary: `${id} running`, detailsRef: null,
  };
}

function add(state: OperatorProjectionState, value: ActivityProjection): OperatorProjectionState {
  return reduceOperatorProjection(state, { type: 'activity.upsert', activity: value });
}

describe('operator projection', () => {
  it('keeps transcript source content in ordered semantic blocks', () => {
    let state = initialOperatorProjection();
    state = reduceOperatorProjection(state, {
      type: 'transcript.append', id: 'u1', kind: 'user', sourceText: 'hello\n',
    });
    state = reduceOperatorProjection(state, {
      type: 'transcript.append', id: 'a1', kind: 'assistant', sourceText: 'world\n',
    });
    expect(transcriptSource(state)).toBe('hello\nworld\n');
  });

  it('deduplicates replayed transcript identities', () => {
    let state = initialOperatorProjection();
    const event = { type: 'transcript.append', id: 'n1', kind: 'notice', sourceText: 'once\n' } as const;
    state = reduceOperatorProjection(state, event);
    expect(reduceOperatorProjection(state, event)).toBe(state);
  });

  it('replaces one streaming block without duplicating it', () => {
    let state = initialOperatorProjection();
    state = reduceOperatorProjection(state, {
      type: 'transcript.append', id: 'a1', kind: 'assistant', sourceText: 'part',
    });
    state = reduceOperatorProjection(state, {
      type: 'transcript.replace', id: 'a1', sourceText: 'part complete',
    });
    expect(state.transcript).toHaveLength(1);
    expect(transcriptSource(state)).toBe('part complete');
  });

  it('orders same-name activities by sequence and stable identity', () => {
    let state = initialOperatorProjection();
    state = add(state, activity('tool_b', 1, 2));
    state = add(state, activity('tool_a', 1, 1));
    expect(activeActivityRows(state).map((row) => row.id)).toEqual(['tool_a', 'tool_b']);
  });

  it('ignores progress from a stale generation', () => {
    let state = add(initialOperatorProjection(), activity('tool_1', 2));
    const next = reduceOperatorProjection(state, {
      type: 'activity.progress', id: 'tool_1', generation: 1, summary: 'stale',
    });
    expect(next).toBe(state);
  });

  it('does not replace a newer generation with an older activity', () => {
    let state = add(initialOperatorProjection(), activity('tool_1', 2));
    const next = add(state, activity('tool_1', 1));
    expect(next).toBe(state);
  });

  it('makes terminal state monotonic against late progress', () => {
    let state = add(initialOperatorProjection(), activity('tool_1'));
    state = reduceOperatorProjection(state, {
      type: 'activity.terminal', id: 'tool_1', generation: 1,
      state: 'failed', summary: 'failed', endedAt: 20,
    });
    const next = reduceOperatorProjection(state, {
      type: 'activity.progress', id: 'tool_1', generation: 1, summary: 'running again',
    });
    expect(next).toBe(state);
    expect(state.activities.tool_1.state).toBe('failed');
  });

  it('makes duplicate terminal events idempotent', () => {
    let state = add(initialOperatorProjection(), activity('tool_1'));
    const event = {
      type: 'activity.terminal', id: 'tool_1', generation: 1,
      state: 'succeeded', summary: 'done', endedAt: 20,
    } as const;
    state = reduceOperatorProjection(state, event);
    expect(reduceOperatorProjection(state, event)).toBe(state);
  });

  it('removes a projected row without mutating the prior snapshot', () => {
    const prior = add(initialOperatorProjection(), activity('tool_1'));
    const next = reduceOperatorProjection(prior, { type: 'activity.remove', id: 'tool_1' });
    expect(prior.activities.tool_1).toBeDefined();
    expect(next.activities.tool_1).toBeUndefined();
  });

  it('does not project terminal activities into the live region', () => {
    let state = add(initialOperatorProjection(), activity('tool_1'));
    state = reduceOperatorProjection(state, {
      type: 'activity.terminal', id: 'tool_1', generation: 1,
      state: 'unknown', summary: 'outcome unknown', endedAt: 20,
    });
    expect(activeActivityRows(state)).toEqual([]);
  });

  it('freezes the viewport and counts new transcript events below', () => {
    let state = reduceOperatorProjection(initialOperatorProjection(), {
      type: 'viewport.scroll', delta: 8,
    });
    state = reduceOperatorProjection(state, {
      type: 'transcript.append', id: 'n1', kind: 'notice', sourceText: 'later\n',
    });
    expect(state.followTail).toBe(false);
    expect(state.newEventsBelow).toBe(1);
  });

  it('End-style follow returns to the live tail and clears the counter', () => {
    let state = reduceOperatorProjection(initialOperatorProjection(), {
      type: 'viewport.scroll', delta: 8,
    });
    state = reduceOperatorProjection(state, {
      type: 'transcript.append', id: 'n1', kind: 'notice', sourceText: 'later\n',
    });
    state = reduceOperatorProjection(state, { type: 'viewport.follow' });
    expect(state).toMatchObject({ followTail: true, scrollOffset: 0, newEventsBelow: 0 });
  });
});
