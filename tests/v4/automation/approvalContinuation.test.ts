import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createActionAuthority, normalizeExecutionPlan } from '../../../core/v4/actionAuthority';
import {
  createAutomationApprovalContinuationAuthority,
  createAutomationApprovalContinuationRuntime,
} from '../../../core/v4/automation/approvalContinuation';
import { createAutomationAuthority } from '../../../core/v4/automation/automationAuthority';
import { createOccurrenceAuthority } from '../../../core/v4/automation/occurrenceAuthority';
import type { ScriptSpec } from '../../../core/v4/automation/types';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { normalizedArgsDigest, runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { buildWorkbenchApprovalCallbacks } from '../../../core/v4/workbench/approvalBridge';

const script: ScriptSpec = {
  version: 1,
  maxRuntimeMs: 60_000,
  steps: [{ kind: 'write_file', path: 'automation-approval-restart.txt', content: 'AUTOMATION_APPROVAL_RESTART_OK\n' }],
};

const approvalPolicy = {
  trustLevel: 'Assistant',
  autonomyPolicy: 'ask_for_mutations',
  approvalMode: 'manual',
  toolMetadataVersion: '4.20.0',
  sandboxPolicy: { roots: [] as string[], deny: [] as string[] },
  networkPolicy: {},
  pluginGrants: [] as string[],
  mcpGrants: [] as string[],
  workspaceOverrides: {},
  jobOverrides: {},
};

describe('durable Automation approval continuation', () => {
  const roots: string[] = [];
  let suiteRoot = '';
  let templateDbPath = '';

  beforeAll(() => {
    suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-automation-approval-suite-'));
    templateDbPath = path.join(suiteRoot, 'template.db');
    const templateDb = new Database(templateDbPath);
    try {
      runMigrations(templateDb);
    } finally {
      templateDb.close();
    }
  });

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  afterAll(() => {
    if (suiteRoot) fs.rmSync(suiteRoot, { recursive: true, force: true });
  });

  function openFixture() {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'case-'));
    roots.push(root);
    const dbPath = path.join(root, 'automation.db');
    fs.copyFileSync(templateDbPath, dbPath);
    const db = new Database(dbPath);
    const now = Date.now();
    db.prepare(`INSERT INTO daemon_instances
      (instance_id,pid,hostname,started_at,last_heartbeat,version)
      VALUES ('host_one',1,'localhost',?,?,'4.20.0'),('host_two',2,'localhost',?,?,'4.20.0')`)
      .run(now, now, now, now);
    const jobs = createJobEngine({ db });
    const created = createAutomationAuthority({ db }).create({
      name: 'Approval restart',
      action: { kind: 'script', script },
      trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap: 'queue', retry: { maxAttempts: 2 } },
      capabilities: ['repository.write'],
      credentialRefs: [],
      approval: { mode: 'always' },
      workspace: { rootPath: root },
      createdBy: 'test',
    });
    const bus = createTriggerBus({ db });
    bus.insert({
      source: 'manual', sourceKey: created.definition.id, idempotencyKey: 'approval-restart', payload: {},
    });
    const claim = bus.claim({ source: 'manual', ownerId: 'host_one', leaseMs: 60_000 })!;
    const admission = createOccurrenceAuthority({ db, jobEngine: jobs }).admitClaimed({
      triggerEventId: claim.id,
      claimToken: claim.claimToken,
      automationId: created.definition.id,
      revisionId: created.revision.id,
      triggerKind: 'manual',
      sourceIdentity: 'approval-restart',
      instanceId: 'host_one',
    });
    if (admission.disposition !== 'admitted') throw new Error('fixture admission failed');
    const lease = jobs.claimAttempt({ attemptId: admission.attemptId, ownerId: 'host_one', ttlMs: 60_000 });
    const attempt = jobs.transitionAttempt({
      attemptId: admission.attemptId,
      expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'running',
      eventIdempotencyKey: 'fixture-attempt-running',
      producer: 'test',
    });
    jobs.transitionJob({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      expectedStateVersion: jobs.getJob(admission.jobId)!.stateVersion,
      to: 'running',
      eventIdempotencyKey: 'fixture-job-running',
      producer: 'test',
    });
    const handle = {
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
    };
    const modelCallId = `automation-script:${admission.attemptId}:${lease.generation}:step:1`;
    const toolCallId = `tool-call:sha256:${createHash('sha256')
      .update(`${admission.attemptId}\0${lease.generation}\0${modelCallId}`)
      .digest('hex')}`;
    const toolArgs = {
      path: 'automation-approval-restart.txt',
      content: 'AUTOMATION_APPROVAL_RESTART_OK\n',
    };
    const prepared = jobs.prepareToolCall({
      toolCallId,
      ...handle,
      toolName: 'file_write',
      normalizedArgsDigest: normalizedArgsDigest(toolArgs),
      riskTier: 'caution',
      mutates: true,
      producer: 'test',
      effect: {
        classification: 'reconcilable_mutation', kind: 'filesystem.write',
        target: path.join(root, 'automation-approval-restart.txt'),
        retrySafety: 'reconcile_before_retry', idempotencySupported: false, idempotencyKey: null,
        reconciliationSupported: true, verificationSupported: true,
        approvalRequirement: 'always', approvalState: 'pending', sensitiveFields: ['content'],
        redactionRules: ['digest_arguments'], trusted: true,
      },
    });
    expect(attempt.applied).toBe(true);
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write',
      args: { path: 'automation-approval-restart.txt', content: 'AUTOMATION_APPROVAL_RESTART_OK\n' },
      cwd: root,
      mutates: true,
      riskTier: 'caution',
      policy: { ...approvalPolicy, sandboxPolicy: { roots: [root], deny: [] } },
    });
    return { root, dbPath, db, jobs, admission, handle, modelCallId, toolCallId, toolArgs, prepared, normalized };
  }

  function buildFileExecutor(input: {
    root: string;
    jobs: ReturnType<typeof createJobEngine>;
    actions: ReturnType<typeof createActionAuthority>;
    continuation: ReturnType<typeof createAutomationApprovalContinuationRuntime>;
    handle: { jobId: string; attemptId: string; generation: number; fenceToken: string };
    execute: () => Promise<unknown>;
  }) {
    const registry = new ToolRegistry();
    registry.register({
      schema: {
        name: 'file_write', description: 'Write exact content.',
        inputSchema: {
          type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
      category: 'write', riskTier: 'caution', mutates: true,
      effectContract: {
        classification: 'reconcilable_mutation', kind: 'filesystem.write',
        retrySafety: 'reconcile_before_retry', idempotencySupported: false,
        reconciliationSupported: true, verificationSupported: true,
        approvalRequirement: 'always', sensitiveFields: ['content'],
        redactionRules: ['digest_arguments'], target: (args) => String(args.path),
      },
      execute: input.execute,
    });
    return registry.buildExecutor({
      cwd: input.root,
      paths: resolveAidenPaths({ rootOverride: path.join(input.root, '.aiden') }),
      actionAuthority: input.actions,
      policySnapshot: { ...approvalPolicy, sandboxPolicy: { roots: [input.root], deny: [] } },
      approvalEngine: new ApprovalEngine('manual', buildWorkbenchApprovalCallbacks({
        authority: input.actions,
        jobId: input.handle.jobId,
        attemptId: input.handle.attemptId,
        generation: input.handle.generation,
        pollIntervalMs: 1,
      })),
      automationApprovalContinuation: input.continuation,
    });
  }

  function createPending(value: ReturnType<typeof openFixture>) {
    const continuations = createAutomationApprovalContinuationAuthority({ db: value.db, jobEngine: value.jobs });
    const continuation = continuations.prepare({
      handle: value.handle,
      ownerId: 'host_one',
      scriptSpec: script,
      stepIndex: 0,
      toolCallId: value.toolCallId,
      effectId: value.prepared.effectId!,
      normalized: value.normalized,
    });
    const actions = createActionAuthority({ db: value.db, jobEngine: value.jobs });
    const approval = actions.request({
      ...value.handle,
      toolCallId: value.toolCallId,
      effectId: value.prepared.effectId,
      toolName: 'file_write',
      riskTier: 'caution',
      riskReasons: ['filesystem write'],
      normalized: value.normalized,
    });
    continuations.bindApproval({
      continuationId: continuation.continuationId,
      claimToken: continuation.claimToken!,
      ownerId: 'host_one',
      approval,
    });
    actions.markDisplayed(approval.approvalId);
    return { continuations, actions, continuation, approval };
  }

  it('reopens one pending approval under the same Job, Attempt, generation, fence, and approval identity', () => {
    const fixture = openFixture();
    const pending = createPending(fixture);
    pending.continuations.releaseForHost(
      fixture.handle.jobId, fixture.handle.attemptId, fixture.handle.generation, 'host_one',
    );
    expect(fixture.jobs.detachAttemptForHost({
      ...fixture.handle,
      ownerId: 'host_one', reason: 'Workbench host shutdown', producer: 'workbench',
      eventIdempotencyKey: 'host-detach',
    }).applied).toBe(true);
    fixture.db.close();

    const reopenedDb = new Database(fixture.dbPath);
    runMigrations(reopenedDb);
    const reopenedJobs = createJobEngine({ db: reopenedDb });
    const reopened = createAutomationApprovalContinuationAuthority({ db: reopenedDb, jobEngine: reopenedJobs });
    const resume = reopened.findResume(
      fixture.handle.jobId, fixture.handle.attemptId, fixture.handle.generation,
    )!;
    expect(resume).toMatchObject({
      continuationId: pending.continuation.continuationId,
      approvalId: pending.approval.approvalId,
      stepIndex: 0,
      state: 'waiting_approval',
    });
    const lease = reopenedJobs.reattachAttempt({
      ...fixture.handle,
      ownerId: 'host_two',
      ttlMs: 60_000,
    });
    expect(lease).toMatchObject({
      acquired: true,
      generation: fixture.handle.generation,
      fenceToken: fixture.handle.fenceToken,
    });
    expect(reopenedJobs.listAttempts(fixture.handle.jobId)).toHaveLength(1);
    const reclaimed = reopened.prepare({
      handle: fixture.handle,
      ownerId: 'host_two',
      scriptSpec: script,
      stepIndex: 0,
      toolCallId: fixture.toolCallId,
      effectId: fixture.prepared.effectId!,
      normalized: fixture.normalized,
    });
    const restartedActions = createActionAuthority({ db: reopenedDb, jobEngine: reopenedJobs });
    const sameApproval = restartedActions.request({
      ...fixture.handle,
      toolCallId: fixture.toolCallId,
      effectId: fixture.prepared.effectId,
      toolName: 'file_write',
      riskTier: 'caution',
      riskReasons: ['filesystem write'],
      normalized: fixture.normalized,
    });
    expect(reclaimed.continuationId).toBe(pending.continuation.continuationId);
    expect(sameApproval).toMatchObject({
      approvalId: pending.approval.approvalId,
      state: 'displayed',
    });
    expect(reopenedDb.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toEqual({ count: 1 });
    reopenedDb.close();
  });

  it.each([
    ['approved', 'approved'],
    ['denied', 'denied'],
  ] as const)('preserves a %s decision made before recovery', (decision, expected) => {
    const fixture = openFixture();
    const pending = createPending(fixture);
    pending.continuations.releaseForHost(
      fixture.handle.jobId, fixture.handle.attemptId, fixture.handle.generation, 'host_one',
    );
    fixture.jobs.detachAttemptForHost({
      ...fixture.handle,
      ownerId: 'host_one', reason: 'Workbench host shutdown', producer: 'workbench',
      eventIdempotencyKey: `host-detach-${decision}`,
    });
    pending.actions.decide({
      approvalId: pending.approval.approvalId,
      jobId: fixture.handle.jobId,
      attemptId: fixture.handle.attemptId,
      generation: fixture.handle.generation,
      actionDigest: fixture.normalized.actionDigest,
      policySnapshotId: fixture.normalized.policySnapshot.policySnapshotId,
      decision,
      decidedBy: 'user',
      decisionChannel: 'workbench',
    });
    expect(pending.actions.get(pending.approval.approvalId)?.state).toBe(expected);
    expect(pending.continuations.findResume(
      fixture.handle.jobId, fixture.handle.attemptId, fixture.handle.generation,
    )?.approvalId).toBe(pending.approval.approvalId);
    fixture.db.close();
  });

  it('explicit cancellation cancels the approval and continuation instead of detaching them', () => {
    const fixture = openFixture();
    const pending = createPending(fixture);
    expect(pending.actions.cancelPendingForJob(fixture.handle.jobId, 'user cancelled').changed).toBe(1);
    expect(pending.actions.get(pending.approval.approvalId)?.state).toBe('cancelled');
    expect(pending.continuations.get(pending.continuation.continuationId)?.state).toBe('cancelled');
    expect(fixture.jobs.cancelJob({
      jobId: fixture.handle.jobId,
      reason: 'user cancelled',
      producer: 'workbench',
      eventIdempotencyKey: 'user-cancelled',
    }).applied).toBe(true);
    expect(fixture.jobs.getJob(fixture.handle.jobId)?.status).toBe('cancelled');
    fixture.db.close();
  });

  it('approves after restart and executes the exact original Effect once', async () => {
    const fixture = openFixture();
    const pending = createPending(fixture);
    pending.continuations.releaseForHost(
      fixture.handle.jobId, fixture.handle.attemptId, fixture.handle.generation, 'host_one',
    );
    fixture.jobs.detachAttemptForHost({
      ...fixture.handle, ownerId: 'host_one', reason: 'Workbench host shutdown', producer: 'workbench',
      eventIdempotencyKey: 'host-detach-approve-runtime',
    });
    fixture.db.close();

    const db = new Database(fixture.dbPath);
    runMigrations(db);
    const jobs = createJobEngine({ db });
    jobs.reattachAttempt({ ...fixture.handle, ownerId: 'host_two', ttlMs: 60_000 });
    const continuations = createAutomationApprovalContinuationAuthority({ db, jobEngine: jobs });
    const actions = createActionAuthority({ db, jobEngine: jobs });
    actions.decide({
      approvalId: pending.approval.approvalId,
      jobId: fixture.handle.jobId,
      attemptId: fixture.handle.attemptId,
      generation: fixture.handle.generation,
      actionDigest: fixture.normalized.actionDigest,
      policySnapshotId: fixture.normalized.policySnapshot.policySnapshotId,
      decision: 'approved', decidedBy: 'user', decisionChannel: 'workbench',
    });
    let executions = 0;
    const runtime = createAutomationApprovalContinuationRuntime({
      authority: continuations, handle: fixture.handle, ownerId: 'host_two', scriptSpec: script, stepIndex: 0,
    });
    const execute = buildFileExecutor({
      root: fixture.root, jobs, actions, continuation: runtime,
      handle: fixture.handle,
      execute: async () => {
        executions += 1;
        fs.writeFileSync(path.join(fixture.root, fixture.toolArgs.path), fixture.toolArgs.content);
        return { success: true };
      },
    });
    const result = await runWithJobExecutionContext({
      engine: jobs, ...fixture.handle, producer: 'automation-recovery',
    }, () => execute({ id: fixture.modelCallId, name: 'file_write', arguments: fixture.toolArgs }));
    runtime.settle(result);

    expect(result.error).toBeUndefined();
    expect(executions).toBe(1);
    expect(fs.readFileSync(path.join(fixture.root, fixture.toolArgs.path), 'utf8'))
      .toBe('AUTOMATION_APPROVAL_RESTART_OK\n');
    expect(actions.get(pending.approval.approvalId)?.state).toBe('executed');
    expect(continuations.get(pending.continuation.continuationId)?.state).toBe('consumed');
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM side_effect_ledger').get()).toEqual({ count: 1 });
    db.close();
  });

  it('denies after restart without executing or resurrecting the Effect', async () => {
    const fixture = openFixture();
    const pending = createPending(fixture);
    pending.continuations.releaseForHost(
      fixture.handle.jobId, fixture.handle.attemptId, fixture.handle.generation, 'host_one',
    );
    fixture.jobs.detachAttemptForHost({
      ...fixture.handle, ownerId: 'host_one', reason: 'Workbench host shutdown', producer: 'workbench',
      eventIdempotencyKey: 'host-detach-deny-runtime',
    });
    fixture.jobs.reattachAttempt({ ...fixture.handle, ownerId: 'host_two', ttlMs: 60_000 });
    pending.actions.decide({
      approvalId: pending.approval.approvalId,
      jobId: fixture.handle.jobId,
      attemptId: fixture.handle.attemptId,
      generation: fixture.handle.generation,
      actionDigest: fixture.normalized.actionDigest,
      policySnapshotId: fixture.normalized.policySnapshot.policySnapshotId,
      decision: 'denied', decidedBy: 'user', decisionChannel: 'workbench',
    });
    const runtime = createAutomationApprovalContinuationRuntime({
      authority: pending.continuations, handle: fixture.handle, ownerId: 'host_two', scriptSpec: script, stepIndex: 0,
    });
    let executions = 0;
    const execute = buildFileExecutor({
      root: fixture.root, jobs: fixture.jobs, actions: pending.actions, continuation: runtime,
      handle: fixture.handle,
      execute: async () => { executions += 1; return { success: true }; },
    });
    const result = await runWithJobExecutionContext({
      engine: fixture.jobs, ...fixture.handle, producer: 'automation-recovery',
    }, () => execute({ id: fixture.modelCallId, name: 'file_write', arguments: fixture.toolArgs }));
    runtime.settle(result);

    expect(result.error).toMatch(/denied/i);
    expect(executions).toBe(0);
    expect(fs.existsSync(path.join(fixture.root, fixture.toolArgs.path))).toBe(false);
    expect(pending.actions.get(pending.approval.approvalId)?.state).toBe('denied');
    expect(pending.continuations.get(pending.continuation.continuationId)?.state).toBe('denied');
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toEqual({ count: 1 });
    fixture.db.close();
  });

  it('invalidates an expired restored approval and executes no Effect', async () => {
    const fixture = openFixture();
    const pending = createPending(fixture);
    fixture.db.prepare('UPDATE approvals SET expires_at = ? WHERE approval_id = ?')
      .run(Date.now() - 1, pending.approval.approvalId);
    pending.continuations.releaseForHost(
      fixture.handle.jobId, fixture.handle.attemptId, fixture.handle.generation, 'host_one',
    );
    fixture.jobs.detachAttemptForHost({
      ...fixture.handle, ownerId: 'host_one', reason: 'Workbench host shutdown', producer: 'workbench',
      eventIdempotencyKey: 'host-detach-expired-runtime',
    });
    fixture.jobs.reattachAttempt({ ...fixture.handle, ownerId: 'host_two', ttlMs: 60_000 });
    const runtime = createAutomationApprovalContinuationRuntime({
      authority: pending.continuations, handle: fixture.handle, ownerId: 'host_two', scriptSpec: script, stepIndex: 0,
    });
    let executions = 0;
    const execute = buildFileExecutor({
      root: fixture.root, jobs: fixture.jobs, actions: pending.actions, continuation: runtime,
      handle: fixture.handle,
      execute: async () => { executions += 1; return { success: true }; },
    });
    const result = await runWithJobExecutionContext({
      engine: fixture.jobs, ...fixture.handle, producer: 'automation-recovery',
    }, () => execute({ id: fixture.modelCallId, name: 'file_write', arguments: fixture.toolArgs }));
    runtime.settle(result);

    expect(result.error).toMatch(/interrupted|approval/i);
    expect(executions).toBe(0);
    expect(pending.actions.get(pending.approval.approvalId)?.state).toBe('invalidated');
    expect(pending.continuations.get(pending.continuation.continuationId)?.state).toBe('cancelled');
    fixture.db.close();
  });

  it('adopts a committed Effect after restart without executing it again', async () => {
    const fixture = openFixture();
    const pending = createPending(fixture);
    pending.actions.decide({
      approvalId: pending.approval.approvalId,
      jobId: fixture.handle.jobId,
      attemptId: fixture.handle.attemptId,
      generation: fixture.handle.generation,
      actionDigest: fixture.normalized.actionDigest,
      policySnapshotId: fixture.normalized.policySnapshot.policySnapshotId,
      decision: 'approved', decidedBy: 'user', decisionChannel: 'workbench',
    });
    fixture.jobs.resolveToolCallApproval({
      toolCallId: fixture.toolCallId, attemptId: fixture.handle.attemptId,
      generation: fixture.handle.generation, fenceToken: fixture.handle.fenceToken,
      state: 'approved', approvalId: pending.approval.approvalId,
      actionDigest: fixture.normalized.actionDigest, producer: 'test',
    });
    pending.actions.authorizeExecution({
      approvalId: pending.approval.approvalId, ...fixture.handle,
      toolCallId: fixture.toolCallId, effectId: fixture.prepared.effectId,
      actionDigest: fixture.normalized.actionDigest,
      policySnapshotId: fixture.normalized.policySnapshot.policySnapshotId,
    });
    fixture.jobs.startToolCall({
      toolCallId: fixture.toolCallId, attemptId: fixture.handle.attemptId,
      generation: fixture.handle.generation, fenceToken: fixture.handle.fenceToken, producer: 'test',
    });
    fixture.jobs.completeToolCall({
      toolCallId: fixture.toolCallId, attemptId: fixture.handle.attemptId,
      generation: fixture.handle.generation, fenceToken: fixture.handle.fenceToken,
      state: 'completed', sideEffectState: 'committed', resultRef: 'result:committed', producer: 'test',
    });
    pending.continuations.releaseForHost(
      fixture.handle.jobId, fixture.handle.attemptId, fixture.handle.generation, 'host_one',
    );
    fixture.jobs.detachAttemptForHost({
      ...fixture.handle, ownerId: 'host_one', reason: 'Workbench host shutdown', producer: 'workbench',
      eventIdempotencyKey: 'host-detach-after-effect',
    });
    const lease = fixture.jobs.reattachAttempt({ ...fixture.handle, ownerId: 'host_two', ttlMs: 60_000 });
    expect(lease.acquired).toBe(true);
    const runtime = createAutomationApprovalContinuationRuntime({
      authority: pending.continuations, handle: fixture.handle, ownerId: 'host_two', scriptSpec: script, stepIndex: 0,
    });
    let executions = 0;
    const execute = buildFileExecutor({
      root: fixture.root, jobs: fixture.jobs, actions: pending.actions, continuation: runtime,
      handle: fixture.handle,
      execute: async () => { executions += 1; return { success: true }; },
    });
    const result = await runWithJobExecutionContext({
      engine: fixture.jobs, ...fixture.handle, producer: 'automation-recovery',
    }, () => execute({ id: fixture.modelCallId, name: 'file_write', arguments: fixture.toolArgs }));
    runtime.settle(result);

    expect(result).toMatchObject({ result: { recovered: true, status: 'already_completed' } });
    expect(executions).toBe(0);
    expect(pending.continuations.get(pending.continuation.continuationId)?.state).toBe('consumed');
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM side_effect_ledger').get()).toEqual({ count: 1 });
    fixture.db.close();
  });

  it('permits only one concurrent recovery claim', () => {
    const fixture = openFixture();
    const pending = createPending(fixture);
    pending.continuations.releaseForHost(
      fixture.handle.jobId, fixture.handle.attemptId, fixture.handle.generation, 'host_one',
    );
    fixture.jobs.detachAttemptForHost({
      ...fixture.handle, ownerId: 'host_one', reason: 'Workbench host shutdown', producer: 'workbench',
      eventIdempotencyKey: 'host-detach-concurrent-claim',
    });
    fixture.jobs.reattachAttempt({ ...fixture.handle, ownerId: 'host_two', ttlMs: 60_000 });
    const first = pending.continuations.prepare({
      handle: fixture.handle, ownerId: 'host_two', scriptSpec: script, stepIndex: 0,
      toolCallId: fixture.toolCallId, effectId: fixture.prepared.effectId!, normalized: fixture.normalized,
    });
    expect(first.claimOwner).toBe('host_two');
    const duplicateScan = pending.continuations.prepare({
      handle: fixture.handle, ownerId: 'host_two', scriptSpec: script, stepIndex: 0,
      toolCallId: fixture.toolCallId, effectId: fixture.prepared.effectId!, normalized: fixture.normalized,
    });
    expect(duplicateScan.claimToken).toBe(first.claimToken);
    expect(() => pending.continuations.prepare({
      handle: fixture.handle, ownerId: 'host_three', scriptSpec: script, stepIndex: 0,
      toolCallId: fixture.toolCallId, effectId: fixture.prepared.effectId!, normalized: fixture.normalized,
    })).toThrow(/stale Job, Attempt, generation, fence, or lease authority/);
    fixture.db.close();
  });
});
