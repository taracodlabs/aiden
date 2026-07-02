/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 1 — external idempotent-replay skips reach the task
 * evidence envelope and render the ↷ line on /tasks, reusing the exact
 * skipped[] shape the batch-staleness guard already uses.
 *
 * External channel deliveries happen at the DeliveryContext seam, NOT via a
 * tool in the trace — so the daemon runner collects them from the ledger and
 * passes `externalSkips` into computeTaskFinalization, which merges them into
 * evidence.skipped[]. renderTaskDetail then paints ↷ with no renderer change.
 */
import { describe, it, expect } from 'vitest';
import { computeTaskFinalization } from '../../../core/v4/taskVerification';
import { renderTaskDetail } from '../../../cli/v4/commands/tasksDetail';
import type { Task } from '../../../core/v4/daemon/taskStore';

describe('computeTaskFinalization — externalSkips merge into evidence.skipped', () => {
  it('external skips land on evidence.skipped alongside batch-staleness skips', () => {
    const fin = computeTaskFinalization(
      { finishReason: 'stop', toolCallTrace: [] },
      {
        now: 1_000,
        externalSkips: [
          { tool: 'channel_send', target: 'discord:c1', reason: 'idempotent_replay — already delivered in a prior run' },
        ],
      },
    );
    expect(fin.status).toBe('completed');
    expect(fin.evidence.skipped).toBeDefined();
    expect(fin.evidence.skipped).toEqual([
      { tool: 'channel_send', target: 'discord:c1', reason: 'idempotent_replay — already delivered in a prior run' },
    ]);
  });

  it('no externalSkips → no skipped key added (envelope unchanged)', () => {
    const fin = computeTaskFinalization({ finishReason: 'stop', toolCallTrace: [] }, { now: 1_000 });
    expect(fin.evidence.skipped).toBeUndefined();
  });

  it('renders the ↷ line on /tasks detail', () => {
    const fin = computeTaskFinalization(
      { finishReason: 'stop', toolCallTrace: [] },
      { now: 1_000, externalSkips: [{ tool: 'channel_send', target: 'discord:c1', reason: 'idempotent_replay — already delivered in a prior run' }] },
    );
    const task: Task = {
      id: 'task_1', title: 'reply', goal: 'reply', status: 'completed',
      createdAt: 1_000, updatedAt: 1_000, channelId: 'daemon', sessionId: 's',
      parentTaskId: null, traceIds: [], artifactIds: [],
      evidence: fin.evidence, constraints: null, filesTouched: [], sideEffects: [],
      failureState: null, permissions: null, resumeCount: 1,
    };
    const out: string[] = [];
    renderTaskDetail(task, (s) => out.push(s));
    const text = out.join('');
    expect(text).toMatch(/↷ channel_send → discord:c1/);
    expect(text).toMatch(/idempotent_replay/);
  });
});
