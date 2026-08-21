/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  artifactPresentationForMime,
  codingReconciliationNeedsAttention,
  conversationForExactRun,
  durableApprovalCards,
  mergeLiveActivity,
  pendingApprovalsForProjection,
  pendingApprovalCards,
  projectRecommendedApps,
  selectChatLiveActivity,
  shouldShowChatTelemetry,
  summarizeCompletedActivity,
  type LiveActivityItem,
} from '../../../dashboard-next/lib/workbenchUx';

describe('artifact presentation', () => {
  it('renders safe text formats and keeps unknown binary content downloadable', () => {
    expect(artifactPresentationForMime('text/plain; charset=utf-8')).toBe('text');
    expect(artifactPresentationForMime('application/json')).toBe('text');
    expect(artifactPresentationForMime('image/svg+xml')).toBe('svg');
    expect(artifactPresentationForMime('image/png')).toBe('image');
    expect(artifactPresentationForMime('application/octet-stream')).toBe('download');
  });
});

describe('durable conversation restoration', () => {
  it('reuses a persisted assistant response only for the exact Job, Attempt, and run', () => {
    const conversations = [
      { id: 'old', jobId: 'job_exact', attemptId: 'attempt_old', runId: 10, messages: ['old'] },
      { id: 'exact', jobId: 'job_exact', attemptId: 'attempt_exact', runId: 11, messages: ['answer'] },
    ];

    expect(conversationForExactRun(conversations, {
      jobId: 'job_exact', attemptId: 'attempt_exact', runId: 11,
    }))?.toMatchObject({ id: 'exact', messages: ['answer'] });
    expect(conversationForExactRun(conversations, {
      jobId: 'job_exact', attemptId: 'attempt_exact', runId: 12,
    })).toBeNull();
  });
});

describe('Workbench premium UX projections', () => {
  it('does not label a durably reconciled coding cancellation as requiring reconciliation', () => {
    expect(codingReconciliationNeedsAttention('required')).toBe(true);
    expect(codingReconciliationNeedsAttention('inspecting')).toBe(true);
    expect(codingReconciliationNeedsAttention('blocked_unknown')).toBe(true);
    expect(codingReconciliationNeedsAttention('reconciled')).toBe(false);
    expect(codingReconciliationNeedsAttention('not_required')).toBe(false);
  });

  it('shows useful Apps targets without fabricating unavailable connections', () => {
    const cards = projectRecommendedApps({ providers: [], toolkits: [], accounts: [] });

    expect(cards.map((card) => card.id)).toEqual(['github', 'gmail', 'more']);
    expect(cards.slice(0, 2).every((card) => card.canConnect === false)).toBe(true);
    expect(cards.slice(0, 2).every((card) => card.accounts.length === 0)).toBe(true);
  });

  it('binds app cards only to exact advertised toolkits and preserves multiple accounts', () => {
    const cards = projectRecommendedApps({
      providers: [{ id: 'composio', health: 'healthy' }],
      toolkits: [
        { providerId: 'composio', toolkitId: 'github', label: 'GitHub' },
        { providerId: 'composio', toolkitId: 'gmail', label: 'Gmail' },
      ],
      accounts: [
        { accountId: 'acct_personal', providerId: 'composio', toolkitId: 'github', label: 'Personal', status: 'connected', health: 'healthy' },
        { accountId: 'acct_work', providerId: 'composio', toolkitId: 'github', label: 'TARACOD', status: 'connected', health: 'degraded' },
      ],
    });

    expect(cards[0]).toMatchObject({ id: 'github', canConnect: true, accounts: [
      { accountId: 'acct_personal', label: 'Personal' },
      { accountId: 'acct_work', label: 'TARACOD', needsReconnect: true },
    ] });
    expect(cards[1]).toMatchObject({ id: 'gmail', canConnect: true, accounts: [] });
  });

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
      externalCoding: null,
    }]);
  });

  it('projects the exact external-coding envelope for an actionable approval card', () => {
    const approvals = pendingApprovalCards([{
      approval_id: 'approval_coding', job_id: 'job_coding', attempt_id: 'attempt_coding',
      generation: 4, tool_call_id: 'tool_coding', effect_id: 'effect_coding',
      tool_name: 'external_coding', risk_tier: 'dangerous', state: 'displayed',
      normalized_execution_plan: JSON.stringify({
        cwd: 'C:\\fixture',
        affectedResources: [],
        args: {
          goal: 'Fix the failing test.',
          allowed_scope: ['src/value.js'],
          protected_paths: ['PROTECTED.md'],
        },
      }),
      requested_at: 120,
    }]);

    expect(approvals).toMatchObject([{
      approvalId: 'approval_coding',
      toolName: 'external_coding',
      externalCoding: {
        repository: 'C:\\fixture',
        requestedScope: ['src/value.js'],
        protectedPaths: ['PROTECTED.md'],
        networkPolicy: 'disabled',
        packagePolicy: 'deny',
        gitWriteOperations: 'disabled',
        isolatedUntilPromotion: true,
      },
    }]);
  });

  it('retains the exact durable approval after it is resolved for truthful card updates', () => {
    expect(durableApprovalCards([{
      approval_id: 'approval_done', job_id: 'job_exact', attempt_id: 'attempt_exact',
      generation: 3, tool_call_id: 'tool_done', effect_id: 'effect_done',
      tool_name: 'file_write', risk_tier: 'mutating', state: 'denied', requested_at: 90,
    }])).toMatchObject([{ approvalId: 'approval_done', state: 'denied', generation: 3 }]);
  });

  it('restores pending approvals from the exact durable projection identity, not stale browser selection', () => {
    const rows = [{
      approval_id: 'approval_restored', job_id: 'job_exact', attempt_id: 'attempt_exact',
      generation: 4, tool_call_id: 'tool_exact', effect_id: 'effect_exact',
      tool_name: 'file_write', risk_tier: 'mutating', state: 'displayed', requested_at: 100,
    }];

    expect(pendingApprovalsForProjection(rows, {
      jobId: 'job_exact', attemptId: 'attempt_exact', generation: 4,
    })).toMatchObject([{ approvalId: 'approval_restored' }]);
    expect(pendingApprovalsForProjection(rows, {
      jobId: 'job_exact', attemptId: 'attempt_replaced', generation: 4,
    })).toEqual([]);
  });
});
