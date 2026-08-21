/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Db } from '../daemon/db/connection';
import { isWithin, realpathWithFallback } from '../sandboxFs';
import { resolveWorkspace } from '../codebase/workspaceResolver';
import type { ExternalCodingWorkspaceLeaseRecord } from './types';

const execFileAsync = promisify(execFile);

export class ExternalCodingWorkspaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalCodingWorkspaceError';
  }
}

interface ChildAuthority {
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  childFenceToken: string;
}

interface WorkspaceAuthorityDeps {
  db: Db;
  validateActiveFence(input: {
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
    now?: number;
  }): boolean;
  validateLostAuthority(input: {
    jobId: string;
    attemptId: string;
    generation: number;
  }): boolean;
  validateCancelledAuthority(input: {
    jobId: string;
    attemptId: string;
    generation: number;
    fenceToken: string;
  }): boolean;
  validateDiscardAuthority(input: {
    jobId: string;
    attemptId: string;
    generation: number;
  }): boolean;
  appendEvent(input: ChildAuthority & {
    type: string;
    payload: Record<string, unknown>;
    producer: string;
    idempotencyKey: string;
    now?: number;
  }): void;
}

export interface ExternalCodingWorkspaceAuthority {
  allocate(input: ChildAuthority & {
    codingSessionId: string;
    sourcePath: string;
    worktreeParent?: string;
    protectedPaths: readonly string[];
    now?: number;
  }): Promise<ExternalCodingWorkspaceLeaseRecord>;
  get(workspaceLeaseId: string): ExternalCodingWorkspaceLeaseRecord | null;
  getForSession(codingSessionId: string): ExternalCodingWorkspaceLeaseRecord | null;
  listActive(): ExternalCodingWorkspaceLeaseRecord[];
  markState(input: ChildAuthority & {
    workspaceLeaseId: string;
    codingSessionId: string;
    state: 'review_pending' | 'promotion_pending' | 'reconciliation_required';
    now?: number;
  }): ExternalCodingWorkspaceLeaseRecord;
  requireReconciliationAfterLeaseLoss(input: {
    childJobId: string;
    childAttemptId: string;
    childGeneration: number;
    codingSessionId: string;
    workspaceLeaseId: string;
    now?: number;
  }): ExternalCodingWorkspaceLeaseRecord;
  release(input: ChildAuthority & {
    workspaceLeaseId: string;
    codingSessionId: string;
    disposition: 'discard' | 'promoted';
    now?: number;
  }): Promise<ExternalCodingWorkspaceLeaseRecord>;
  releaseCancelled(input: ChildAuthority & {
    workspaceLeaseId: string;
    codingSessionId: string;
    now?: number;
  }): Promise<ExternalCodingWorkspaceLeaseRecord>;
  releaseReconciled(input: {
    childJobId: string;
    childAttemptId: string;
    childGeneration: number;
    workspaceLeaseId: string;
    codingSessionId: string;
    now?: number;
  }): Promise<ExternalCodingWorkspaceLeaseRecord>;
  releaseReviewed(input: {
    promotionJobId: string;
    promotionAttemptId: string;
    promotionGeneration: number;
    promotionFenceToken: string;
    workspaceLeaseId: string;
    codingSessionId: string;
    promotionId: string;
    disposition: 'discard' | 'promoted';
    now?: number;
  }): Promise<ExternalCodingWorkspaceLeaseRecord>;
}

interface LeaseRow {
  workspace_lease_id: string;
  coding_session_id: string;
  repository_identity: string;
  source_workspace_id: string;
  source_path: string;
  worktree_path: string;
  base_head: string;
  base_branch: string | null;
  state: ExternalCodingWorkspaceLeaseRecord['state'];
  child_job_id: string;
  child_attempt_id: string;
  generation: number;
  protected_paths_json: string;
  created_at: number;
  last_validated_at: number;
  released_at: number | null;
}

