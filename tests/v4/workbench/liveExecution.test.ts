/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  projectLiveExecution,
  redactTerminalOutput,
  type LiveExecutionSource,
} from '../../../core/v4/workbench/liveExecution';

function source(overrides: Partial<LiveExecutionSource> = {}): LiveExecutionSource {
  return {
    projection: {
      schemaVersion: 1,
      identity: {
        jobId: 'job_1', rootJobId: 'job_1', attemptId: 'attempt_1', runId: 7,
        generation: 3, sessionId: 'session_1', workspaceId: 'workspace_1',
      },
      job: { id: 'job_1', title: 'Fix authentication', status: 'running' },
      activeAttempt: { id: 'attempt_1', generation: 3, status: 'running' },
      attempts: [], timeline: [], workers: [], approvals: [], effects: [], claims: [], evidence: [],
      verification: null,
      receipt: { terminal: false, status: 'running', outcome: null, finishReason: null, verdict: null, summary: 'running' },
      eventCursor: 12,
    } as never,
    runEvents: [],
    codingSessions: [],
    codingOutput: () => [],
    browser: null,
    artifacts: [],
    ...overrides,
  };
}

describe('Live Execution projection', () => {
  it('S1 binds every surface to the exact Job, Attempt, generation, and run', () => {
    const result = projectLiveExecution(source({
      codingSessions: [{
        codingSessionId: 'coding_1', childJobId: 'child_1', childAttemptId: 'child_attempt_1',
        generation: 1, assignmentId: 'assignment_1', workerRunId: 'worker_1', state: 'running',
        reconciliationState: 'not_required', provider: { id: 'provider', version: '1', protocolMode: 'jsonl', protocolVersion: '1', capabilityDigest: 'digest' },
        workspace: { workspaceLeaseId: 'workspace_lease_1', state: 'ready', baseHead: 'abc', baseBranch: 'main' },
        process: { state: 'running', exitCode: null, exitSignal: null, treeDeadVerified: false },
        events: [], changedPaths: [], mutationState: null, reconciliation: null, promotion: null,
        validationRefs: [], createdAt: 1, startedAt: 2, lastActivityAt: 3, terminalAt: null,
      }],
    }));
    expect(result?.surfaces.length).toBeGreaterThan(0);
    expect(result?.surfaces.every((surface) => surface.jobId === 'job_1'
      && surface.attemptId === 'attempt_1' && surface.generation === 3 && surface.runId === 7)).toBe(true);
  });

  it('S2-S3 rejects wrong Job, Attempt, run, and stale generation requests', () => {
    const exact = { jobId: 'job_1', attemptId: 'attempt_1', generation: 3, runId: 7 };
    expect(projectLiveExecution(source(), { ...exact, jobId: 'job_2' })).toBeNull();
    expect(projectLiveExecution(source(), { ...exact, attemptId: 'attempt_old' })).toBeNull();
    expect(projectLiveExecution(source(), { ...exact, generation: 2 })).toBeNull();
    expect(projectLiveExecution(source(), { ...exact, runId: 8 })).toBeNull();
  });

  it('S4 projects duplicate surface events idempotently by exact authority identity', () => {
    const common = {
      runId: 7, sessionId: 'session_1', turnId: null, category: 'integration', kind: 'app.action',
      name: 'github.issue.create', toolCallId: 'tool_exact', parentEventId: null,
      durationMs: null, payload: '{}', payloadTruncated: false, payloadBytes: null, payloadRef: null,
      visibility: 'system', source: 'github',
    } as const;
    const result = projectLiveExecution(source({ runEvents: [
      { ...common, id: 1, seq: 1, ts: 1, status: 'waiting', summary: 'Create issue' },
      { ...common, id: 2, seq: 2, ts: 2, status: 'ok', summary: 'Issue created' },
    ] }));
    const apps = result?.surfaces.filter((surface) => surface.kind === 'app_action');
    expect(apps).toHaveLength(1);
    expect(apps?.[0]).toMatchObject({ surfaceId: 'surface:app:tool_exact', appAction: { action: 'Issue created', state: 'ok' } });
  });

  it('T2-T6 orders, bounds, redacts, and replays terminal output by stream sequence', () => {
    const result = projectLiveExecution(source({
      codingSessions: [{
        codingSessionId: 'coding_1', childJobId: 'child_1', childAttemptId: 'child_attempt_1', generation: 1,
        assignmentId: 'assignment_1', workerRunId: 'worker_1', state: 'running', reconciliationState: 'not_required',
        provider: { id: 'provider', version: '1', protocolMode: 'jsonl', protocolVersion: '1', capabilityDigest: 'digest' },
        workspace: null, process: { state: 'running', exitCode: null, exitSignal: null, treeDeadVerified: false },
        events: [], changedPaths: [], mutationState: null, reconciliation: null, promotion: null, validationRefs: [],
        createdAt: 1, startedAt: 1, lastActivityAt: 4, terminalAt: null,
      }],
      codingOutput: () => [
        { codingSessionId: 'coding_1', chunkSequence: 3, stream: 'stdout', content: 'done', byteCount: 4, truncated: false, createdAt: 3 },
        { codingSessionId: 'coding_1', chunkSequence: 1, stream: 'stdout', content: 'Authorization: Bearer secret-token-value', byteCount: 40, truncated: false, createdAt: 1 },
        { codingSessionId: 'coding_1', chunkSequence: 2, stream: 'stderr', content: 'API_KEY=super-secret-value', byteCount: 26, truncated: false, createdAt: 2 },
      ],
    }), undefined, { terminalChunkLimit: 2 });
    const terminal = result?.surfaces.find((surface) => surface.kind === 'terminal');
    expect(terminal?.terminal?.chunks.map((chunk) => chunk.streamSeq)).toEqual([2, 3]);
    expect(JSON.stringify(terminal)).not.toContain('super-secret-value');
    expect(terminal?.terminal?.latestStreamSeq).toBe(3);
    expect(terminal?.terminal?.truncated).toBe(true);
  });

  it('B1-B4 projects one exact BrowserSession and controlled tab without inventing a frame', () => {
    const result = projectLiveExecution(source({ browser: {
      session: {
        browserSessionId: 'browser_1', jobId: 'job_1', attemptId: 'attempt_1', generation: 3,
        workspaceId: 'workspace_1', mode: 'owned', profileIdentity: 'profile', state: 'ready',
        controlledTabId: 'tab_1', recoveryState: 'none', leaseEpoch: 1, usage: {}, budget: {},
        createdAt: 1, updatedAt: 20, closedAt: null,
      } as never,
      tabs: [{
        browserSessionId: 'browser_1', tabId: 'tab_1', ownerJobId: 'job_1', ownerAttemptId: 'attempt_1',
        ownerGeneration: 3, createdBy: 'aiden', controlled: true, openerTabId: null, purpose: 'research',
        url: 'https://example.com/', normalizedUrl: 'https://example.com/', title: 'Example Domain',
        dirtyForm: false, lastStateDigest: 'state_1', lastObservedAt: 19, lastEvidenceAt: 19,
        closePolicy: 'aiden_owned', createdAt: 2, updatedAt: 19, closedAt: null,
      }],
    } }));
    const browser = result?.surfaces.find((surface) => surface.kind === 'browser');
    expect(browser?.browser).toMatchObject({ browserSessionId: 'browser_1', tabId: 'tab_1', url: 'https://example.com/', title: 'Example Domain', frame: null });
  });

  it('P3 creates contextual workspace, changes, validation, artifact, and app-action surfaces', () => {
    const coding = {
      codingSessionId: 'coding_1', childJobId: 'child_1', childAttemptId: 'child_attempt_1', generation: 1,
      assignmentId: 'assignment_1', workerRunId: 'worker_1', state: 'ready_for_review', reconciliationState: 'not_required',
      provider: { id: 'provider', version: '1', protocolMode: 'jsonl', protocolVersion: '1', capabilityDigest: 'digest' },
      workspace: { workspaceLeaseId: 'lease_1', state: 'review_pending', baseHead: 'abc', baseBranch: 'main' },
      process: { state: 'exited', exitCode: 0, exitSignal: null, treeDeadVerified: true }, events: [],
      changedPaths: ['src/a.ts'], mutationState: 'observed', reconciliation: null,
      promotion: { promotionId: 'promotion_1', state: 'prepared', changedPaths: ['src/a.ts'], validationRefs: ['validation_1'], blockedReason: null },
      validationRefs: ['validation_1'], createdAt: 1, startedAt: 2, lastActivityAt: 3, terminalAt: 4,
    };
    const result = projectLiveExecution(source({
      codingSessions: [coding],
      artifacts: [{ id: 'artifact_1', name: 'report.txt', kind: 'file', tool: 'file_write', action: 'created', runId: 7, taskId: 'job_1', sessionId: 'session_1', createdAt: 5, bytes: 10, preview: 'report' }],
      runEvents: [{ id: 4, runId: 7, sessionId: 'session_1', turnId: null, seq: 4, ts: 4, category: 'integration', kind: 'app.action', name: 'github.issue.create', toolCallId: 'tool_1', parentEventId: null, status: 'waiting', durationMs: null, summary: 'Create issue', payload: '{}', payloadTruncated: false, payloadBytes: null, payloadRef: null, visibility: 'system', source: 'app' }],
    }));
    expect(new Set(result?.surfaces.map((surface) => surface.kind))).toEqual(new Set(['terminal', 'workspace', 'changes', 'validation', 'artifact', 'app_action']));
    expect(result?.activeSurface?.kind).toBe('app_action');
  });

  it('T10 keeps Job truth independent when an observer surface disconnects', () => {
    const result = projectLiveExecution(source({
      codingSessions: [{
        codingSessionId: 'coding_1', childJobId: 'child_1', childAttemptId: 'child_attempt_1', generation: 1,
        assignmentId: 'assignment_1', workerRunId: 'worker_1', state: 'running', reconciliationState: 'not_required',
        provider: { id: 'provider', version: '1', protocolMode: 'jsonl', protocolVersion: '1', capabilityDigest: 'digest' },
        workspace: null, process: { state: 'unknown', exitCode: null, exitSignal: null, treeDeadVerified: false }, events: [],
        changedPaths: [], mutationState: null, reconciliation: null, promotion: null, validationRefs: [],
        createdAt: 1, startedAt: 1, lastActivityAt: 2, terminalAt: null,
      }],
    }));
    expect(result?.job.status).toBe('running');
    expect(result?.surfaces.find((surface) => surface.kind === 'terminal')?.status).toBe('disconnected');
  });
});

describe('terminal redaction', () => {
  it('SEC3 redacts bearer tokens, secret assignments, and credential URLs before projection', () => {
    const text = redactTerminalOutput('Authorization: Bearer abc123\nAPI_KEY=secret123\nhttps://u:p@example.com/?token=x');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('secret123');
    expect(text).not.toContain('u:p');
    expect(text).not.toContain('token=x');
    expect(text).toContain('[redacted]');
  });
});
