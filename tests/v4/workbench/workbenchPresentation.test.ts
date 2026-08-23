/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  groupActiveWork,
  presentAssistantContent,
  presentApproval,
  presentResult,
  presentRuntimeDetail,
  presentRuntimeStatus,
  projectAttentionItems,
  presentAutomationOccurrence,
  projectSemanticProgress,
} from '../../../dashboard-next/lib/workbenchPresentation';

describe('Workbench product presentation', () => {
  it('translates runtime states into calm operator language without exposing enum syntax', () => {
    expect(presentRuntimeStatus('approval_required')).toMatchObject({
      label: 'Needs approval',
      nextAction: 'Review the requested action',
      tone: 'attention',
    });
    expect(presentRuntimeStatus('completed_unverified')).toMatchObject({
      label: 'Ready for review',
      tone: 'review',
    });
    expect(presentRuntimeStatus('blocked_unknown')).toMatchObject({
      label: 'Needs attention',
      tone: 'danger',
    });
    for (const status of ['approval_required', 'completed_unverified', 'blocked_unknown']) {
      expect(presentRuntimeStatus(status).label).not.toContain('_');
    }
    for (const status of [
      'stale_fence', 'verification_incomplete', 'reconciliation_required', 'unknown',
      'provider_unavailable', 'unsupported_model', 'target_drift', 'approval_expired',
      'process_cleanup_failed', 'artifact_missing',
    ]) {
      const presentation = presentRuntimeStatus(status);
      expect(presentation.label).not.toContain('_');
      expect(presentation.detail.length).toBeGreaterThan(12);
      expect(presentation.nextAction).toBeTruthy();
    }
  });

  it('groups work by operator intent instead of raw lifecycle status', () => {
    const groups = groupActiveWork([
      { jobId: 'approval', attemptId: 'a1', runId: 1, sessionId: 's', status: 'approval_required', updatedAt: 6 },
      { jobId: 'blocked', attemptId: 'a2', runId: 2, sessionId: 's', status: 'blocked', updatedAt: 5 },
      { jobId: 'running', attemptId: 'a3', runId: 3, sessionId: 's', status: 'running', updatedAt: 4 },
      { jobId: 'review', attemptId: 'a4', runId: 4, sessionId: 's', status: 'state_unknown', updatedAt: 3 },
      { jobId: 'done', attemptId: 'a5', runId: 5, sessionId: 's', status: 'terminal', updatedAt: 2 },
    ]);

    expect(groups.needsYou.map((job) => job.jobId)).toEqual(['approval', 'blocked']);
    expect(groups.running.map((job) => job.jobId)).toEqual(['running']);
    expect(groups.readyForReview.map((job) => job.jobId)).toEqual(['review']);
    expect(groups.recentlyCompleted.map((job) => job.jobId)).toEqual(['done']);
  });

  it('presents terminal outcomes as concise result cards with progressive proof', () => {
    expect(presentResult({ status: 'completed', summary: 'Three files were reviewed.', verdict: 'verified', evidenceCount: 3 })).toEqual({
      title: 'Verified',
      summary: 'Three files were reviewed.',
      proofLabel: '3 pieces of evidence',
      tone: 'success',
      primaryAction: null,
    });
    expect(presentResult({ status: 'completed_unverified', evidenceCount: 0 })).toMatchObject({
      title: 'Ready for review',
      proofLabel: 'Evidence details unavailable',
      tone: 'review',
    });
    const domains = {
      coding: ['Repository change ready', 'Review changes'],
      browser: ['Research complete', 'Read brief'],
      apps: ['Connected app updated', 'Open app'],
      artifact: ['Result ready', 'Preview'],
      failure: ['Could not complete this work', 'View reason'],
      recovery: ['Recovered safely', 'View recovery'],
    } as const;
    for (const [kind, [title, primaryAction]] of Object.entries(domains)) {
      expect(presentResult({ status: kind === 'failure' ? 'failed' : 'completed', kind: kind as keyof typeof domains })).toMatchObject({ title, primaryAction });
    }
  });

  it('translates provider transport failures into plain result language', () => {
    const result = presentResult({
      status: 'failed',
      summary: 'ProviderError: Network failure calling chatgpt-plus: fetch failed',
    });
    expect(result.summary).toBe('The selected provider could not be reached. No result was produced.');
    expect(result.summary).not.toMatch(/ProviderError|fetch failed/);
    expect(presentRuntimeDetail('ProviderError: fetch failed', 'terminal')).toBe('The selected provider could not be reached.');
    expect(presentAssistantContent('ProviderError: fetch failed')).toBe(
      'Aiden could not reach the selected provider. Check the connection or provider in Settings, then try again.',
    );
  });

  it('deduplicates attention by stable authority identity', () => {
    const attention = projectAttentionItems({
      jobs: [
        { jobId: 'job_1', attemptId: 'attempt_1', runId: 2, sessionId: 's', status: 'approval_required', updatedAt: 3, title: 'Update README' },
      ],
      approvals: [
        { approvalId: 'approval_1', jobId: 'job_1', attemptId: 'attempt_1', generation: 1, toolCallId: 'tool_1', effectId: null, toolName: 'file_write', target: 'README.md', riskTier: 'medium', state: 'created', requestedAt: 2, externalCoding: null },
        { approvalId: 'approval_1', jobId: 'job_1', attemptId: 'attempt_1', generation: 1, toolCallId: 'tool_1', effectId: null, toolName: 'file_write', target: 'README.md', riskTier: 'medium', state: 'displayed', requestedAt: 2, externalCoding: null },
      ],
    });

    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ id: 'approval:approval_1', jobId: 'job_1', label: 'Approval needed' });
  });

  it('presents approvals in what, where, why, impact, risk, and after-approval language', () => {
    const row = {
      approvalId: 'approval_1', jobId: 'job_1', attemptId: 'attempt_1', generation: 1,
      toolCallId: 'tool_1', effectId: 'effect_1', toolName: 'file_write', target: 'README.md',
      riskTier: 'medium', state: 'created', requestedAt: 2, externalCoding: null,
    };
    const approval = presentApproval(row);

    expect(approval).toMatchObject({
      what: 'Write a file',
      where: 'README.md',
      risk: 'Medium risk',
      afterApproval: 'Aiden will perform this exact action, then verify the result.',
      actionable: true,
    });
    expect(approval.why).toBeTruthy();
    expect(approval.impact).toBeTruthy();
    for (const state of ['approved', 'denied', 'cancelled', 'expired', 'stale']) {
      expect(presentApproval({ ...row, state }).actionable).toBe(false);
    }
  });

  it('reduces real activity into stable semantic phases without fabricating progress', () => {
    const phases = projectSemanticProgress([
      { id: 'skill_1', eventId: 1, kind: 'skill', label: 'systematic-debugging', status: 'ok' },
      { id: 'read_1', eventId: 2, kind: 'tool', label: 'Read package.json', status: 'ok' },
      { id: 'search_1', eventId: 3, kind: 'tool', label: 'Searching repository', status: 'running' },
      { id: 'search_1', eventId: 4, kind: 'tool', label: 'Search complete', status: 'ok' },
      { id: 'verify_1', eventId: 5, kind: 'verify', label: 'Verifying result', status: 'running' },
    ]);

    expect(phases.map((phase) => phase.label)).toEqual([
      'Understanding request',
      'Inspecting work',
      'Verifying result',
    ]);
    expect(phases[1]).toMatchObject({ status: 'complete', sourceIds: ['read_1', 'search_1'] });
    expect(phases[2]).toMatchObject({ status: 'running', sourceIds: ['verify_1'] });
    expect(phases.every((phase) => phase.sourceIds.length > 0)).toBe(true);
  });

  it('presents a completed prompt-only automation as completed without inventing missing delivery', () => {
    expect(presentAutomationOccurrence({ state: 'completed', delivery: null })).toEqual({
      label: 'Task completed',
      tone: 'success',
    });
    expect(presentAutomationOccurrence({ state: 'running', delivery: null })).toEqual({
      label: 'Task in progress',
      tone: 'running',
    });
    expect(presentAutomationOccurrence({ state: 'completed', delivery: { state: 'completed' } })).toEqual({
      label: 'Result delivered',
      tone: 'success',
    });
  });
});
