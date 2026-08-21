/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeExecutionPlan,
  type ActionAuthority,
  type ApprovalRecord,
  type PolicySnapshotInput,
} from '../actionAuthority';
import type { FileChangePlan } from '../codebase/safeChangeAuthority';
import type { RepositorySnapshotRecord } from '../codebase/repositorySnapshotAuthority';
import type { Db } from '../daemon/db/connection';
import type { JobEngine } from '../daemon/jobEngine';
import { normalizedArgsDigest } from '../daemon/jobExecutionContext';
import {
  executeDurableJob,
  type DurableJobExecutionResult,
  type DurableJobHandle,
} from '../daemon/jobLifecycle';
import { externalCodingIdentity } from './identities';

const PRODUCER = 'external-coding-promotion';

export type ExternalCodingPromotionState =
  | 'prepared'
  | 'approval_required'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'blocked_drift'
  | 'rejected'
  | 'unknown';

export interface ExternalCodingPromotionPlanRecord {
  readonly promotionId: string;
  readonly codingSessionId: string;
  readonly workspaceLeaseId: string;
  readonly parentJobId: string;
  readonly parentAttemptId: string;
  readonly parentGeneration: number;
  readonly promotionJobId: string | null;
  readonly promotionAttemptId: string | null;
  readonly promotionGeneration: number | null;
  readonly mutationReceiptId: string;
  readonly targetSnapshotId: string;
  readonly candidateSnapshotId: string;
  readonly targetHead: string;
  readonly candidateHead: string;
  readonly targetStateDigest: string;
  readonly planDigest: string;
  readonly changedPaths: readonly string[];
  readonly changeRecordIds: readonly string[];
  readonly validationRefs: readonly string[];
  readonly approvalId: string | null;
  readonly state: ExternalCodingPromotionState;
  readonly blockedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly appliedAt: number | null;
}

interface ChildAuthority {
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  childFenceToken: string;
}

export interface ExternalCodingPromotionDecisionRequest {
  readonly promotion: ExternalCodingPromotionPlanRecord;
  readonly approval: ApprovalRecord;
  readonly files: readonly string[];
}

export interface ExternalCodingPromotionResult {
  readonly promotion: ExternalCodingPromotionPlanRecord;
  readonly changeRecordIds: readonly string[];
  readonly disposition: 'applied' | 'rejected' | 'blocked_drift' | 'unknown';
}

export interface ExternalCodingPromotionAuthority {
  prepareCandidate(input: ChildAuthority & {
    codingSessionId: string;
    producer?: string;
    now?: number;
  }): Promise<ExternalCodingPromotionPlanRecord>;
  get(promotionId: string): ExternalCodingPromotionPlanRecord | null;
  getForSession(codingSessionId: string): ExternalCodingPromotionPlanRecord | null;
  listForParent(parentJobId: string): ExternalCodingPromotionPlanRecord[];
  apply(input: {
    promotionId: string;
    ownerId: string;
    instanceId: string;
    actions: ActionAuthority;
    requestApproval(request: ExternalCodingPromotionDecisionRequest): Promise<{
      decision: 'approved' | 'denied' | 'cancelled';
      decidedBy: string;
      decisionChannel: string;
    }>;
  }): Promise<DurableJobExecutionResult<ExternalCodingPromotionResult>>;
  discard(input: {
    promotionId: string;
    ownerId: string;
    instanceId: string;
    decidedBy: string;
    decisionChannel: string;
  }): Promise<DurableJobExecutionResult<ExternalCodingPromotionResult>>;
}

interface PromotionRow {
  promotion_id: string;
  coding_session_id: string;
  workspace_lease_id: string;
  parent_job_id: string;
  parent_attempt_id: string;
  parent_generation: number;
  promotion_job_id: string | null;
  promotion_attempt_id: string | null;
  promotion_generation: number | null;
  mutation_receipt_id: string;
  target_snapshot_id: string;
  candidate_snapshot_id: string;
  target_head: string;
  candidate_head: string;
  target_state_digest: string;
  plan_digest: string;
  changed_paths_json: string;
  change_record_ids_json: string;
  validation_refs_json: string;
  approval_id: string | null;
  state: ExternalCodingPromotionState;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
}

