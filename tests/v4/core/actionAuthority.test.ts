/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import {
  createActionAuthority,
  normalizeExecutionPlan,
  type ActionAuthority,
  type PolicySnapshotInput,
} from '../../../core/v4/actionAuthority';

describe('final action and durable Approval authority', () => {
  let db: Database.Database;
  let jobs: JobEngine;
  let actions: ActionAuthority;
  let admission: AdmissionResult;
  let fenceToken: string;
  const policy: PolicySnapshotInput = {
    trustLevel: 'Assistant',
    autonomyPolicy: 'ask_for_mutations',
    approvalMode: 'smart',
    toolMetadataVersion: '1',
    sandboxPolicy: { roots: ['C:/workspace'], deny: ['C:/Windows'] },
    networkPolicy: { allow: ['example.test'] },
    pluginGrants: [],
    mcpGrants: [],
    workspaceOverrides: {},
    jobOverrides: {},
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('instance-1', 1, 'test', 1, 1, 'test')`,
    ).run();
    jobs = createJobEngine({ db });
    admission = jobs.submitJob({
      entryPoint: 'interactive',
      source: 'test',
      sessionId: 'session-1',
      instanceId: 'instance-1',
      idempotencyNamespace: 'test',
      idempotencyKey: 'job-approval',
      goal: 'approval test',
    });
    const lease = jobs.claimAttempt({ attemptId: admission.attemptId, ownerId: 'test', ttlMs: 60_000 });
    fenceToken = lease.fenceToken!;
    const attemptRunning = jobs.transitionAttempt({
      attemptId: admission.attemptId,
      expectedStateVersion: lease.stateVersion!,
      generation: 1,
      fenceToken,
      to: 'running',
      eventIdempotencyKey: 'approval-attempt-running',
      producer: 'test',
    });
    jobs.transitionJob({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      fenceToken,
      expectedStateVersion: 0,
      to: 'running',
      eventIdempotencyKey: 'approval-job-running',
      producer: 'test',
    });
    expect(attemptRunning.applied).toBe(true);
    actions = createActionAuthority({ db, jobEngine: jobs });
  });

  afterEach(() => db.close());

  it('normalizes transformed arguments before producing the action digest', () => {
    const first = normalizeExecutionPlan({
      toolName: 'shell_exec',
      args: { command: 'echo one', cwd: 'C:/workspace/.' },
      cwd: 'C:/workspace',
      mutates: true,
      riskTier: 'caution',
      policy,
    });
    const transformed = normalizeExecutionPlan({
      toolName: 'shell_exec',
      args: { command: 'echo two', cwd: 'C:/workspace/.' },
      cwd: 'C:/workspace',
      mutates: true,
      riskTier: 'caution',
      policy,
    });
    expect(first.plan.cwd).toMatch(/workspace$/i);
    expect(first.plan.executable).toBeTruthy();
    expect(first.actionDigest).not.toBe(transformed.actionDigest);
    expect(first.policySnapshot.digest).toBe(transformed.policySnapshot.digest);
  });

  it('binds affected paths to their canonical symlink or junction target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-action-'));
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const normalized = normalizeExecutionPlan({
        toolName: 'file_write',
        args: { path: path.join(link, 'result.txt') },
        cwd: root,
        mutates: true,
        riskTier: 'caution',
        policy,
      });
      expect(normalized.plan.affectedResources).toEqual([path.join(target, 'result.txt')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds approval to exact Job, Attempt, generation, ToolCall, plan, and policy', () => {
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write',
      args: { path: 'result.txt', content: 'ok' },
      cwd: 'C:/workspace',
      mutates: true,
      riskTier: 'caution',
      policy,
    });
    const approval = actions.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      toolCallId: 'tool-call-1',
      toolName: 'file_write',
      riskTier: 'caution',
      riskReasons: ['filesystem write'],
      normalized,
      expiresAt: Date.now() + 60_000,
    });
    expect(actions.listPending(admission.jobId)).toHaveLength(1);
    expect(actions.decide({
      approvalId: approval.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId,
      decision: 'approved',
      decidedBy: 'user',
      decisionChannel: 'tui',
    }).state).toBe('approved');
    expect(actions.authorizeExecution({
      approvalId: approval.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      fenceToken,
      toolCallId: 'tool-call-1',
      actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId,
    }).authorized).toBe(true);
    expect(actions.authorizeExecution({
      approvalId: approval.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      fenceToken,
      toolCallId: 'tool-call-1',
      actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId,
    })).toMatchObject({ authorized: false, duplicate: true });
  });

  it('replays approval lifecycle from reference-only Job events', () => {
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write',
      args: { path: 'event-result.txt', content: 'private approval content' },
      cwd: 'C:/workspace',
      mutates: true,
      riskTier: 'caution',
      policy,
    });
    const approval = actions.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      toolCallId: 'tool-call-events',
      toolName: 'file_write',
      riskTier: 'caution',
      riskReasons: ['filesystem write'],
      normalized,
    });
    actions.markDisplayed(approval.approvalId);
    actions.decide({
      approvalId: approval.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId,
      decision: 'approved',
      decidedBy: 'user',
      decisionChannel: 'tui',
    });
    actions.authorizeExecution({
      approvalId: approval.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      fenceToken,
      toolCallId: 'tool-call-events',
      actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId,
    });

    const events = jobs.listEvents(admission.jobId).filter((event) => event.type.startsWith('approval.'));
    expect(events.map((event) => event.type)).toEqual([
      'approval.created', 'approval.displayed', 'approval.approved', 'approval.executed',
    ]);
    expect(events.every((event) => event.payload?.approvalId === approval.approvalId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private approval content');
    expect(JSON.stringify(events)).not.toContain('normalized_execution_plan');
  });

  it.each([
    ['command', { command: 'echo changed' }],
    ['path', { path: 'other.txt' }],
    ['cwd', { cwd: 'C:/other' }],
    ['environment', { env: { MODE: 'changed' } }],
    ['network target', { url: 'https://other.test/' }],
  ])('rejects a changed %s after approval', (_label, changedArgs) => {
    const original = normalizeExecutionPlan({
      toolName: 'shell_exec',
      args: { command: 'echo one', path: 'result.txt', env: { MODE: 'safe' }, url: 'https://example.test/' },
      cwd: 'C:/workspace',
      mutates: true,
      riskTier: 'dangerous',
      policy,
    });
    const approval = actions.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      toolCallId: 'tool-call-change',
      toolName: 'shell_exec',
      riskTier: 'dangerous',
      riskReasons: [],
      normalized: original,
    });
    actions.decide({
      approvalId: approval.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      actionDigest: original.actionDigest,
      policySnapshotId: approval.policySnapshotId,
      decision: 'approved',
      decidedBy: 'user',
      decisionChannel: 'tui',
    });
    const changed = normalizeExecutionPlan({
      toolName: 'shell_exec',
      args: { command: 'echo one', path: 'result.txt', env: { MODE: 'safe' }, url: 'https://example.test/', ...changedArgs },
      cwd: typeof changedArgs.cwd === 'string' ? changedArgs.cwd : 'C:/workspace',
      mutates: true,
      riskTier: 'dangerous',
      policy,
    });
    expect(actions.authorizeExecution({
      approvalId: approval.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      fenceToken,
      toolCallId: 'tool-call-change',
      actionDigest: changed.actionDigest,
      policySnapshotId: changed.policySnapshot.policySnapshotId,
    })).toMatchObject({ authorized: false, reason: expect.stringMatching(/changed|mismatch|invalid/i) });
  });

  it('does not interpret normal text as an approval and rejects stale or terminal decisions', () => {
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write',
      args: { path: 'result.txt', content: 'ok' },
      cwd: 'C:/workspace',
      mutates: true,
      riskTier: 'caution',
      policy,
    });
    const approval = actions.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      toolCallId: 'tool-call-2',
      toolName: 'file_write',
      riskTier: 'caution',
      riskReasons: [],
      normalized,
    });
    expect(() => actions.decideFromInput({ approvalId: approval.approvalId, inputKind: 'message', content: 'yes' }))
      .toThrow(/explicit approval decision/i);
    expect(() => actions.decide({
      approvalId: approval.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 2,
      actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId,
      decision: 'approved',
      decidedBy: 'user',
      decisionChannel: 'tui',
    })).toThrow(/stale generation/i);
  });

  it('rejects an approved action when the execution fence is stale', () => {
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write', args: { path: 'stale.txt' }, cwd: 'C:/workspace',
      mutates: true, riskTier: 'caution', policy,
    });
    const approval = actions.request({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: 1,
      toolCallId: 'tool-call-stale-fence', toolName: 'file_write', riskTier: 'caution',
      riskReasons: [], normalized,
    });
    actions.decide({
      approvalId: approval.approvalId, jobId: admission.jobId,
      attemptId: admission.attemptId, generation: 1,
      actionDigest: normalized.actionDigest, policySnapshotId: approval.policySnapshotId,
      decision: 'approved', decidedBy: 'user', decisionChannel: 'tui',
    });

    expect(actions.authorizeExecution({
      approvalId: approval.approvalId, jobId: admission.jobId,
      attemptId: admission.attemptId, generation: 1, fenceToken: 'stale-fence',
      toolCallId: 'tool-call-stale-fence', actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId,
    })).toMatchObject({ authorized: false, reason: expect.stringMatching(/fence/i) });
    expect(actions.get(approval.approvalId)?.state).toBe('invalidated');
  });

  it('restores pending approvals by exact ID after authority restart', () => {
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write', args: { path: 'restart.txt', content: 'ok' }, cwd: 'C:/workspace',
      mutates: true, riskTier: 'caution', policy,
    });
    const created = actions.request({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: 1,
      toolCallId: 'tool-restart', toolName: 'file_write', riskTier: 'caution',
      riskReasons: ['filesystem write'], normalized, expiresAt: 10_000, now: 1_000,
    });
    actions.markDisplayed(created.approvalId, 2_000);

    const restarted = createActionAuthority({ db, jobEngine: jobs });
    expect(restarted.listPending(admission.jobId)).toEqual([
      expect.objectContaining({
        approvalId: created.approvalId,
        actionDigest: normalized.actionDigest,
        state: 'displayed',
        expiresAt: 10_000,
      }),
    ]);
  });

  it('makes duplicate decisions idempotent but rejects a conflicting decision', () => {
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write', args: { path: 'once.txt' }, cwd: 'C:/workspace',
      mutates: true, riskTier: 'caution', policy,
    });
    const approval = actions.request({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: 1,
      toolCallId: 'tool-decision', toolName: 'file_write', riskTier: 'caution',
      riskReasons: [], normalized,
    });
    const decision = {
      approvalId: approval.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId,
      decision: 'approved' as const,
      decidedBy: 'user',
      decisionChannel: 'tui',
    };
    expect(actions.decide(decision).state).toBe('approved');
    expect(actions.decide(decision).state).toBe('approved');
    expect(() => actions.decide({ ...decision, decision: 'denied' })).toThrow(/conflicting decision/i);
  });

  it('expires approvals and rejects decisions after the Job becomes terminal', () => {
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write', args: { path: 'late.txt' }, cwd: 'C:/workspace',
      mutates: true, riskTier: 'caution', policy,
    });
    const expired = actions.request({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: 1,
      toolCallId: 'tool-expired', toolName: 'file_write', riskTier: 'caution',
      riskReasons: [], normalized, expiresAt: 2, now: 1,
    });
    expect(() => actions.decide({
      approvalId: expired.approvalId, jobId: admission.jobId,
      attemptId: admission.attemptId, generation: 1,
      actionDigest: normalized.actionDigest, policySnapshotId: expired.policySnapshotId,
      decision: 'approved', decidedBy: 'user', decisionChannel: 'tui', now: 3,
    })).toThrow(/expired/i);
    expect(actions.get(expired.approvalId)?.state).toBe('expired');

    const pending = actions.request({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: 1,
      toolCallId: 'tool-terminal', toolName: 'file_write', riskTier: 'caution',
      riskReasons: [], normalized,
    });
    jobs.cancelJob({ jobId: admission.jobId, producer: 'test', reason: 'stop', eventIdempotencyKey: 'stop' });
    expect(() => actions.decide({
      approvalId: pending.approvalId, jobId: admission.jobId,
      attemptId: admission.attemptId, generation: 1,
      actionDigest: normalized.actionDigest, policySnapshotId: pending.policySnapshotId,
      decision: 'approved', decidedBy: 'user', decisionChannel: 'tui',
    })).toThrow(/terminal Job/i);
  });

  it('keeps multiple approvals independent and never persists raw secret values', () => {
    const make = (toolCallId: string, filePath: string) => actions.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: 1,
      toolCallId,
      toolName: 'file_write',
      riskTier: 'caution',
      riskReasons: [],
      normalized: normalizeExecutionPlan({
        toolName: 'file_write',
        args: { path: filePath, apiKey: 'private-fixture-value' },
        cwd: 'C:/workspace',
        mutates: true,
        riskTier: 'caution',
        policy: { ...policy, jobOverrides: { accessToken: 'private-fixture-value' } },
      }),
    });
    const first = make('tool-one', 'one.txt');
    const second = make('tool-two', 'two.txt');
    expect(actions.listPending(admission.jobId).map((entry) => entry.approvalId)).toEqual([
      first.approvalId,
      second.approvalId,
    ]);
    const persisted = db.prepare(
      'SELECT normalized_execution_plan AS plan FROM approvals ORDER BY request_sequence',
    ).all() as Array<{ plan: string }>;
    const policies = db.prepare('SELECT job_overrides_json AS value FROM policy_snapshots').all() as Array<{ value: string }>;
    expect(JSON.stringify({ persisted, policies })).not.toContain('private-fixture-value');
  });
});