function mapLease(row: LeaseRow): ExternalCodingWorkspaceLeaseRecord {
  return {
    workspaceLeaseId: row.workspace_lease_id,
    codingSessionId: row.coding_session_id,
    repositoryIdentity: row.repository_identity,
    sourceWorkspaceId: row.source_workspace_id,
    sourcePath: row.source_path,
    worktreePath: row.worktree_path,
    baseHead: row.base_head,
    baseBranch: row.base_branch,
    state: row.state,
    childJobId: row.child_job_id,
    childAttemptId: row.child_attempt_id,
    generation: row.generation,
    protectedPaths: JSON.parse(row.protected_paths_json) as string[],
    createdAt: row.created_at,
    lastValidatedAt: row.last_validated_at,
    releasedAt: row.released_at,
  };
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\\/g, '/').replace(/^\.\//, '')))].sort();
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    LC_ALL: 'C',
  };
  const result = await execFileAsync('git', ['-c', 'color.ui=false', '-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    env: environment,
  });
  return result.stdout.trim();
}

function repositoryIdentity(commonDirectory: string): string {
  const portable = realpathWithFallback(commonDirectory).replace(/\\/g, '/');
  const normalized = process.platform === 'win32' ? portable.toLocaleLowerCase('en-US') : portable;
  return `repository_${createHash('sha256').update(`${process.platform}\0${normalized}`).digest('hex')}`;
}

function assertId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/.test(value)) {
    throw new ExternalCodingWorkspaceError('INVALID_IDENTITY', `${label} is invalid`);
  }
}

function validateFence(deps: WorkspaceAuthorityDeps, input: ChildAuthority, now?: number): void {
  if (!deps.validateActiveFence({
    jobId: input.childJobId,
    attemptId: input.childAttemptId,
    generation: input.childGeneration,
    fenceToken: input.childFenceToken,
    now,
  })) {
    throw new ExternalCodingWorkspaceError('STALE_WORKSPACE_AUTHORITY', 'External coding workspace authority is stale');
  }
}

async function exists(value: string): Promise<boolean> {
  try { await stat(value); return true; } catch { return false; }
}