export class ExternalCodingPromotionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalCodingPromotionError';
  }
}

function parseList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function mapPlan(row: PromotionRow): ExternalCodingPromotionPlanRecord {
  return {
    promotionId: row.promotion_id,
    codingSessionId: row.coding_session_id,
    workspaceLeaseId: row.workspace_lease_id,
    parentJobId: row.parent_job_id,
    parentAttemptId: row.parent_attempt_id,
    parentGeneration: row.parent_generation,
    promotionJobId: row.promotion_job_id,
    promotionAttemptId: row.promotion_attempt_id,
    promotionGeneration: row.promotion_generation,
    mutationReceiptId: row.mutation_receipt_id,
    targetSnapshotId: row.target_snapshot_id,
    candidateSnapshotId: row.candidate_snapshot_id,
    targetHead: row.target_head,
    candidateHead: row.candidate_head,
    targetStateDigest: row.target_state_digest,
    planDigest: row.plan_digest,
    changedPaths: parseList(row.changed_paths_json),
    changeRecordIds: parseList(row.change_record_ids_json),
    validationRefs: parseList(row.validation_refs_json),
    approvalId: row.approval_id,
    state: row.state,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/');
}

function pathMatches(value: string, pattern: string): boolean {
  const candidate = normalizePath(value);
  const policy = normalizePath(pattern);
  if (!policy.includes('*')) return candidate === policy || candidate.startsWith(`${policy}/`);
  const expression = policy.split(/(\*\*)|(\*)/gu).filter((item) => item)
    .map((item) => item === '**' ? '.*' : item === '*' ? '[^/]*' : item.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('');
  return new RegExp(`^${expression}$`, 'u').test(candidate);
}

function requireActiveChild(engine: JobEngine, input: ChildAuthority): void {
  const job = engine.getJob(input.childJobId);
  const attempt = engine.getAttempt(input.childAttemptId);
  if (!job || !attempt || job.activeAttemptId !== input.childAttemptId
    || attempt.jobId !== input.childJobId || attempt.generation !== input.childGeneration
    || attempt.fenceToken !== input.childFenceToken || attempt.leaseExpiresAt === null
    || attempt.leaseExpiresAt <= Date.now()
    || /^(completed|failed|cancelled|dead_letter|completed_unverified|verification_failed|abandoned)$/u.test(job.status)) {
    throw new ExternalCodingPromotionError('STALE_CANDIDATE_AUTHORITY', 'Coding candidate authority is stale');
  }
}

function targetDrift(snapshot: RepositorySnapshotRecord, baseHead: string, protectedPaths: readonly string[]): string | null {
  if (snapshot.incomplete) return 'target_snapshot_incomplete';
  if (snapshot.headCommit !== baseHead) return 'target_head_changed';
  const changed = [...snapshot.stagedPaths, ...snapshot.dirtyPaths, ...snapshot.untrackedPaths]
    .map(normalizePath)
    .filter((item) => !protectedPaths.some((policy) => pathMatches(item, policy)));
  return changed.length > 0 ? `target_workspace_changed:${changed.join(',')}` : null;
}

function policy(root: string): PolicySnapshotInput {
  return {
    trustLevel: 'Assistant',
    autonomyPolicy: 'ask_for_mutations',
    approvalMode: 'always',
    toolMetadataVersion: 'external-coding-promotion-v1',
    sandboxPolicy: { roots: [root], deny: ['outside_workspace'] },
    networkPolicy: { mode: 'disabled' },
    pluginGrants: [],
    mcpGrants: [],
    workspaceOverrides: {},
    jobOverrides: { promotion: 'human_approval_required' },
  };
}

function toolFor(plan: FileChangePlan): string {
  return plan.operation === 'delete' ? 'file_delete' : 'file_write';
}

function argsFor(plan: FileChangePlan): Record<string, unknown> {
  return plan.operation === 'delete'
    ? { path: plan.path }
    : { path: plan.path, content: plan.content };
}

function authority(handle: DurableJobHandle) {
  return {
    jobId: handle.jobId,
    attemptId: handle.attemptId,
    generation: handle.generation,
    fenceToken: handle.fenceToken,
  };
}

export function createExternalCodingPromotionAuthority(deps: {
  db: Db;
  engine: JobEngine;
}): ExternalCodingPromotionAuthority {
  const get = (promotionId: string): ExternalCodingPromotionPlanRecord | null => {
    const row = deps.db.prepare('SELECT * FROM external_coding_promotion_plans WHERE promotion_id=?')
      .get(promotionId) as PromotionRow | undefined;
    return row ? mapPlan(row) : null;
  };
  const forSession = (codingSessionId: string): ExternalCodingPromotionPlanRecord | null => {
    const row = deps.db.prepare('SELECT * FROM external_coding_promotion_plans WHERE coding_session_id=?')
      .get(codingSessionId) as PromotionRow | undefined;
    return row ? mapPlan(row) : null;
  };
  const updateState = (
    promotionId: string,
    state: ExternalCodingPromotionState,
    extras: { blockedReason?: string | null; approvalId?: string | null; changeRecordIds?: readonly string[] } = {},
  ): ExternalCodingPromotionPlanRecord => {
    const now = Date.now();
    deps.db.prepare(
      `UPDATE external_coding_promotion_plans
          SET state=?, blocked_reason=COALESCE(?,blocked_reason), approval_id=COALESCE(?,approval_id),
              change_record_ids_json=COALESCE(?,change_record_ids_json), updated_at=?,
              applied_at=CASE WHEN ?='applied' THEN ? ELSE applied_at END
        WHERE promotion_id=?`,
    ).run(
      state,
      extras.blockedReason ?? null,
      extras.approvalId ?? null,
      extras.changeRecordIds ? JSON.stringify(extras.changeRecordIds) : null,
      now,
      state,
      now,
      promotionId,
    );
    return get(promotionId)!;
  };
  const bindPromotionJob = (promotionId: string, handle: DurableJobHandle): ExternalCodingPromotionPlanRecord => {
    const before = get(promotionId);
    if (!before) throw new ExternalCodingPromotionError('PROMOTION_NOT_FOUND', 'Promotion plan was not found');
    if (before.promotionJobId === handle.jobId
      && before.promotionAttemptId === handle.attemptId
      && before.promotionGeneration === handle.generation) return before;
    const priorJob = before.promotionJobId ? deps.engine.getJob(before.promotionJobId) : null;
    const mayReplaceTerminalReview = before.state === 'blocked_drift'
      && priorJob !== null
      && priorJob.terminalAt !== null;
    const changed = deps.db.prepare(
      `UPDATE external_coding_promotion_plans
          SET promotion_job_id=?,promotion_attempt_id=?,promotion_generation=?,updated_at=?
        WHERE promotion_id=? AND state IN ('prepared','approval_required','blocked_drift')
          AND (promotion_job_id IS NULL OR ?=1)`,
    ).run(handle.jobId, handle.attemptId, handle.generation, Date.now(), promotionId, mayReplaceTerminalReview ? 1 : 0);
    const current = get(promotionId);
    if (!current || (changed.changes !== 1 && (
      current.promotionJobId !== handle.jobId
      || current.promotionAttemptId !== handle.attemptId
      || current.promotionGeneration !== handle.generation
    ))) {
      throw new ExternalCodingPromotionError('PROMOTION_AUTHORITY_CONFLICT', 'Promotion plan belongs to another durable Attempt');
    }
    return current;
  };
  const captureTarget = async (handle: DurableJobHandle, plan: ExternalCodingPromotionPlanRecord) => {
    const lease = deps.engine.codingWorkspaces.get(plan.workspaceLeaseId);
    if (!lease) throw new ExternalCodingPromotionError('WORKSPACE_LEASE_NOT_FOUND', 'Coding workspace lease is unavailable');
    return deps.engine.repository.captureSnapshot({
      ...authority(handle),
      requestedPath: lease.sourcePath,
      producer: PRODUCER,
    });
  };
  const requireUnchangedTarget = async (handle: DurableJobHandle, plan: ExternalCodingPromotionPlanRecord) => {
    const lease = deps.engine.codingWorkspaces.get(plan.workspaceLeaseId);
    if (!lease) throw new ExternalCodingPromotionError('WORKSPACE_LEASE_NOT_FOUND', 'Coding workspace lease is unavailable');
    const fresh = await captureTarget(handle, plan);
    const reason = targetDrift(fresh, plan.targetHead, lease.protectedPaths);
    if (reason || fresh.stateDigest !== plan.targetStateDigest) {
      updateState(plan.promotionId, 'blocked_drift', {
        blockedReason: reason ?? 'target_state_digest_changed',
      });
      throw new ExternalCodingPromotionError('TARGET_WORKSPACE_DRIFT', 'Target workspace changed after coding review');
    }
    return fresh;
  };
  const plansFromCandidate = async (plan: ExternalCodingPromotionPlanRecord): Promise<FileChangePlan[]> => {
    const lease = deps.engine.codingWorkspaces.get(plan.workspaceLeaseId);
    const candidate = deps.engine.repository.getSnapshot(plan.candidateSnapshotId);
    const target = deps.engine.repository.getSnapshot(plan.targetSnapshotId);
    if (!lease || !candidate || !target || candidate.incomplete || target.incomplete) {
      throw new ExternalCodingPromotionError('PROMOTION_SNAPSHOT_UNAVAILABLE', 'Promotion snapshots are incomplete or unavailable');
    }
    const plans: FileChangePlan[] = [];
    for (const changedPath of plan.changedPaths) {
      const candidateEntry = deps.engine.repository.getEntry(candidate.id, changedPath);
      const targetEntry = deps.engine.repository.getEntry(target.id, changedPath);
      if (!candidateEntry) {
        if (!targetEntry) throw new ExternalCodingPromotionError('PROMOTION_PATH_MISSING', `Changed path is absent from both snapshots: ${changedPath}`);
        plans.push({ operation: 'delete', path: changedPath });
        continue;
      }
      if (candidateEntry.captureStatus !== 'captured' || candidateEntry.contentHash === null) {
        throw new ExternalCodingPromotionError('PROMOTION_TEXT_ONLY', `Promotion requires captured UTF-8 text: ${changedPath}`);
      }
      const bytes = await readFile(path.join(lease.worktreePath, changedPath));
      if (createHash('sha256').update(bytes).digest('hex') !== candidateEntry.contentHash || bytes.includes(0)) {
        throw new ExternalCodingPromotionError('CANDIDATE_CHANGED', `Candidate path changed after review: ${changedPath}`);
      }
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      plans.push({ operation: targetEntry ? 'modify' : 'create', path: changedPath, content });
    }
    return plans;
  };

  const admissionFor = (plan: ExternalCodingPromotionPlanRecord, instanceId: string, operation: 'apply' | 'discard') => {
    const parent = deps.engine.getJob(plan.parentJobId);
    if (!parent) throw new ExternalCodingPromotionError('PARENT_JOB_NOT_FOUND', 'Promotion parent Job is unavailable');
    return {
      entryPoint: 'workbench',
      source: PRODUCER,
      sessionId: parent.sessionId,
      workspaceId: parent.workspaceId,
      instanceId,
      idempotencyNamespace: `external-coding-promotion:${plan.promotionId}`,
      idempotencyKey: `${operation}:${plan.planDigest}`,
      requestFingerprint: digest({ operation, promotionId: plan.promotionId, planDigest: plan.planDigest }),
      goal: operation === 'apply' ? 'Apply reviewed coding changes' : 'Discard reviewed coding changes',
      title: operation === 'apply' ? 'Apply coding changes' : 'Discard coding changes',
      parentJobId: parent.id,
      rootJobId: parent.rootJobId,
    };
  };

  return {
    async prepareCandidate(input) {
      requireActiveChild(deps.engine, input);
      const existing = forSession(input.codingSessionId);
      if (existing) return existing;
      const session = deps.engine.coding.get(input.codingSessionId);
      if (!session || session.childJobId !== input.childJobId
        || session.childAttemptId !== input.childAttemptId
        || session.childGeneration !== input.childGeneration) {
        throw new ExternalCodingPromotionError('SESSION_LINEAGE_MISMATCH', 'Coding session lineage does not match candidate authority');
      }
      const parentJob = deps.engine.getJob(session.parentJobId);
      const assignment = deps.engine.worker.getWorkerAssignment(session.assignmentId);
      const parentAttempt = assignment
        ? deps.engine.getAttempt(assignment.parentAttemptId)
        : null;
      if (!parentJob || !assignment
        || assignment.parentJobId !== parentJob.id
        || assignment.childJobId !== session.childJobId
        || !parentAttempt
        || parentAttempt.jobId !== parentJob.id
        || parentAttempt.generation !== assignment.parentGeneration) {
        throw new ExternalCodingPromotionError('PARENT_LINEAGE_MISSING', 'Coding session parent lineage is unavailable');
      }
      const mutation = deps.engine.codingMutations.getForSession(input.codingSessionId);
      const lease = deps.engine.codingWorkspaces.get(session.workspaceLeaseId);
      if (!mutation || mutation.state !== 'verified' || !mutation.postSnapshotId
        || mutation.protectedPathViolations.length > 0 || mutation.unexpectedPaths.length > 0
        || !lease || !['ready', 'review_pending'].includes(lease.state)) {
        throw new ExternalCodingPromotionError('CANDIDATE_NOT_VERIFIED', 'Only independently verified isolated changes can enter review');
      }
      const candidate = deps.engine.repository.getSnapshot(mutation.postSnapshotId);
      if (!candidate || candidate.incomplete) {
        throw new ExternalCodingPromotionError('CANDIDATE_SNAPSHOT_INCOMPLETE', 'Candidate snapshot is incomplete');
      }
      const target = await deps.engine.repository.captureSnapshot({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
        fenceToken: input.childFenceToken,
        requestedPath: lease.sourcePath,
        producer: input.producer ?? PRODUCER,
      });
      const drift = targetDrift(target, lease.baseHead, lease.protectedPaths);
      const state: ExternalCodingPromotionState = drift ? 'blocked_drift' : 'prepared';
      const changedPaths = [...mutation.changedPaths].sort();
      const candidateEntries = changedPaths.map((changedPath) => {
        const entry = deps.engine.repository.getEntry(candidate.id, changedPath);
        return { path: changedPath, contentHash: entry?.contentHash ?? null, status: entry?.captureStatus ?? 'absent' };
      });
      const planDigest = digest({
        schemaVersion: 1,
        codingSessionId: input.codingSessionId,
        mutationReceiptId: mutation.receiptId,
        targetHead: target.headCommit,
        targetStateDigest: target.stateDigest,
        candidateStateDigest: candidate.stateDigest,
        candidateEntries,
      });
      const promotionId = externalCodingIdentity('coding_promotion', {
        codingSessionId: input.codingSessionId,
        planDigest,
      });
      const now = input.now ?? Date.now();
      deps.db.prepare(
        `INSERT INTO external_coding_promotion_plans
           (promotion_id,coding_session_id,workspace_lease_id,parent_job_id,parent_attempt_id,parent_generation,
            mutation_receipt_id,target_snapshot_id,candidate_snapshot_id,target_head,candidate_head,
            target_state_digest,plan_digest,changed_paths_json,blocked_reason,change_record_ids_json,
            validation_refs_json,state,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        promotionId,
        input.codingSessionId,
        lease.workspaceLeaseId,
        parentJob.id,
        parentAttempt.id,
        parentAttempt.generation,
        mutation.receiptId,
        target.id,
        candidate.id,
        target.headCommit ?? '',
        candidate.headCommit ?? '',
        target.stateDigest,
        planDigest,
        JSON.stringify(changedPaths),
        drift,
        '[]',
        JSON.stringify(session.validationRefs),
        state,
        now,
        now,
      );
      deps.engine.appendJobEvent({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
        type: state === 'prepared' ? 'coding.promotion_prepared' : 'coding.promotion_blocked',
        payload: { promotionId, planDigest, changedPaths, drift },
        producer: input.producer ?? PRODUCER,
        idempotencyKey: `coding-promotion-prepared:${promotionId}`,
      });
      return get(promotionId)!;
    },
    get,
    getForSession: forSession,
    listForParent(parentJobId) {
      return (deps.db.prepare(
        'SELECT * FROM external_coding_promotion_plans WHERE parent_job_id=? ORDER BY created_at,promotion_id',
      ).all(parentJobId) as PromotionRow[]).map(mapPlan);
    },
    async apply(input) {
      const initial = get(input.promotionId);
      if (!initial) throw new ExternalCodingPromotionError('PROMOTION_NOT_FOUND', 'Promotion plan was not found');
      if (initial.state !== 'prepared' && initial.state !== 'approval_required') {
        throw new ExternalCodingPromotionError('PROMOTION_NOT_APPLICABLE', `Promotion is ${initial.state}`);
      }
      return executeDurableJob({
        engine: deps.engine,
        ownerId: input.ownerId,
        admission: admissionFor(initial, input.instanceId, 'apply'),
        execute: async (handle): Promise<ExternalCodingPromotionResult> => {
          let plan = bindPromotionJob(input.promotionId, handle);
          const filePlans = await plansFromCandidate(plan);
          await requireUnchangedTarget(handle, plan);
          const batchToolCallId = externalCodingIdentity('coding_promotion_batch', {
            promotionId: plan.promotionId,
            planDigest: plan.planDigest,
          });
          const normalized = normalizeExecutionPlan({
            toolName: 'external_coding_apply',
            args: {
              promotion_id: plan.promotionId,
              plan_digest: plan.planDigest,
              files: filePlans.map((item) => ({
                operation: item.operation,
                path: item.path,
                content_hash: item.content === undefined ? null : createHash('sha256').update(item.content).digest('hex'),
              })),
            },
            cwd: deps.engine.codingWorkspaces.get(plan.workspaceLeaseId)!.sourcePath,
            mutates: true,
            riskTier: 'caution',
            policy: policy(deps.engine.codingWorkspaces.get(plan.workspaceLeaseId)!.sourcePath),
          });
          const approval = input.actions.request({
            ...authority(handle),
            toolCallId: batchToolCallId,
            effectId: null,
            toolName: 'external_coding_apply',
            riskTier: 'caution',
            riskReasons: ['Apply exact reviewed coding changes to the target workspace'],
            normalized,
          });
          input.actions.markDisplayed(approval.approvalId);
          plan = updateState(plan.promotionId, 'approval_required', { approvalId: approval.approvalId });
          const decision = await input.requestApproval({ promotion: plan, approval, files: plan.changedPaths });
          const decided = input.actions.decide({
            approvalId: approval.approvalId,
            ...authority(handle),
            actionDigest: normalized.actionDigest,
            policySnapshotId: approval.policySnapshotId,
            decision: decision.decision,
            decidedBy: decision.decidedBy,
            decisionChannel: decision.decisionChannel,
          });
          if (decided.state !== 'approved') {
            plan = updateState(plan.promotionId, 'rejected', { blockedReason: `promotion_${decided.state}` });
            await deps.engine.codingWorkspaces.releaseReviewed({
              promotionJobId: handle.jobId,
              promotionAttemptId: handle.attemptId,
              promotionGeneration: handle.generation,
              promotionFenceToken: handle.fenceToken,
              workspaceLeaseId: plan.workspaceLeaseId,
              codingSessionId: plan.codingSessionId,
              promotionId: plan.promotionId,
              disposition: 'discard',
            });
            return { promotion: get(plan.promotionId)!, changeRecordIds: [], disposition: 'rejected' };
          }
          const batchAuthorized = input.actions.authorizeExecution({
            approvalId: approval.approvalId,
            ...authority(handle),
            toolCallId: batchToolCallId,
            effectId: null,
            actionDigest: normalized.actionDigest,
            policySnapshotId: approval.policySnapshotId,
          });
          if (!batchAuthorized.authorized) {
            throw new ExternalCodingPromotionError('PROMOTION_NOT_AUTHORIZED', batchAuthorized.reason ?? 'Promotion approval was not executable');
          }
          const promotionBase = await requireUnchangedTarget(handle, plan);
          plan = updateState(plan.promotionId, 'applying');
          let baseSnapshot = promotionBase;
          const changeRecordIds: string[] = [];
          try {
            for (let index = 0; index < filePlans.length; index += 1) {
              if (handle.signal.aborted) throw new ExternalCodingPromotionError('PROMOTION_CANCELLED', 'Promotion was cancelled before the next file');
              const filePlan = filePlans[index];
              const toolName = toolFor(filePlan);
              const args = argsFor(filePlan);
              const toolCallId = externalCodingIdentity('coding_promotion_change', {
                promotionId: plan.promotionId,
                index,
                path: filePlan.path,
              });
              const intent = await deps.engine.changes.prepare({
                ...authority(handle),
                toolCallId,
                baseSnapshotId: baseSnapshot.id,
                plan: filePlan,
                producer: PRODUCER,
              });
              const prepared = deps.engine.prepareToolCall({
                ...authority(handle),
                toolCallId,
                toolName,
                normalizedArgsDigest: normalizedArgsDigest(args),
                riskTier: filePlan.operation === 'delete' ? 'dangerous' : 'caution',
                mutates: true,
                producer: PRODUCER,
                effect: {
                  classification: 'reconcilable_mutation',
                  kind: filePlan.operation === 'delete' ? 'filesystem.delete' : 'filesystem.write',
                  target: path.join(deps.engine.codingWorkspaces.get(plan.workspaceLeaseId)!.sourcePath, filePlan.path),
                  retrySafety: 'reconcile_before_retry',
                  idempotencySupported: true,
                  idempotencyKey: `coding-promotion:${plan.promotionId}:${index}`,
                  reconciliationSupported: true,
                  verificationSupported: true,
                  approvalRequirement: 'policy',
                  approvalState: 'pending',
                  sensitiveFields: ['content'],
                  redactionRules: ['digest_arguments', 'omit_sensitive_values'],
                  trusted: true,
                },
              });
              if (!prepared.effectId) throw new ExternalCodingPromotionError('EFFECT_NOT_CREATED', 'Promotion effect was not created');
              deps.engine.changes.bindEffect({ ...authority(handle), intentId: intent.intentId, effectId: prepared.effectId });
              const exact = normalizeExecutionPlan({
                toolName,
                args,
                cwd: deps.engine.codingWorkspaces.get(plan.workspaceLeaseId)!.sourcePath,
                mutates: true,
                riskTier: filePlan.operation === 'delete' ? 'dangerous' : 'caution',
                policy: policy(deps.engine.codingWorkspaces.get(plan.workspaceLeaseId)!.sourcePath),
              });
              const derived = input.actions.request({
                ...authority(handle),
                toolCallId,
                effectId: prepared.effectId,
                toolName,
                riskTier: filePlan.operation === 'delete' ? 'dangerous' : 'caution',
                riskReasons: [`Exact member of reviewed promotion ${plan.planDigest}`],
                normalized: exact,
              });
              deps.engine.changes.bindApproval({
                ...authority(handle),
                intentId: intent.intentId,
                effectId: prepared.effectId,
                approvalId: derived.approvalId,
                actionDigest: exact.actionDigest,
              });
              input.actions.decide({
                approvalId: derived.approvalId,
                ...authority(handle),
                actionDigest: exact.actionDigest,
                policySnapshotId: derived.policySnapshotId,
                decision: 'approved',
                decidedBy: `promotion:${approval.approvalId}`,
                decisionChannel: 'derived_exact_action',
              });
              deps.engine.resolveToolCallApproval({
                ...authority(handle),
                toolCallId,
                state: 'approved',
                approvalId: derived.approvalId,
                actionDigest: exact.actionDigest,
                producer: PRODUCER,
              });
              const authorized = input.actions.authorizeExecution({
                approvalId: derived.approvalId,
                ...authority(handle),
                toolCallId,
                effectId: prepared.effectId,
                actionDigest: exact.actionDigest,
                policySnapshotId: derived.policySnapshotId,
              });
              if (!authorized.authorized) throw new ExternalCodingPromotionError('CHANGE_NOT_AUTHORIZED', authorized.reason ?? 'Exact change approval was not executable');
              deps.engine.startToolCall({ ...authority(handle), toolCallId, producer: PRODUCER });
              const record = await deps.engine.changes.execute({
                ...authority(handle),
                intentId: intent.intentId,
                effectId: prepared.effectId,
                approvalId: derived.approvalId,
                actionDigest: exact.actionDigest,
                plan: filePlan,
                producer: PRODUCER,
                signal: handle.signal,
              });
              deps.engine.completeToolCall({
                ...authority(handle),
                toolCallId,
                state: record.state === 'committed' ? 'completed' : record.state === 'unknown' ? 'unknown' : 'failed',
                sideEffectState: record.state === 'committed' ? 'committed' : record.state === 'unknown' ? 'unknown' : 'failed',
                resultRef: record.changeId,
                verificationRef: record.diffEvidenceId,
                producer: PRODUCER,
              });
              if (record.state !== 'committed' || !record.descendantSnapshotId) {
                throw new ExternalCodingPromotionError('CHANGE_NOT_VERIFIED', `Promotion change did not commit: ${filePlan.path}`);
              }
              changeRecordIds.push(record.changeId);
              baseSnapshot = deps.engine.repository.getSnapshot(record.descendantSnapshotId)!;
            }
          } catch (error) {
            const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'PROMOTION_FAILED';
            const uncertain = ['READBACK_FAILED', 'DESCENDANT_SNAPSHOT_FAILED', 'CHANGE_CANCELLED_UNKNOWN', 'MUTATION_FAILED'].includes(code);
            updateState(plan.promotionId, uncertain ? 'unknown' : 'blocked_drift', {
              blockedReason: code,
              changeRecordIds,
            });
            throw error;
          }
          plan = updateState(plan.promotionId, 'applied', { changeRecordIds });
          await deps.engine.codingWorkspaces.releaseReviewed({
            promotionJobId: handle.jobId,
            promotionAttemptId: handle.attemptId,
            promotionGeneration: handle.generation,
            promotionFenceToken: handle.fenceToken,
            workspaceLeaseId: plan.workspaceLeaseId,
            codingSessionId: plan.codingSessionId,
            promotionId: plan.promotionId,
            disposition: 'promoted',
          });
          return { promotion: get(plan.promotionId)!, changeRecordIds, disposition: 'applied' };
        },
        finalize: (value) => ({
          status: value.disposition === 'applied' || value.disposition === 'rejected' ? 'completed' : 'failed',
          outcome: value.disposition,
          finishReason: `external_coding_promotion_${value.disposition}`,
          evidence: {
            promotionId: value.promotion.promotionId,
            planDigest: value.promotion.planDigest,
            changeRecordIds: value.changeRecordIds,
          },
          jobCard: { filesTouched: [...value.promotion.changedPaths] },
        }),
        classifyError: (error) => {
          const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'PROMOTION_FAILED';
          const uncertain = get(input.promotionId)?.state === 'unknown';
          return uncertain
            ? { status: 'unknown', outcome: 'unknown', finishReason: code, evidence: { promotionId: input.promotionId, code } }
            : { status: 'failed', outcome: 'failed', finishReason: code, evidence: { promotionId: input.promotionId, code } };
        },
      });
    },
    async discard(input) {
      const initial = get(input.promotionId);
      if (!initial) throw new ExternalCodingPromotionError('PROMOTION_NOT_FOUND', 'Promotion plan was not found');
      if (!['prepared', 'approval_required', 'blocked_drift'].includes(initial.state)) {
        throw new ExternalCodingPromotionError('PROMOTION_NOT_DISCARDABLE', `Promotion is ${initial.state}`);
      }
      return executeDurableJob({
        engine: deps.engine,
        ownerId: input.ownerId,
        admission: admissionFor(initial, input.instanceId, 'discard'),
        execute: async (handle) => {
          const bound = bindPromotionJob(input.promotionId, handle);
          const plan = updateState(bound.promotionId, 'rejected', {
            blockedReason: `discarded_by:${input.decidedBy}:${input.decisionChannel}`,
          });
          await deps.engine.codingWorkspaces.releaseReviewed({
            promotionJobId: handle.jobId,
            promotionAttemptId: handle.attemptId,
            promotionGeneration: handle.generation,
            promotionFenceToken: handle.fenceToken,
            workspaceLeaseId: plan.workspaceLeaseId,
            codingSessionId: plan.codingSessionId,
            promotionId: plan.promotionId,
            disposition: 'discard',
          });
          return { promotion: get(plan.promotionId)!, changeRecordIds: [], disposition: 'rejected' as const };
        },
        finalize: (value) => ({
          status: 'completed',
          outcome: value.disposition,
          finishReason: 'external_coding_promotion_discarded',
          evidence: { promotionId: value.promotion.promotionId, decisionChannel: input.decisionChannel },
        }),
      });
    },
  };
}
