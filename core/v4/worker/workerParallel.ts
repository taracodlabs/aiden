/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { JobEngine } from '../daemon/jobEngine';
import type { TriggerBus } from '../daemon/triggerBus';
import {
  admitReadOnlyRepositoryWorker,
  verifyReadOnlyRepositoryWorkerResult,
  type AdmitReadOnlyRepositoryWorkerInput,
  type ReadOnlyRepositoryWorkerAdmission,
  type ReadOnlyWorkerParentAuthority,
  type ReadOnlyWorkerProviderSelection,
} from './readOnlyRepositoryWorker';
import {
  computeWorkerDigest,
  type WorkerGroupAggregate,
  type WorkerGroupAggregateMember,
  type WorkerGroupMemberOutcome,
  type WorkerGroupPolicy,
  type WorkerGroupRecord,
} from './types';

export const DEFAULT_READ_ONLY_WORKER_GROUP_SIZE = 2;
export const MAX_READ_ONLY_WORKER_GROUP_SIZE = 4;
export const DEFAULT_WORKER_PROVIDER_CONCURRENCY = 2;

export function normalizeReadOnlyWorkerGroupSize(
  requested?: number,
  restrictions: { depth?: number; mutation?: boolean } = {},
): number {
  if ((restrictions.depth ?? 0) !== 0) throw new Error('Nested Worker admission is forbidden');
  if (restrictions.mutation === true) throw new Error('Worker mutation is forbidden');
  const size = requested ?? DEFAULT_READ_ONLY_WORKER_GROUP_SIZE;
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Worker group size must be a positive integer');
  if (size > MAX_READ_ONLY_WORKER_GROUP_SIZE) {
    throw new Error(`Worker group size exceeds the maximum of ${MAX_READ_ONLY_WORKER_GROUP_SIZE}`);
  }
  return size;
}

export function buildWorkerGroupAggregate(
  groupId: string,
  policy: WorkerGroupPolicy,
  inputMembers: readonly WorkerGroupAggregateMember[],
): WorkerGroupAggregate {
  const members = inputMembers.map((member) => ({
    ordinal: member.ordinal,
    memberId: member.memberId,
    assignmentId: member.assignmentId ?? null,
    childJobId: member.childJobId ?? null,
    outcome: member.outcome,
    workerResultId: member.workerResultId ?? null,
    resultHash: member.resultHash ?? null,
  })).sort((left, right) => left.ordinal - right.ordinal || left.memberId.localeCompare(right.memberId));
  const count = (outcome: WorkerGroupMemberOutcome): number => members.filter((item) => item.outcome === outcome).length;
  const counts = {
    total: members.length,
    verified: count('verified'),
    rejected: count('rejected'),
    failed: count('failed'),
    unknown: count('unknown'),
    blocked: count('blocked'),
    cancelled: count('cancelled'),
    timedOut: count('timed_out'),
    pending: count('pending') + count('admitted'),
  };
  const allVerified = counts.total > 0 && counts.verified === counts.total;
  const uncertain = counts.unknown > 0 || counts.pending > 0;
  const outcome: WorkerGroupAggregate['outcome'] = allVerified
    ? 'verified'
    : policy === 'allow_partial' && counts.verified > 0
      ? 'partial'
      : uncertain ? 'unknown' : 'failed';
  const unsigned = { groupId, policy, outcome, counts, members };
  return { ...unsigned, aggregateHash: computeWorkerDigest(unsigned) };
}

export interface ReadOnlyWorkerGroupMemberInput {
  goal: string;
  provider: ReadOnlyWorkerProviderSelection;
  boundedParentNote?: string | null;
  planStepIds?: readonly string[];
  claimIds?: readonly string[];
  sourceReferenceIds?: readonly string[];
  instructionReferenceIds?: readonly string[];
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxRuntimeMs?: number;
  maxExternalCost?: number;
  providerConcurrencyLimit?: number;
}

export interface AdmitReadOnlyRepositoryWorkerGroupInput {
  engine: JobEngine;
  triggerBus: TriggerBus;
  parent: ReadOnlyWorkerParentAuthority;
  idempotencyKey: string;
  policy: WorkerGroupPolicy;
  repositorySnapshotId: string;
  members?: readonly ReadOnlyWorkerGroupMemberInput[];
  memberTemplate?: ReadOnlyWorkerGroupMemberInput;
  memberCount?: number;
  parentConcurrencyLimit?: number;
  providerConcurrencyLimit?: number;
  producer?: string;
  depth?: number;
  mutation?: boolean;
}

