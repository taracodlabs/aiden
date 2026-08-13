/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  durableApprovalCards,
  mergeLiveActivity,
  pendingApprovalCards,
  selectChatLiveActivity,
  shouldShowChatTelemetry,
  summarizeCompletedActivity,
  type LiveActivityItem,
} from '../../../dashboard-next/lib/workbenchUx';

describe('Workbench premium UX projections', () => {
  it('settles one live activity by exact semantic identity without duplicating it', () => {
    const running: LiveActivityItem = {
      id: 'tool:call_exact',
      eventId: 10,
      kind: 'tool',
      label: 'Read',
      detail: 'package.json',
      status: 'running',
    };
    const completed: LiveActivityItem = {
      ...running,
      eventId: 11,
      detail: 'package.json · 12 ms',
      status: 'ok',
    };

    expect(mergeLiveActivity(mergeLiveActivity([], running), completed)).toEqual([completed]);
  });

  it('does not deduplicate distinct calls merely because their text matches', () => {
    const first: LiveActivityItem = {
      id: 'tool:call_a', eventId: 10, kind: 'tool', label: 'Read', detail: 'README.md', status: 'ok',
    };
    const second: LiveActivityItem = {
      id: 'tool:call_b', eventId: 11, kind: 'tool', label: 'Read', detail: 'README.md', status: 'ok',
    };

    expect(mergeLiveActivity(mergeLiveActivity([], first), second)).toHaveLength(2);
  });

  it('summarizes completed activity without hiding failures or verification', () => {
    const items: LiveActivityItem[] = [
      { id: 'tool:a', eventId: 1, kind: 'tool', label: 'Read', status: 'ok' },
      { id: 'tool:b', eventId: 2, kind: 'tool', label: 'Write', status: 'failed' },
      { id: 'verify:c', eventId: 3, kind: 'verify', label: 'Verified', status: 'ok' },
    ];

    expect(summarizeCompletedActivity(items)).toEqual({ total: 3, succeeded: 2, failed: 1, running: 0 });
  });

  it('keeps Chat activity ephemeral and bounded to the current observable work', () => {
    const items: LiveActivityItem[] = [
      { id: 'tool:a', eventId: 1, kind: 'tool', label: 'Read package.json', status: 'ok' },
      { id: 'tool:b', eventId: 2, kind: 'tool', label: 'Read README.md', status: 'ok' },
      { id: 'tool:c', eventId: 3, kind: 'tool', label: 'Search repository', status: 'ok' },
      { id: 'tool:d', eventId: 4, kind: 'tool', label: 'Run tests', status: 'running' },
      { id: 'tool:e', eventId: 5, kind: 'tool', label: 'Future event', status: 'ok' },
    ];

    expect(selectChatLiveActivity(items)).toEqual(items.slice(1, 4));
    expect(shouldShowChatTelemetry({ running: true, pendingApprovalCount: 0 })).toBe(true);
    expect(shouldShowChatTelemetry({ running: false, pendingApprovalCount: 1 })).toBe(true);
    expect(shouldShowChatTelemetry({ running: false, pendingApprovalCount: 0 })).toBe(false);
    expect(shouldShowChatTelemetry({ running: true, pendingApprovalCount: 0, terminal: true })).toBe(false);
    expect(shouldShowChatTelemetry({ running: true, pendingApprovalCount: 1, terminal: true })).toBe(true);
  });

  it('projects only exact pending approvals and preserves their durable bindings', () => {
    const approvals = pendingApprovalCards([
      {
        approval_id: 'approval_exact', job_id: 'job_exact', attempt_id: 'attempt_exact',
        generation: 3, tool_call_id: 'tool_exact', effect_id: 'effect_exact',
        tool_name: 'file_write', risk_tier: 'mutating', state: 'displayed',
        normalized_execution_plan: JSON.stringify({
          affectedResources: ['C:\\Temp\\approval-target.txt'],
          args: { path: 'C:\\Temp\\approval-target.txt', content: 'private content' },
        }),
        requested_at: 100,
      },
      {
        approval_id: 'approval_done', job_id: 'job_exact', attempt_id: 'attempt_exact',
        generation: 3, tool_call_id: 'tool_done', effect_id: 'effect_done',
        tool_name: 'file_write', risk_tier: 'mutating', state: 'denied',
        requested_at: 90,
      },
    ]);

    expect(approvals).toEqual([{
      approvalId: 'approval_exact',
      jobId: 'job_exact',
      attemptId: 'attempt_exact',
      generation: 3,
      toolCallId: 'tool_exact',
      effectId: 'effect_exact',
      toolName: 'file_write',
      target: 'C:\\Temp\\approval-target.txt',
      riskTier: 'mutating',
      state: 'displayed',
      requestedAt: 100,
    }]);
  });

  it('retains the exact durable approval after it is resolved for truthful card updates', () => {
    expect(durableApprovalCards([{
      approval_id: 'approval_done', job_id: 'job_exact', attempt_id: 'attempt_exact',
      generation: 3, tool_call_id: 'tool_done', effect_id: 'effect_done',
      tool_name: 'file_write', risk_tier: 'mutating', state: 'denied', requested_at: 90,
    }])).toMatchObject([{ approvalId: 'approval_done', state: 'denied', generation: 3 }]);
  });
});
