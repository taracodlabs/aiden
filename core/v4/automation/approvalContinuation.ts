/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

import type { ApprovalRecord, NormalizedAction } from '../actionAuthority';
import type { JobEngine } from '../daemon/jobEngine';
import type { ToolCallResult } from '../../../providers/v4/types';
import type { ScriptSpec } from './types';

export type AutomationApprovalContinuationState =
  | 'preparing' | 'waiting_approval' | 'claimed' | 'approved'
  | 'denied' | 'cancelled' | 'consumed' | 'unknown';

export interface AutomationContinuationHandle {
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
}

export interface AutomationApprovalContinuationRecord {
  continuationId: string;
  automationId: string;
  revisionId: string;
  occurrenceId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  fenceTokenDigest: string;
  scriptSpec: ScriptSpec;
  scriptSpecDigest: string;
  stepIndex: number;
  toolCallId: string;
  effectId: string | null;
  actionDigest: string | null;
  policySnapshotId: string | null;
  approvalId: string | null;
  state: AutomationApprovalContinuationState;
  claimOwner: string | null;
  claimToken: string | null;
  claimExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  terminalAt: number | null;
}

interface ContinuationRow {
  continuation_id: string;
  automation_id: string;
  revision_id: string;
  occurrence_id: string;
  job_id: string;
  attempt_id: string;
  generation: number;
  fence_token_digest: string;
  script_spec_json: string;
  script_spec_digest: string;
  step_index: number;
  tool_call_id: string;
  effect_id: string | null;
  action_digest: string | null;
  policy_snapshot_id: string | null;
  approval_id: string | null;
  state: AutomationApprovalContinuationState;
  claim_owner: string | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function map(row: ContinuationRow): AutomationApprovalContinuationRecord {
  return {
    continuationId: row.continuation_id,
    automationId: row.automation_id,
    revisionId: row.revision_id,
    occurrenceId: row.occurrence_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    generation: row.generation,
    fenceTokenDigest: row.fence_token_digest,
    scriptSpec: JSON.parse(row.script_spec_json) as ScriptSpec,
    scriptSpecDigest: row.script_spec_digest,
    stepIndex: row.step_index,
    toolCallId: row.tool_call_id,
    effectId: row.effect_id,
    actionDigest: row.action_digest,
    policySnapshotId: row.policy_snapshot_id,
    approvalId: row.approval_id,
    state: row.state,
    claimOwner: row.claim_owner,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

export interface AutomationApprovalContinuationAuthority {
  get(continuationId: string): AutomationApprovalContinuationRecord | null;
  findResume(jobId: string, attemptId: string, generation: number): AutomationApprovalContinuationRecord | null;
  prepare(command: {
    handle: AutomationContinuationHandle;
    ownerId: string;
    scriptSpec: ScriptSpec;
    stepIndex: number;
    toolCallId: string;
    effectId: string | null;
    normalized: NormalizedAction;
    claimTtlMs?: number;
    now?: number;
  }): AutomationApprovalContinuationRecord;
  bindApproval(command: {
    continuationId: string;
    claimToken: string;
    ownerId: string;
    approval: ApprovalRecord;
    now?: number;
  }): AutomationApprovalContinuationRecord;
  settle(command: {
    continuationId: string;
    claimToken: string;
    ownerId: string;
    result: ToolCallResult;
    now?: number;
  }): AutomationApprovalContinuationRecord;
  hasPendingForAttempt(jobId: string, attemptId: string, generation: number): boolean;
  releaseForHost(jobId: string, attemptId: string, generation: number, ownerId: string, now?: number): number;
  cancelForJob(jobId: string, reason: string, now?: number): number;
}

export function createAutomationApprovalContinuationAuthority(options: {
  db: Database.Database;
  jobEngine: JobEngine;
}): AutomationApprovalContinuationAuthority {
  const { db, jobEngine } = options;
  const get = (continuationId: string): AutomationApprovalContinuationRecord | null => {
    const row = db.prepare('SELECT * FROM automation_approval_continuations WHERE continuation_id = ?')
      .get(continuationId) as ContinuationRow | undefined;
    return row ? map(row) : null;
  };
  const validateExecution = (handle: AutomationContinuationHandle, ownerId: string, now: number): void => {
    const job = jobEngine.getJob(handle.jobId);
    const attempt = jobEngine.getAttempt(handle.attemptId);
    if (
      !job || !attempt || job.activeAttemptId !== handle.attemptId
      || attempt.jobId !== handle.jobId || attempt.generation !== handle.generation
      || attempt.fenceToken !== handle.fenceToken || attempt.leaseOwner !== ownerId
      || attempt.leaseExpiresAt === null || attempt.leaseExpiresAt <= now
    ) throw new Error('Automation continuation has stale Job, Attempt, generation, fence, or lease authority');
    if (!job.automationId || !job.automationRevisionId || !job.automationOccurrenceId) {
      throw new Error('Automation continuation requires exact Automation, Revision, and Occurrence identity');
    }
  };

  return {
    get,
    findResume(jobId, attemptId, generation) {
      const row = db.prepare(
        `SELECT * FROM automation_approval_continuations
          WHERE job_id = ? AND attempt_id = ? AND generation = ?
            AND state IN ('preparing','waiting_approval','claimed','approved','unknown')
          ORDER BY step_index LIMIT 1`,
      ).get(jobId, attemptId, generation) as ContinuationRow | undefined;
      return row ? map(row) : null;
    },
    prepare(command) {
      const now = command.now ?? Date.now();
      validateExecution(command.handle, command.ownerId, now);
      const job = jobEngine.getJob(command.handle.jobId)!;
      const specJson = stableJson(command.scriptSpec);
      const specDigest = digest(specJson);
      const revision = db.prepare(
        'SELECT spec_json FROM automation_revisions WHERE revision_id = ? AND automation_id = ?',
      ).get(job.automationRevisionId, job.automationId) as { spec_json: string } | undefined;
      if (!revision) throw new Error('Automation continuation revision is missing');
      const revisionSpec = JSON.parse(revision.spec_json) as { action?: { kind?: string; script?: ScriptSpec } };
      if (revisionSpec.action?.kind !== 'script' || digest(stableJson(revisionSpec.action.script)) !== specDigest) {
        throw new Error('Automation continuation ScriptSpec does not match its immutable Revision');
      }
      if (command.stepIndex < 0 || command.stepIndex >= command.scriptSpec.steps.length) {
        throw new Error('Automation continuation step cursor is outside the ScriptSpec');
      }
      const continuationId = `automation_continuation_${digest({
        jobId: command.handle.jobId,
        attemptId: command.handle.attemptId,
        generation: command.handle.generation,
        stepIndex: command.stepIndex,
      }).slice(0, 32)}`;
      const claimToken = `continuation_claim_${randomBytes(12).toString('hex')}`;
      const claimExpiresAt = now + Math.max(1_000, command.claimTtlMs ?? 60_000);
      return db.transaction(() => {
        const existing = get(continuationId);
        if (existing) {
          if (
            existing.automationId !== job.automationId
            || existing.revisionId !== job.automationRevisionId
            || existing.occurrenceId !== job.automationOccurrenceId
            || existing.scriptSpecDigest !== specDigest
            || existing.toolCallId !== command.toolCallId
            || existing.actionDigest !== command.normalized.actionDigest
            || existing.policySnapshotId !== command.normalized.policySnapshot.policySnapshotId
            || existing.effectId !== command.effectId
          ) throw new Error('Automation continuation identity or approved action changed');
          if (['consumed', 'denied', 'cancelled'].includes(existing.state)) return existing;
          if (
            existing.claimOwner === command.ownerId
            && existing.claimToken
            && existing.claimExpiresAt !== null
            && existing.claimExpiresAt > now
          ) return existing;
          const claimed = db.prepare(
            `UPDATE automation_approval_continuations
                SET state = 'claimed',claim_owner = ?,claim_token = ?,claim_expires_at = ?,updated_at = ?
              WHERE continuation_id = ?
                AND (claim_owner IS NULL OR claim_expires_at <= ?)`,
          ).run(command.ownerId, claimToken, claimExpiresAt, now, continuationId, now);
          if (claimed.changes !== 1) throw new Error('Automation continuation is claimed by another live host');
          return get(continuationId)!;
        }
        db.prepare(
          `INSERT INTO automation_approval_continuations (
             continuation_id,automation_id,revision_id,occurrence_id,job_id,attempt_id,generation,
             fence_token_digest,script_spec_json,script_spec_digest,step_index,tool_call_id,effect_id,
             action_digest,policy_snapshot_id,state,claim_owner,claim_token,claim_expires_at,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'claimed',?,?,?,?,?)`,
        ).run(
          continuationId,
          job.automationId,
          job.automationRevisionId,
          job.automationOccurrenceId,
          command.handle.jobId,
          command.handle.attemptId,
          command.handle.generation,
          digest(command.handle.fenceToken),
          specJson,
          specDigest,
          command.stepIndex,
          command.toolCallId,
          command.effectId,
          command.normalized.actionDigest,
          command.normalized.policySnapshot.policySnapshotId,
          command.ownerId,
          claimToken,
          claimExpiresAt,
          now,
          now,
        );
        return get(continuationId)!;
      }).immediate();
    },
    bindApproval(command) {
      const now = command.now ?? Date.now();
      const changed = db.prepare(
        `UPDATE automation_approval_continuations
            SET approval_id = ?,state = CASE WHEN ? = 'approved' THEN 'approved' ELSE 'waiting_approval' END,
                updated_at = ?
          WHERE continuation_id = ? AND claim_owner = ? AND claim_token = ?
            AND job_id = ? AND attempt_id = ? AND generation = ?
            AND tool_call_id = ? AND action_digest = ? AND policy_snapshot_id = ?`,
      ).run(
        command.approval.approvalId,
        command.approval.state,
        now,
        command.continuationId,
        command.ownerId,
        command.claimToken,
        command.approval.jobId,
        command.approval.attemptId,
        command.approval.generation,
        command.approval.toolCallId,
        command.approval.actionDigest,
        command.approval.policySnapshotId,
      );
      if (changed.changes !== 1) throw new Error('Automation continuation approval binding was rejected');
      return get(command.continuationId)!;
    },
    settle(command) {
      const now = command.now ?? Date.now();
      const current = get(command.continuationId);
      if (!current || current.claimOwner !== command.ownerId || current.claimToken !== command.claimToken) {
        throw new Error('Automation continuation settlement has stale claim authority');
      }
      const approval = current.approvalId
        ? db.prepare('SELECT state FROM approvals WHERE approval_id = ?').get(current.approvalId) as { state: string } | undefined
        : undefined;
      const toolCall = db.prepare(
        `SELECT tc.state,se.effect_state
           FROM tool_calls tc
           LEFT JOIN side_effect_ledger se ON se.key = tc.side_effect_id
          WHERE tc.tool_call_id = ?`,
      ).get(current.toolCallId) as { state: string; effect_state: string | null } | undefined;
      const ambiguousEffect = toolCall?.state === 'started' || toolCall?.state === 'unknown'
        || ['started', 'partial', 'unknown'].includes(toolCall?.effect_state ?? '');
      const state: AutomationApprovalContinuationState = approval?.state === 'denied'
        ? 'denied'
        : approval?.state === 'cancelled'
          ? 'cancelled'
          : ['expired', 'invalidated'].includes(approval?.state ?? '')
            ? 'cancelled'
            : ambiguousEffect ? 'unknown' : 'consumed';
      const changed = db.prepare(
        `UPDATE automation_approval_continuations
            SET state = ?,claim_owner = NULL,claim_token = NULL,claim_expires_at = NULL,
                terminal_at = CASE WHEN ? IN ('consumed','denied','cancelled') THEN ? ELSE NULL END,
                updated_at = ?
          WHERE continuation_id = ? AND claim_owner = ? AND claim_token = ?`,
      ).run(state, state, now, now, command.continuationId, command.ownerId, command.claimToken);
      if (changed.changes !== 1) throw new Error('Automation continuation changed before settlement');
      return get(command.continuationId)!;
    },
    hasPendingForAttempt(jobId, attemptId, generation) {
      return db.prepare(
        `SELECT 1 FROM automation_approval_continuations
          WHERE job_id = ? AND attempt_id = ? AND generation = ?
            AND state IN ('preparing','waiting_approval','claimed','approved','unknown') LIMIT 1`,
      ).get(jobId, attemptId, generation) !== undefined;
    },
    releaseForHost(jobId, attemptId, generation, ownerId, now = Date.now()) {
      return db.prepare(
        `UPDATE automation_approval_continuations
            SET state = CASE WHEN approval_id IS NULL THEN 'preparing' ELSE 'waiting_approval' END,
                claim_owner = NULL,claim_token = NULL,claim_expires_at = NULL,updated_at = ?
          WHERE job_id = ? AND attempt_id = ? AND generation = ? AND claim_owner = ?
            AND state IN ('preparing','waiting_approval','claimed','approved','unknown')`,
      ).run(now, jobId, attemptId, generation, ownerId).changes;
    },
    cancelForJob(jobId, _reason, now = Date.now()) {
      return db.prepare(
        `UPDATE automation_approval_continuations
            SET state = 'cancelled',claim_owner = NULL,claim_token = NULL,claim_expires_at = NULL,
                terminal_at = COALESCE(terminal_at,?),updated_at = ?
          WHERE job_id = ? AND state IN ('preparing','waiting_approval','claimed','approved','unknown')`,
      ).run(now, now, jobId).changes;
    },
  };
}

export interface AutomationApprovalContinuationRuntime {
  prepareApproval(input: {
    toolCallId: string;
    effectId: string | null;
    normalized: NormalizedAction;
  }): AutomationApprovalContinuationRecord;
  bindApproval(approval: ApprovalRecord): void;
  settle(result: ToolCallResult): void;
}

export function createAutomationApprovalContinuationRuntime(input: {
  authority: AutomationApprovalContinuationAuthority;
  handle: AutomationContinuationHandle;
  ownerId: string;
  scriptSpec: ScriptSpec;
  stepIndex: number;
}): AutomationApprovalContinuationRuntime {
  let current: AutomationApprovalContinuationRecord | null = null;
  return {
    prepareApproval(command) {
      current = input.authority.prepare({
        handle: input.handle,
        ownerId: input.ownerId,
        scriptSpec: input.scriptSpec,
        stepIndex: input.stepIndex,
        ...command,
      });
      return current;
    },
    bindApproval(approval) {
      if (!current?.claimToken) throw new Error('Automation continuation was not prepared before approval');
      current = input.authority.bindApproval({
        continuationId: current.continuationId,
        claimToken: current.claimToken,
        ownerId: input.ownerId,
        approval,
      });
    },
    settle(result) {
      if (!current?.claimToken) return;
      current = input.authority.settle({
        continuationId: current.continuationId,
        claimToken: current.claimToken,
        ownerId: input.ownerId,
        result,
      });
    },
  };
}