export interface ReadOnlyRepositoryWorkerGroupAdmission {
  group: WorkerGroupRecord;
  admissions: ReadonlyArray<{ memberId: string; ordinal: number; admission: ReadOnlyRepositoryWorkerAdmission }>;
  failures: ReadonlyArray<{ memberId: string; ordinal: number; error: string }>;
}

function identity(prefix: string, value: unknown): string {
  return `${prefix}_${computeWorkerDigest(value).slice(0, 32)}`;
}

function groupMembers(input: AdmitReadOnlyRepositoryWorkerGroupInput): readonly ReadOnlyWorkerGroupMemberInput[] {
  if (input.members) {
    normalizeReadOnlyWorkerGroupSize(input.members.length, { depth: input.depth, mutation: input.mutation });
    return input.members;
  }
  if (!input.memberTemplate) throw new Error('Worker group requires members or a member template');
  const size = normalizeReadOnlyWorkerGroupSize(input.memberCount, { depth: input.depth, mutation: input.mutation });
  return Array.from({ length: size }, () => input.memberTemplate!);
}

function ensureParentConcurrency(
  input: AdmitReadOnlyRepositoryWorkerGroupInput,
  memberCount: number,
  existingGroup: boolean,
): number {
  const requested = input.parentConcurrencyLimit ?? DEFAULT_READ_ONLY_WORKER_GROUP_SIZE;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_READ_ONLY_WORKER_GROUP_SIZE) {
    throw new Error('Parent Worker concurrency limit must be between 1 and 4');
  }
  if (memberCount > requested) throw new Error('Worker group exceeds the parent concurrency limit');
  const existing = input.engine.resources.getBudgets(input.parent.jobId).find((budget) => budget.kind === 'workers');
  if (!existing || existing.limit === null) {
    input.engine.resources.configure({ jobId: input.parent.jobId, budgets: { workers: requested } });
  }
  else if (!existingGroup && existing.limit !== null
    && memberCount > input.engine.resources.available(input.parent.jobId, 'workers')!) {
    throw new Error('Worker group exceeds available parent Worker capacity');
  }
  return requested;
}