export function createExternalCodingWorkspaceAuthority(
  deps: WorkspaceAuthorityDeps,
): ExternalCodingWorkspaceAuthority {
  const get = (workspaceLeaseId: string): ExternalCodingWorkspaceLeaseRecord | null => {
    const row = deps.db.prepare('SELECT * FROM external_coding_workspace_leases WHERE workspace_lease_id=?')
      .get(workspaceLeaseId) as LeaseRow | undefined;
    return row ? mapLease(row) : null;
  };
  const forSession = (codingSessionId: string): ExternalCodingWorkspaceLeaseRecord | null => {
    const row = deps.db.prepare('SELECT * FROM external_coding_workspace_leases WHERE coding_session_id=?')
      .get(codingSessionId) as LeaseRow | undefined;
    return row ? mapLease(row) : null;
  };
  const removeLease = async (
    current: ExternalCodingWorkspaceLeaseRecord,
    codingSessionId: string,
    now: number,
  ): Promise<ExternalCodingWorkspaceLeaseRecord> => {
    try {
      await git(current.sourcePath, ['worktree', 'remove', '--force', current.worktreePath]);
    } catch (error) {
      if (await exists(current.worktreePath)) throw error;
    }
    deps.db.transaction(() => {
      deps.db.prepare(
        `UPDATE external_coding_workspace_leases
            SET state='released', released_at=?, last_validated_at=?
          WHERE workspace_lease_id=?`,
      ).run(now, now, current.workspaceLeaseId);
      deps.db.prepare(
        `DELETE FROM external_coding_repository_locks
          WHERE workspace_lease_id=? AND coding_session_id=?`,
      ).run(current.workspaceLeaseId, codingSessionId);
    }).immediate();
    return get(current.workspaceLeaseId)!;
  };

  return {
    async allocate(input) {
      validateFence(deps, input, input.now);
      assertId(input.codingSessionId, 'Coding session identity');
      const prior = forSession(input.codingSessionId);
      if (prior) return prior;

      const descriptor = await resolveWorkspace(input.sourcePath);
      if (!descriptor.exists || descriptor.vcsKind !== 'git' || !descriptor.repositoryRoot || !descriptor.gitCommonDirectory) {
        throw new ExternalCodingWorkspaceError('GIT_REPOSITORY_REQUIRED', 'External coding requires a resolvable Git repository');
      }
      const sourceRoot = await realpath(descriptor.repositoryRoot);
      const repoIdentity = repositoryIdentity(descriptor.gitCommonDirectory);
      const baseHead = await git(sourceRoot, ['rev-parse', '--verify', 'HEAD']);
      const baseBranch = await git(sourceRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
      if (!/^[a-f0-9]{40,64}$/i.test(baseHead)) {
        throw new ExternalCodingWorkspaceError('INVALID_BASE_HEAD', 'Unable to resolve an immutable Git base');
      }

      const now = input.now ?? Date.now();
      const workspaceLeaseId = `coding_workspace_${randomBytes(16).toString('hex')}`;
      const parent = path.resolve(input.worktreeParent ?? path.join(os.tmpdir(), 'aiden-coding-worktrees'));
      await mkdir(parent, { recursive: true });
      const canonicalParent = realpathWithFallback(parent);
      const worktreePath = path.join(canonicalParent, workspaceLeaseId);
      if (!isWithin(worktreePath, canonicalParent) || await exists(worktreePath)) {
        throw new ExternalCodingWorkspaceError('INVALID_WORKTREE_PATH', 'Worktree path is not a new contained directory');
      }

      try {
        deps.db.transaction(() => {
          deps.db.prepare(
            `INSERT INTO external_coding_workspace_leases
               (workspace_lease_id, coding_session_id, repository_identity, source_workspace_id,
                source_path, worktree_path, base_head, base_branch, state, child_job_id,
                child_attempt_id, generation, protected_paths_json, created_at, last_validated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'allocating', ?, ?, ?, ?, ?, ?)`,
          ).run(
            workspaceLeaseId, input.codingSessionId, repoIdentity, descriptor.id,
            sourceRoot, worktreePath, baseHead, baseBranch || null,
            input.childJobId, input.childAttemptId, input.childGeneration,
            JSON.stringify(uniquePaths(input.protectedPaths)), now, now,
          );
          const locked = deps.db.prepare(
            `INSERT INTO external_coding_repository_locks
               (repository_identity, workspace_lease_id, coding_session_id, state, acquired_at, updated_at)
             VALUES (?, ?, ?, 'held', ?, ?)`,
          ).run(repoIdentity, workspaceLeaseId, input.codingSessionId, now, now);
          if (locked.changes !== 1) throw new Error('Repository lock was not acquired');
        }).immediate();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/unique|constraint|repository lock/i.test(detail)) {
          throw new ExternalCodingWorkspaceError('REPOSITORY_MUTATION_LOCKED', 'Another mutable coding session owns this repository');
        }
        throw error;
      }

      try {
        await git(sourceRoot, ['worktree', 'add', '--detach', worktreePath, baseHead]);
        const allocated = await resolveWorkspace(worktreePath);
        if (allocated.vcsKind !== 'git'
          || repositoryIdentity(allocated.gitCommonDirectory ?? '') !== repoIdentity
          || await git(worktreePath, ['rev-parse', '--verify', 'HEAD']) !== baseHead) {
          throw new ExternalCodingWorkspaceError('WORKTREE_VERIFICATION_FAILED', 'Allocated worktree does not match the source repository and base');
        }
        deps.db.prepare(
          `UPDATE external_coding_workspace_leases
              SET state='ready', last_validated_at=?
            WHERE workspace_lease_id=? AND state='allocating'`,
        ).run(Date.now(), workspaceLeaseId);
        deps.appendEvent({
          ...input,
          type: 'coding.workspace_allocated',
          payload: { workspaceLeaseId, repositoryIdentity: repoIdentity, baseHead, sourceWorkspaceId: descriptor.id },
          producer: 'external-coding-workspace',
          idempotencyKey: `coding-workspace-allocated:${workspaceLeaseId}`,
        });
        return get(workspaceLeaseId)!;
      } catch (error) {
        try { await git(sourceRoot, ['worktree', 'remove', '--force', worktreePath]); } catch { await rm(worktreePath, { recursive: true, force: true }); }
        deps.db.transaction(() => {
          deps.db.prepare(
            `UPDATE external_coding_workspace_leases SET state='failed', last_validated_at=?
              WHERE workspace_lease_id=?`,
          ).run(Date.now(), workspaceLeaseId);
          deps.db.prepare('DELETE FROM external_coding_repository_locks WHERE workspace_lease_id=?').run(workspaceLeaseId);
        }).immediate();
        throw error;
      }
    },

    get,
    getForSession: forSession,
    listActive() {
      return (deps.db.prepare(
        `SELECT * FROM external_coding_workspace_leases
          WHERE state NOT IN ('released','failed') ORDER BY created_at, workspace_lease_id`,
      ).all() as LeaseRow[]).map(mapLease);
    },
    markState(input) {
      validateFence(deps, input, input.now);
      const current = get(input.workspaceLeaseId);
      if (!current || current.codingSessionId !== input.codingSessionId) {
        throw new ExternalCodingWorkspaceError('WORKSPACE_LEASE_NOT_FOUND', 'Coding workspace lease was not found');
      }
      if (current.state === 'released' || current.state === 'failed') {
        throw new ExternalCodingWorkspaceError('WORKSPACE_LEASE_TERMINAL', 'Coding workspace lease is already terminal');
      }
      deps.db.prepare(
        `UPDATE external_coding_workspace_leases SET state=?, last_validated_at=?
          WHERE workspace_lease_id=?`,
      ).run(input.state, input.now ?? Date.now(), input.workspaceLeaseId);
      return get(input.workspaceLeaseId)!;
    },
    requireReconciliationAfterLeaseLoss(input) {
      if (!deps.validateLostAuthority({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
      })) {
        throw new ExternalCodingWorkspaceError('RECOVERY_AUTHORITY_MISMATCH', 'Lost Attempt does not own this coding workspace');
      }
      const current = get(input.workspaceLeaseId);
      if (!current || current.codingSessionId !== input.codingSessionId
        || current.childJobId !== input.childJobId
        || current.childAttemptId !== input.childAttemptId
        || current.generation !== input.childGeneration) {
        throw new ExternalCodingWorkspaceError('WORKSPACE_LEASE_NOT_FOUND', 'Lost coding workspace lineage does not match');
      }
      if (current.state === 'released' || current.state === 'failed') return current;
      deps.db.prepare(
        `UPDATE external_coding_workspace_leases
            SET state='reconciliation_required',last_validated_at=?
          WHERE workspace_lease_id=? AND state NOT IN ('released','failed')`,
      ).run(input.now ?? Date.now(), input.workspaceLeaseId);
      return get(input.workspaceLeaseId)!;
    },
    async release(input) {
      validateFence(deps, input, input.now);
      const current = get(input.workspaceLeaseId);
      if (!current || current.codingSessionId !== input.codingSessionId
        || current.childJobId !== input.childJobId
        || current.childAttemptId !== input.childAttemptId
        || current.generation !== input.childGeneration) {
        throw new ExternalCodingWorkspaceError('WORKSPACE_LEASE_NOT_FOUND', 'Coding workspace lease lineage does not match');
      }
      if (current.state === 'reconciliation_required') {
        throw new ExternalCodingWorkspaceError('RECONCILIATION_REQUIRED', 'Unknown workspace outcome must be reconciled before cleanup');
      }
      if (current.state === 'released') return current;
      const now = input.now ?? Date.now();
      await removeLease(current, input.codingSessionId, now);
      deps.appendEvent({
        ...input,
        type: 'coding.workspace_released',
        payload: { workspaceLeaseId: input.workspaceLeaseId, disposition: input.disposition },
        producer: 'external-coding-workspace',
        idempotencyKey: `coding-workspace-released:${input.workspaceLeaseId}:${input.disposition}`,
      });
      return get(input.workspaceLeaseId)!;
    },
    async releaseCancelled(input) {
      if (!deps.validateCancelledAuthority({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
        fenceToken: input.childFenceToken,
      })) {
        throw new ExternalCodingWorkspaceError(
          'CANCELLED_AUTHORITY_MISMATCH',
          'Cancelled Attempt does not own this coding workspace',
        );
      }
      const current = get(input.workspaceLeaseId);
      if (!current || current.codingSessionId !== input.codingSessionId
        || current.childJobId !== input.childJobId
        || current.childAttemptId !== input.childAttemptId
        || current.generation !== input.childGeneration) {
        throw new ExternalCodingWorkspaceError('WORKSPACE_LEASE_NOT_FOUND', 'Cancelled coding workspace lineage does not match');
      }
      if (current.state === 'released') return current;
      const session = deps.db.prepare(
        `SELECT state,cancellation_requested_at FROM external_coding_sessions
          WHERE coding_session_id=? AND child_job_id=? AND child_attempt_id=? AND child_generation=?`,
      ).get(
        input.codingSessionId, input.childJobId, input.childAttemptId, input.childGeneration,
      ) as { state: string; cancellation_requested_at: number | null } | undefined;
      if (!session || session.state !== 'terminal' || session.cancellation_requested_at === null) {
        throw new ExternalCodingWorkspaceError(
          'CANCELLATION_NOT_SETTLED',
          'Coding workspace cleanup requires a durably settled cancellation',
        );
      }
      const now = input.now ?? Date.now();
      await removeLease(current, input.codingSessionId, now);
      deps.appendEvent({
        ...input,
        type: 'coding.workspace_released',
        payload: { workspaceLeaseId: input.workspaceLeaseId, disposition: 'discard', cancellation: true },
        producer: 'external-coding-workspace',
        idempotencyKey: `coding-workspace-cancelled:${input.workspaceLeaseId}`,
        now,
      });
      return get(input.workspaceLeaseId)!;
    },
    async releaseReconciled(input) {
      if (!deps.validateDiscardAuthority({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
      })) {
        throw new ExternalCodingWorkspaceError(
          'RECONCILIATION_AUTHORITY_MISMATCH',
          'Unknown Attempt does not own this coding workspace reconciliation',
        );
      }
      const current = get(input.workspaceLeaseId);
      if (!current || current.codingSessionId !== input.codingSessionId
        || current.childJobId !== input.childJobId
        || current.childAttemptId !== input.childAttemptId
        || current.generation !== input.childGeneration) {
        throw new ExternalCodingWorkspaceError(
          'WORKSPACE_LEASE_NOT_FOUND',
          'Unknown coding workspace lineage does not match',
        );
      }
      if (current.state === 'released') return current;
      if (current.state !== 'reconciliation_required') {
        throw new ExternalCodingWorkspaceError(
          'RECONCILIATION_NOT_REQUIRED',
          'Only a reconciliation-required coding workspace may be discarded this way',
        );
      }
      const session = deps.db.prepare(
        `SELECT state,reconciliation_state FROM external_coding_sessions
          WHERE coding_session_id=? AND child_job_id=? AND child_attempt_id=? AND child_generation=?`,
      ).get(
        input.codingSessionId, input.childJobId, input.childAttemptId, input.childGeneration,
      ) as { state: string; reconciliation_state: string } | undefined;
      if (!session || !['unknown', 'reconciliation_required'].includes(session.state)
        || !['required', 'blocked_unknown'].includes(session.reconciliation_state)) {
        throw new ExternalCodingWorkspaceError(
          'RECONCILIATION_STATE_MISMATCH',
          'Coding session is not awaiting an explicit unknown-outcome decision',
        );
      }
      const process = deps.db.prepare(
        `SELECT state,tree_dead_verified FROM external_coding_processes
          WHERE coding_session_id=? ORDER BY created_at DESC,process_record_id DESC LIMIT 1`,
      ).get(input.codingSessionId) as { state: string; tree_dead_verified: number } | undefined;
      if (process && (!['exited', 'unknown'].includes(process.state) || process.tree_dead_verified !== 1)) {
        throw new ExternalCodingWorkspaceError(
          'RECONCILIATION_PROCESS_ACTIVE',
          'Coding process termination must be verified before discarding its isolated workspace',
        );
      }
      const promotion = deps.db.prepare(
        `SELECT state FROM external_coding_promotion_plans
          WHERE coding_session_id=? ORDER BY created_at DESC,promotion_id DESC LIMIT 1`,
      ).get(input.codingSessionId) as { state: string } | undefined;
      if (promotion && !['applied', 'rejected'].includes(promotion.state)) {
        throw new ExternalCodingWorkspaceError(
          'RECONCILIATION_PROMOTION_ACTIVE',
          'An unresolved coding promotion must be settled before discarding its workspace',
        );
      }
      const now = input.now ?? Date.now();
      await removeLease(current, input.codingSessionId, now);
      deps.appendEvent({
        ...input,
        childFenceToken: '',
        type: 'coding.workspace_released',
        payload: { workspaceLeaseId: input.workspaceLeaseId, disposition: 'discard', reconciliation: true },
        producer: 'external-coding-reconciliation',
        idempotencyKey: `coding-workspace-reconciled:${input.workspaceLeaseId}:discard`,
        now,
      });
      return get(input.workspaceLeaseId)!;
    },
    async releaseReviewed(input) {
      validateFence(deps, {
        childJobId: input.promotionJobId,
        childAttemptId: input.promotionAttemptId,
        childGeneration: input.promotionGeneration,
        childFenceToken: input.promotionFenceToken,
      }, input.now);
      const current = get(input.workspaceLeaseId);
      if (!current || current.codingSessionId !== input.codingSessionId) {
        throw new ExternalCodingWorkspaceError('WORKSPACE_LEASE_NOT_FOUND', 'Reviewed coding workspace lease was not found');
      }
      if (current.state === 'released') return current;
      if (current.state === 'reconciliation_required') {
        throw new ExternalCodingWorkspaceError('RECONCILIATION_REQUIRED', 'Unknown workspace outcome must be reconciled before review');
      }
      const expectedState = input.disposition === 'promoted' ? 'applied' : 'rejected';
      const review = deps.db.prepare(
        `SELECT state FROM external_coding_promotion_plans
          WHERE promotion_id=? AND coding_session_id=? AND workspace_lease_id=?
            AND promotion_job_id=? AND promotion_attempt_id=? AND promotion_generation=?`,
      ).get(
        input.promotionId, input.codingSessionId, input.workspaceLeaseId,
        input.promotionJobId, input.promotionAttemptId, input.promotionGeneration,
      ) as { state: string } | undefined;
      if (!review || review.state !== expectedState) {
        throw new ExternalCodingWorkspaceError('REVIEW_AUTHORITY_MISMATCH', 'Workspace cleanup requires an exact terminal promotion decision');
      }
      const now = input.now ?? Date.now();
      await removeLease(current, input.codingSessionId, now);
      deps.appendEvent({
        childJobId: input.promotionJobId,
        childAttemptId: input.promotionAttemptId,
        childGeneration: input.promotionGeneration,
        childFenceToken: input.promotionFenceToken,
        type: 'coding.workspace_released',
        payload: { workspaceLeaseId: input.workspaceLeaseId, disposition: input.disposition, promotionId: input.promotionId },
        producer: 'external-coding-promotion',
        idempotencyKey: `coding-workspace-reviewed:${input.promotionId}:${input.disposition}`,
        now,
      });
      return get(input.workspaceLeaseId)!;
    },
  };
}
