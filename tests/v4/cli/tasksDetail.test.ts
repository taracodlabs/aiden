/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.13 Gap 3 — /tasks <id> job-card detail renderer.
 *
 * Fully-populated card renders every section; a minimal row (all
 * job-card fields null/empty) renders cleanly — no `undefined`, no
 * crash, no phantom section headers.
 */
import { describe, it, expect } from 'vitest';

import { renderTaskDetail } from '../../../cli/v4/commands/tasksDetail';
import type { Task } from '../../../core/v4/daemon/taskStore';

function render(t: Task): string {
  const out: string[] = [];
  renderTaskDetail(t, (s) => out.push(s));
  return out.join('');
}

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task_render01', title: 'do the thing', goal: 'do the thing',
    status: 'completed', createdAt: 1, updatedAt: 2,
    channelId: 'repl', sessionId: 's', parentTaskId: null,
    traceIds: [], artifactIds: [],
    evidence: null, constraints: null, filesTouched: [], sideEffects: [],
    failureState: null, permissions: null,
    ...over,
  };
}

describe('renderTaskDetail', () => {
  it('renders every populated job-card section', () => {
    const text = render(baseTask({
      status: 'verification_failed',
      goal: 'write two files and build',
      constraints: { scope: 'src-only' },
      permissions: { approvalMode: 'smart' },
      filesTouched: ['C:/a.txt', 'C:/b.txt'],
      sideEffects: [
        { tool: 'file_write', target: 'C:/a.txt', verified: true, evidence: 'bytes=5' },
        { tool: 'shell_exec', target: 'build', verified: false, evidence: 'exit_code=1' },
      ],
      artifactIds: ['art_1'],
      failureState: {
        class: 'network',
        reason: 'network unreachable',
        whatWasTried: [{ attempt: 1, category: 'network', reason: 'refused', backoffMs: 400 }],
        whenAt: 3,
      },
      evidence: {
        v: 1, verdict: 'verification_failed', decidedAt: 4,
        handles: [{ tool: 'file_write', kind: 'path', value: 'C:/a.txt', verified: true, code: 'ok' }],
        failures: [{ tool: 'shell_exec', reason: 'exit 1' }],
      },
    }));
    expect(text).toMatch(/Task task_render01 \[verification_failed\]/);
    expect(text).toMatch(/goal: {4}write two files and build/);
    expect(text).toMatch(/constraints: \{"scope":"src-only"\}/);
    expect(text).toMatch(/permissions: \{"approvalMode":"smart"\}/);
    expect(text).toMatch(/files touched \(2\):/);
    expect(text).toMatch(/C:\/a\.txt/);
    expect(text).toMatch(/✓ file_write → C:\/a\.txt \(bytes=5\)/);
    expect(text).toMatch(/· shell_exec → build \(exit_code=1\)/);
    expect(text).toMatch(/artifacts: art_1/);
    expect(text).toMatch(/failure state: network — network unreachable/);
    expect(text).toMatch(/attempt 1: network \(refused\), backoff 400ms/);
    expect(text).toMatch(/verification: verification_failed/);
    expect(text).toMatch(/✗ shell_exec: exit 1/);
  });

  it('minimal row renders cleanly — null fields omitted, never `undefined`', () => {
    const text = render(baseTask());
    expect(text).toMatch(/Task task_render01 \[completed\]/);
    expect(text).toMatch(/\(no verification evidence recorded\)/);
    expect(text).not.toMatch(/undefined/);
    expect(text).not.toMatch(/constraints/);
    expect(text).not.toMatch(/failure state/);
    expect(text).not.toMatch(/files touched/);
    expect(text).not.toMatch(/side effects/);
  });
});