export function admitReadOnlyRepositoryWorkerGroup(
  input: AdmitReadOnlyRepositoryWorkerGroupInput,
): ReadOnlyRepositoryWorkerGroupAdmission {
  const members = groupMembers(input);
  const providerLimits = members.map((member) => (
    member.providerConcurrencyLimit ?? input.providerConcurrencyLimit ?? DEFAULT_WORKER_PROVIDER_CONCURRENCY
  ));
  if (providerLimits.some((limit) => !Number.isSafeInteger(limit) || limit < 1
    || limit > MAX_READ_ONLY_WORKER_GROUP_SIZE)) {
    throw new Error('Worker provider concurrency limit must be between 1 and 4');
  }
  const producer = input.producer ?? 'repository-worker-group-admission';
  const requestIdentity = {
    parentJobId: input.parent.jobId, parentAttemptId: input.parent.attemptId,
    parentGeneration: input.parent.generation, idempotencyKey: input.idempotencyKey,
  };
  const groupId = identity('worker_group', requestIdentity);
  ensureParentConcurrency(input, members.length, input.engine.worker.getWorkerGroup(groupId) !== null);
  const memberSpecs = members.map((member, index) => ({
    memberId: identity('worker_member', { groupId, ordinal: index + 1 }),
    ordinal: index + 1,
    requestedProviderId: member.provider.providerId,
  }));
  let group = input.engine.worker.createWorkerGroup({
    parentJobId: input.parent.jobId, parentAttemptId: input.parent.attemptId,
    parentGeneration: input.parent.generation, parentFenceToken: input.parent.fenceToken,
    producer, idempotencyKey: input.idempotencyKey, groupId, schemaVersion: 1,
    policy: input.policy, members: memberSpecs,
  });
  const admissions: Array<{ memberId: string; ordinal: number; admission: ReadOnlyRepositoryWorkerAdmission }> = [];
  const failures: Array<{ memberId: string; ordinal: number; error: string }> = [];
  for (const [index, member] of members.entries()) {
    const spec = memberSpecs[index]!;
    const providerLimit = providerLimits[index]!;
    const slotId = identity('worker_provider_slot', { groupId, memberId: spec.memberId });
    let slotReserved = false;
    try {
      input.engine.resources.reserveWorkerProviderConcurrency({
        providerSlotId: slotId, idempotencyKey: `${input.idempotencyKey}:provider-slot:${spec.ordinal}`,
        groupId, memberId: spec.memberId, parentJobId: input.parent.jobId,
        parentAttemptId: input.parent.attemptId, parentGeneration: input.parent.generation,
        parentFenceToken: input.parent.fenceToken, providerId: member.provider.providerId,
        limit: providerLimit,
      });
      slotReserved = true;
      const admissionInput: AdmitReadOnlyRepositoryWorkerInput = {
        engine: input.engine, triggerBus: input.triggerBus, parent: input.parent,
        idempotencyKey: `${input.idempotencyKey}:member:${spec.ordinal}`,
        goal: member.goal, repositorySnapshotId: input.repositorySnapshotId,
        provider: member.provider, producer,
        ...(member.boundedParentNote === undefined ? {} : { boundedParentNote: member.boundedParentNote }),
        ...(member.planStepIds === undefined ? {} : { planStepIds: member.planStepIds }),
        ...(member.claimIds === undefined ? {} : { claimIds: member.claimIds }),
        ...(member.sourceReferenceIds === undefined ? {} : { sourceReferenceIds: member.sourceReferenceIds }),
        ...(member.instructionReferenceIds === undefined ? {} : { instructionReferenceIds: member.instructionReferenceIds }),
        ...(member.maxModelCalls === undefined ? {} : { maxModelCalls: member.maxModelCalls }),
        ...(member.maxToolCalls === undefined ? {} : { maxToolCalls: member.maxToolCalls }),
        ...(member.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: member.maxRuntimeMs }),
        ...(member.maxExternalCost === undefined ? {} : { maxExternalCost: member.maxExternalCost }),
        group: { groupId, memberId: spec.memberId, ordinal: spec.ordinal },
      };
      admissions.push({ memberId: spec.memberId, ordinal: spec.ordinal, admission: admitReadOnlyRepositoryWorker(admissionInput) });
    } catch (error) {
      const current = input.engine.worker.getWorkerGroupMember(spec.memberId);
      const unknown = current?.assignmentId !== null && current?.assignmentId !== undefined;
      if (slotReserved) {
        input.engine.resources.settleWorkerProviderConcurrency({
          providerSlotId: slotId, unknown, safeToRelease: !unknown,
          reason: unknown ? 'admission_outcome_unknown' : 'admission_rejected_before_dispatch',
        });
      }
      if (current?.childJobId) {
        input.engine.cancelJob({
          jobId: current.childJobId, reason: 'worker_group_admission_failed', producer,
          eventIdempotencyKey: `worker-group-admission-failed:${spec.memberId}`,
        });
      }
      input.engine.worker.settleWorkerGroupMember({
        parentJobId: input.parent.jobId, parentAttemptId: input.parent.attemptId,
        parentGeneration: input.parent.generation, parentFenceToken: input.parent.fenceToken,
        producer, idempotencyKey: `worker-group-admission-rejected:${spec.memberId}`,
        groupId, memberId: spec.memberId, outcome: unknown ? 'unknown' : 'rejected',
        reason: unknown ? 'admission_outcome_unknown' : 'admission_rejected',
      });
      failures.push({
        memberId: spec.memberId, ordinal: spec.ordinal,
        error: error instanceof Error ? error.message : 'Worker group admission failed',
      });
    }
  }
  group = input.engine.worker.completeWorkerGroupAdmission({
    parentJobId: input.parent.jobId, parentAttemptId: input.parent.attemptId,
    parentGeneration: input.parent.generation, parentFenceToken: input.parent.fenceToken,
    producer, idempotencyKey: `${input.idempotencyKey}:admission-completed`, groupId,
  });
  return { group, admissions, failures };
}

function groupParent(group: WorkerGroupRecord, engine: JobEngine): ReadOnlyWorkerParentAuthority {
  const attempt = engine.getAttempt(group.parentAttemptId);
  if (!attempt?.fenceToken || attempt.generation !== group.parentGeneration) {
    throw new Error('Worker group parent authority is unavailable');
  }
  return {
    jobId: group.parentJobId, attemptId: group.parentAttemptId,
    generation: group.parentGeneration, fenceToken: attempt.fenceToken,
  };
}

