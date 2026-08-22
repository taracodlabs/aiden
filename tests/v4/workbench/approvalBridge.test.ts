/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';
import type { ActionAuthority, ApprovalRecord } from '../../../core/v4/actionAuthority';
import { DurableJobHostDetachedError } from '../../../core/v4/daemon/jobLifecycle';
import { buildWorkbenchApprovalCallbacks } from '../../../core/v4/workbench/approvalBridge';

function record(state: ApprovalRecord['state'], overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: 'approval_exact',
    jobId: 'job_exact',
    attemptId: 'attempt_exact',
    generation: 3,
    toolCallId: 'tool_call_exact',
    effectId: 'effect_exact',
    requestSequence: 1,
    toolName: 'file_write',
    riskTier: 'caution',
    riskReasons: [],
    normalizedExecutionPlan: {},
    actionDigest: 'action_digest',
    policySnapshotId: 'policy_snapshot',
    fenceTokenDigest: 'fence_digest',
    state,
    decision: state === 'approved' ? 'approved' : state === 'denied' ? 'denied' : null,
    decisionInputId: null,
    decisionScope: null,
    decidedBy: null,
    decisionChannel: null,
    requestedAt: 1,
    displayedAt: 2,
    decidedAt: null,
    expiresAt: null,
    executedAt: null,
    invalidationReason: null,
    ...overrides,
  };
}

function authority(read: () => ApprovalRecord | null): ActionAuthority {
  return { get: () => read() } as unknown as ActionAuthority;
}

describe('Workbench durable approval bridge', () => {
  it('waits for the exact durable approval and resumes only after approval', async () => {
    let reads = 0;
    const callbacks = buildWorkbenchApprovalCallbacks({
      authority: authority(() => record(++reads >= 3 ? 'approved' : 'displayed')),
      jobId: 'job_exact',
      attemptId: 'attempt_exact',
      generation: 3,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    await expect(callbacks.promptUser?.({
      toolName: 'file_write',
      category: 'write',
      args: {},
      durableApprovalId: 'approval_exact',
    })).resolves.toBe('allow');
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('maps an exact durable denial to deny', async () => {
    const callbacks = buildWorkbenchApprovalCallbacks({
      authority: authority(() => record('denied')),
      jobId: 'job_exact',
      attemptId: 'attempt_exact',
      generation: 3,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    await expect(callbacks.promptUser?.({
      toolName: 'file_write', category: 'write', args: {}, durableApprovalId: 'approval_exact',
    })).resolves.toBe('deny');
  });

  it('fails closed for a stale Attempt binding', async () => {
    const callbacks = buildWorkbenchApprovalCallbacks({
      authority: authority(() => record('approved', { attemptId: 'attempt_stale' })),
      jobId: 'job_exact',
      attemptId: 'attempt_exact',
      generation: 3,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    await expect(callbacks.promptUser?.({
      toolName: 'file_write', category: 'write', args: {}, durableApprovalId: 'approval_exact',
    })).resolves.toBe('deny');
  });

  it('interrupts a pending approval when the authoritative Attempt is aborted', async () => {
    const controller = new AbortController();
    const callbacks = buildWorkbenchApprovalCallbacks({
      authority: authority(() => record('displayed')),
      jobId: 'job_exact',
      attemptId: 'attempt_exact',
      generation: 3,
      signal: controller.signal,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });
    const decision = callbacks.promptUser?.({
      toolName: 'file_write', category: 'write', args: {}, durableApprovalId: 'approval_exact',
    });
    controller.abort();
    await expect(decision).resolves.toBe('interrupted');
  });

  it('propagates host detachment without converting it into a user cancellation', async () => {
    const controller = new AbortController();
    const callbacks = buildWorkbenchApprovalCallbacks({
      authority: authority(() => record('displayed')),
      jobId: 'job_exact',
      attemptId: 'attempt_exact',
      generation: 3,
      signal: controller.signal,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });
    const decision = callbacks.promptUser?.({
      toolName: 'file_write', category: 'write', args: {}, durableApprovalId: 'approval_exact',
    });
    controller.abort(new DurableJobHostDetachedError('Workbench host shutdown'));
    await expect(decision).rejects.toMatchObject({ name: 'DurableJobHostDetachedError' });
  });
});