function terminalOutcome(status: string | undefined): Exclude<WorkerGroupMemberOutcome, 'pending' | 'admitted' | 'verified'> | null {
  if (status === 'failed' || status === 'dead_letter' || status === 'crashed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'blocked') return 'blocked';
  if (status === 'unknown') return 'unknown';
  return null;
}

export async function joinReadOnlyRepositoryWorkerGroup(input: {
  engine: JobEngine;
  groupId: string;
  producer?: string;
}): Promise<WorkerGroupAggregate> {
  const group = input.engine.worker.getWorkerGroup(input.groupId);
  if (!group) throw new Error('Worker group was not found');
  const parent = groupParent(group, input.engine);
  const producer = input.producer ?? 'repository-worker-group-join';
  for (const member of input.engine.worker.listWorkerGroupMembers(group.groupId)) {
    if (!['pending', 'admitted'].includes(member.outcome)) continue;
    let outcome: Exclude<WorkerGroupMemberOutcome, 'pending' | 'admitted'> | null = null;
    let workerResultId: string | null = null;
    let resultHash: string | null = null;
    let reason = 'member_not_terminal';
    if (!member.assignmentId || !member.childJobId) {
      outcome = 'rejected';
      reason = 'member_not_admitted';
    } else {
      const runs = input.engine.worker.listWorkerRunsForChild(member.childJobId);
      const accepted = runs.map((run) => run.acceptedResultId
        ? input.engine.worker.getWorkerResult(run.acceptedResultId) : null).find(Boolean) ?? null;
      if (accepted?.acceptanceState === 'accepted' && accepted.status === 'completed') {
        workerResultId = accepted.workerResultId;
        resultHash = accepted.resultHash;
        try {
          await verifyReadOnlyRepositoryWorkerResult({
            engine: input.engine, parent, workerResultId: accepted.workerResultId,
            producer, idempotencyKey: `worker-group-verify:${group.groupId}:${member.memberId}`,
          });
          outcome = 'verified';
          reason = 'independently_verified';
        } catch {
          outcome = 'rejected';
          reason = 'parent_verification_failed';
        }
      } else if (accepted) {
        workerResultId = accepted.workerResultId;
        resultHash = accepted.resultHash;
        outcome = accepted.status === 'cancelled' ? 'cancelled'
          : accepted.status === 'timed_out' ? 'timed_out'
            : accepted.status === 'blocked' ? 'blocked'
              : accepted.status === 'failed' ? 'failed' : 'unknown';
        reason = `worker_result_${accepted.status}`;
      } else {
        outcome = terminalOutcome(input.engine.getJob(member.childJobId)?.status);
        reason = outcome ? `child_job_${outcome}` : reason;
      }
    }
    if (outcome) {
      input.engine.worker.settleWorkerGroupMember({
        parentJobId: parent.jobId, parentAttemptId: parent.attemptId,
        parentGeneration: parent.generation, parentFenceToken: parent.fenceToken,
        producer, idempotencyKey: `worker-group-member-join:${member.memberId}`,
        groupId: group.groupId, memberId: member.memberId, outcome,
        workerResultId, resultHash, reason,
      });
      const slot = input.engine.resources.getWorkerProviderConcurrencyForMember(member.memberId);
      if (slot) {
        const calls = member.childAttemptId && member.childGeneration !== null
          ? input.engine.workerProviderCalls.listForAttempt(member.childAttemptId, member.childGeneration) : [];
        const unknown = calls.some((call) => call.retrySafety === 'blocked_unknown'
          || call.outcomeKnowledge === 'outcome_unknown');
        input.engine.resources.settleWorkerProviderConcurrency({
          providerSlotId: slot.providerSlotId, unknown, safeToRelease: !unknown,
          reason: unknown ? 'provider_outcome_unknown' : 'member_settled',
        });
      }
    }
  }
  const currentMembers = input.engine.worker.listWorkerGroupMembers(group.groupId);
  const aggregate = buildWorkerGroupAggregate(group.groupId, group.policy, currentMembers);
  if (aggregate.counts.pending === 0) {
    input.engine.worker.settleWorkerGroup({
      parentJobId: parent.jobId, parentAttemptId: parent.attemptId,
      parentGeneration: parent.generation, parentFenceToken: parent.fenceToken,
      producer, idempotencyKey: `worker-group-settle:${group.groupId}`,
      groupId: group.groupId, state: aggregate.outcome === 'unknown' ? 'blocked_unknown' : 'settled',
      aggregateHash: aggregate.aggregateHash, reason: `aggregate_${aggregate.outcome}`,
    });
  }
  return aggregate;
}

export function fanOutReadOnlyRepositoryWorkerGroup(input: {
  engine: JobEngine;
  groupId: string;
  kind: 'cancellation' | 'timeout';
  reason: string;
  producer?: string;
  interruptAttempt?: (attemptId: string, reason: string) => void;
}): { interrupted: number; group: WorkerGroupRecord } {
  const group = input.engine.worker.getWorkerGroup(input.groupId);
  if (!group) throw new Error('Worker group was not found');
  const parent = groupParent(group, input.engine);
  const producer = input.producer ?? 'repository-worker-group-control';
  input.engine.worker.requestWorkerGroupInterruption({
    parentJobId: parent.jobId, parentAttemptId: parent.attemptId,
    parentGeneration: parent.generation, parentFenceToken: parent.fenceToken,
    producer, idempotencyKey: `worker-group-${input.kind}:${group.groupId}`,
    groupId: group.groupId, kind: input.kind, reason: input.reason,
  });
  const attemptIds: string[] = [];
  for (const member of input.engine.worker.listWorkerGroupMembers(group.groupId)) {
    if (!member.childJobId || !member.childAttemptId || member.childGeneration === null) continue;
    const attempt = input.engine.getAttempt(member.childAttemptId);
    if (!attempt?.fenceToken || attempt.generation !== member.childGeneration) continue;
    if (input.kind === 'timeout') {
      input.engine.workerProviderCalls.recordInterruptionForAttempt({
        childJobId: member.childJobId, childAttemptId: member.childAttemptId,
        childGeneration: member.childGeneration, childFenceToken: attempt.fenceToken,
        kind: 'timeout', reason: input.reason,
        idempotencyKey: `worker-group-timeout:${group.groupId}:${member.memberId}`,
      });
    }
    const cancelled = input.engine.cancelJob({
      jobId: member.childJobId, reason: input.reason, producer,
      eventIdempotencyKey: `worker-group-${input.kind}:${group.groupId}:${member.memberId}`,
    });
    if (cancelled.applied) attemptIds.push(member.childAttemptId);
  }
  for (const attemptId of attemptIds) input.interruptAttempt?.(attemptId, input.reason);
  reconcileInterruptedReadOnlyRepositoryWorkerGroups({
    engine: input.engine,
    parentJobId: group.parentJobId,
    producer,
  });
  return { interrupted: attemptIds.length, group: input.engine.worker.getWorkerGroup(group.groupId)! };
}

export function reconcileInterruptedReadOnlyRepositoryWorkerGroups(input: {
  engine: JobEngine;
  parentJobId: string;
  producer?: string;
}): { inspected: number; settled: number } {
  const producer = input.producer ?? 'repository-worker-group-reconciliation';
  const groups = input.engine.worker.listWorkerGroupsForParent(input.parentJobId)
    .filter((group) => group.state === 'cancelling' || group.state === 'timed_out');
  let settled = 0;
  for (const group of groups) {
    for (const member of input.engine.worker.listWorkerGroupMembers(group.groupId)) {
      if (!['pending', 'admitted'].includes(member.outcome)) continue;
      const child = member.childJobId ? input.engine.getJob(member.childJobId) : null;
      const outcome: Exclude<WorkerGroupMemberOutcome, 'pending' | 'admitted' | 'verified'> | null =
        member.childJobId === null ? 'rejected'
          : child?.status === 'cancelled' ? (group.timeoutRequestedAt === null ? 'cancelled' : 'timed_out')
            : child?.status === 'blocked' ? 'blocked'
              : child?.status === 'unknown' ? 'unknown'
                : ['failed', 'crashed', 'dead_letter'].includes(child?.status ?? '') ? 'failed' : null;
      if (!outcome) continue;
      input.engine.worker.reconcileWorkerGroupMember({
        groupId: group.groupId,
        memberId: member.memberId,
        outcome,
        reason: `canonical_child_${outcome}`,
        producer,
        idempotencyKey: `worker-group-reconcile-member:${member.memberId}:${outcome}`,
      });
    }
    const aggregate = buildWorkerGroupAggregate(
      group.groupId,
      group.policy,
      input.engine.worker.listWorkerGroupMembers(group.groupId),
    );
    if (aggregate.counts.pending === 0) {
      input.engine.worker.reconcileWorkerGroup({
        groupId: group.groupId,
        state: aggregate.outcome === 'unknown' ? 'blocked_unknown' : 'settled',
        aggregateHash: aggregate.aggregateHash,
        reason: `aggregate_${aggregate.outcome}`,
        producer,
        idempotencyKey: `worker-group-reconcile:${group.groupId}`,
      });
      for (const member of aggregate.members) {
        const slot = input.engine.resources.getWorkerProviderConcurrencyForMember(member.memberId);
        if (!slot || slot.state !== 'reserved') continue;
        const unknown = member.outcome === 'unknown';
        input.engine.resources.settleWorkerProviderConcurrency({
          providerSlotId: slot.providerSlotId,
          unknown,
          safeToRelease: !unknown,
          reason: unknown ? 'provider_outcome_unknown' : 'member_settled',
        });
      }
      settled += 1;
    }
  }
  return { inspected: groups.length, settled };
}

export function projectReadOnlyRepositoryWorkerGroups(input: {
  engine: JobEngine;
  limit?: number;
}): { inspected: number; pendingVerification: string[] } {
  const groups = input.engine.worker.listWorkerGroupsPendingSettlement({ limit: input.limit ?? 100 });
  const pendingVerification: string[] = [];
  for (const group of groups) {
    for (const member of input.engine.worker.listWorkerGroupMembers(group.groupId)) {
      if (!['pending', 'admitted'].includes(member.outcome)) continue;
      if (!member.childJobId) {
        input.engine.worker.reconcileWorkerGroupMember({
          groupId: group.groupId, memberId: member.memberId, outcome: 'rejected',
          reason: 'canonical_admission_rejected', producer: 'repository-worker-group-recovery',
          idempotencyKey: `worker-group-recovery:${member.memberId}:rejected`,
        });
        continue;
      }
      const runs = input.engine.worker.listWorkerRunsForChild(member.childJobId);
      if (runs.some((run) => run.acceptedResultId !== null)) {
        pendingVerification.push(group.groupId);
        continue;
      }
      const child = input.engine.getJob(member.childJobId);
      const outcome: Exclude<WorkerGroupMemberOutcome, 'pending' | 'admitted' | 'verified'> | null =
        child?.status === 'cancelled' ? (group.timeoutRequestedAt === null ? 'cancelled' : 'timed_out')
          : child?.status === 'blocked' ? 'blocked'
            : child?.status === 'unknown' ? 'unknown'
              : ['failed', 'crashed', 'dead_letter'].includes(child?.status ?? '') ? 'failed' : null;
      if (outcome) {
        input.engine.worker.reconcileWorkerGroupMember({
          groupId: group.groupId, memberId: member.memberId, outcome,
          reason: `canonical_child_${outcome}`, producer: 'repository-worker-group-recovery',
          idempotencyKey: `worker-group-recovery:${member.memberId}:${outcome}`,
        });
      }
    }
    const aggregate = buildWorkerGroupAggregate(
      group.groupId,
      group.policy,
      input.engine.worker.listWorkerGroupMembers(group.groupId),
    );
    if (aggregate.counts.pending === 0) {
      input.engine.worker.reconcileWorkerGroup({
        groupId: group.groupId,
        state: aggregate.outcome === 'unknown' ? 'blocked_unknown' : 'settled',
        aggregateHash: aggregate.aggregateHash,
        reason: `aggregate_${aggregate.outcome}`,
        producer: 'repository-worker-group-recovery',
        idempotencyKey: `worker-group-recovery:${group.groupId}:settled`,
      });
      for (const member of aggregate.members) {
        const slot = input.engine.resources.getWorkerProviderConcurrencyForMember(member.memberId);
        if (!slot || slot.state !== 'reserved') continue;
        const unknown = member.outcome === 'unknown';
        input.engine.resources.settleWorkerProviderConcurrency({
          providerSlotId: slot.providerSlotId,
          unknown,
          safeToRelease: !unknown,
          reason: unknown ? 'provider_outcome_unknown' : 'member_settled',
        });
      }
    }
  }
  return { inspected: groups.length, pendingVerification: [...new Set(pendingVerification)].sort() };
}
