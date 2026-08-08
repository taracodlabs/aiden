/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Db } from './daemon/db/connection';
import type { JobEngine } from './daemon/jobEngine';

export type ContinuityCheckpointValidity = 'current' | 'superseded' | 'invalid';

export interface ContinuityCheckpointRecord {
  checkpointId: string;
  schemaVersion: 1;
  workspaceId: string | null;
  rootJobId: string;
  jobId: string;
  attemptId: string;
  attemptGeneration: number;
  sessionId: string;
  repositorySnapshotId: string | null;
  repositoryFingerprint: string | null;
  eventCursor: number;
  proofIds: string[];
  evidenceIds: string[];
  pendingWaitIds: string[];
  pendingApprovalIds: string[];
  durableInputCursor: number;
  contextRecipeVersion: 1;
  contextRecipeDigest: string;
  decisions: string[];
  blockers: string[];
  proposedNext: string[];
  environmentFingerprint: string | null;
  reason: string;
  validity: ContinuityCheckpointValidity;
  idempotencyNamespace: string;
  idempotencyKey: string;
  supersedesCheckpointId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CaptureContinuityCheckpoint {
  jobId: string;
  attemptId: string;
  attemptGeneration: number;
  reason: string;
  idempotencyNamespace: string;
  idempotencyKey: string;
  repositoryFingerprint?: string | null;
  environmentFingerprint?: string | null;
  durableInputCursor?: number;
  pendingWaitIds?: readonly string[];
  pendingApprovalIds?: readonly string[];
  decisions?: readonly string[];
  blockers?: readonly string[];
  proposedNext?: readonly string[];
  now?: number;
}

export interface ContinuityCheckpointAuthority {
  capture(command: CaptureContinuityCheckpoint): ContinuityCheckpointRecord;
  get(checkpointId: string): ContinuityCheckpointRecord | null;
  getLatest(jobId: string): ContinuityCheckpointRecord | null;
  assess(checkpointId: string, current: {
    repositoryFingerprint?: string | null;
    environmentFingerprint?: string | null;
  }): {
    checkpoint: ContinuityCheckpointRecord;
    assumptions: 'current' | 'stale';
    repositoryDrift: boolean;
    environmentDrift: boolean;
  };
  listForWorkspace(workspaceId: string | null, limit?: number): ContinuityCheckpointRecord[];
  resolveForWorkspace(workspaceId: string | null): {
    decision: 'none' | 'selected' | 'choice_required';
    checkpoint: ContinuityCheckpointRecord | null;
    candidates: ContinuityCheckpointRecord[];
  };
  invalidate(checkpointId: string, now?: number): ContinuityCheckpointRecord | null;
}

type Row = {
  checkpoint_sequence: number;
  checkpoint_id: string; schema_version: number; workspace_id: string | null;
  root_job_id: string; job_id: string; attempt_id: string; attempt_generation: number;
  session_id: string; repository_snapshot_id: string | null; repository_fingerprint: string | null;
  event_cursor: number; proof_ids_json: string; evidence_ids_json: string;
  pending_wait_ids_json: string; pending_approval_ids_json: string; durable_input_cursor: number;
  context_recipe_version: number; context_recipe_digest: string; decisions_json: string;
  blockers_json: string; proposed_next_json: string; environment_fingerprint: string | null;
  reason: string; validity: ContinuityCheckpointValidity; idempotency_namespace: string;
  idempotency_key: string; supersedes_checkpoint_id: string | null; created_at: number; updated_at: number;
};

const id = (): string => `checkpoint_${randomBytes(12).toString('hex')}`;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function fingerprintContinuityEnvironment(): string {
  return digest({
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
    executable: process.execPath,
    workingDirectory: process.cwd(),
  });
}
const unique = (values: readonly string[] | undefined): string[] => [...new Set((values ?? []).filter((v) => typeof v === 'string' && v.length > 0))];
const SECRET = /(?:bearer\s+[a-z0-9._-]{12,}|(?:sk|gsk|ghp)_[a-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})/gi;
const boundedText = (value: string, max = 240): string => [...value.replace(SECRET, '[redacted]').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')]
  .slice(0, max).join('');
const boundedList = (values: readonly string[] | undefined): string[] => unique(values)
  .slice(0, 100)
  .map((value) => boundedText(value));

function parseArray(value: string, field: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`Continuity checkpoint is corrupt: ${field}`); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Continuity checkpoint is corrupt: ${field}`);
  }
  return parsed;
}

function mapRow(row: Row): ContinuityCheckpointRecord {
  if (row.schema_version !== 1 || row.context_recipe_version !== 1) {
    throw new Error('Continuity checkpoint version is unsupported');
  }
  return {
    checkpointId: row.checkpoint_id, schemaVersion: 1, workspaceId: row.workspace_id,
    rootJobId: row.root_job_id, jobId: row.job_id, attemptId: row.attempt_id,
    attemptGeneration: row.attempt_generation, sessionId: row.session_id,
    repositorySnapshotId: row.repository_snapshot_id, repositoryFingerprint: row.repository_fingerprint,
    eventCursor: row.event_cursor, proofIds: parseArray(row.proof_ids_json, 'proofIds'),
    evidenceIds: parseArray(row.evidence_ids_json, 'evidenceIds'),
    pendingWaitIds: parseArray(row.pending_wait_ids_json, 'pendingWaitIds'),
    pendingApprovalIds: parseArray(row.pending_approval_ids_json, 'pendingApprovalIds'),
    durableInputCursor: row.durable_input_cursor, contextRecipeVersion: 1,
    contextRecipeDigest: row.context_recipe_digest, decisions: parseArray(row.decisions_json, 'decisions'),
    blockers: parseArray(row.blockers_json, 'blockers'), proposedNext: parseArray(row.proposed_next_json, 'proposedNext'),
    environmentFingerprint: row.environment_fingerprint, reason: row.reason, validity: row.validity,
    idempotencyNamespace: row.idempotency_namespace, idempotencyKey: row.idempotency_key,
    supersedesCheckpointId: row.supersedes_checkpoint_id, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createContinuityCheckpointAuthority(options: {
  db: Db;
  engine: JobEngine;
}): ContinuityCheckpointAuthority {
  const get = (checkpointId: string): ContinuityCheckpointRecord | null => {
    const row = options.db.prepare('SELECT * FROM continuity_checkpoints WHERE checkpoint_id = ?').get(checkpointId) as Row | undefined;
    return row ? mapRow(row) : null;
  };
  const getLatest = (jobId: string): ContinuityCheckpointRecord | null => {
    const row = options.db.prepare(
      `SELECT * FROM continuity_checkpoints WHERE job_id = ? AND validity = 'current'
       ORDER BY updated_at DESC, checkpoint_sequence DESC LIMIT 1`,
    ).get(jobId) as Row | undefined;
    return row ? mapRow(row) : null;
  };
  const captureTx = options.db.transaction((command: CaptureContinuityCheckpoint): ContinuityCheckpointRecord => {
    const job = options.engine.getJob(command.jobId);
    const attempt = options.engine.getAttempt(command.attemptId);
    if (!job || !attempt || attempt.jobId !== job.id || attempt.generation !== command.attemptGeneration) {
      throw new Error('Continuity checkpoint authority does not match one durable Job and Attempt');
    }
    if (job.activeAttemptId !== attempt.id && job.terminalAt === null) {
      throw new Error('Continuity checkpoint cannot be written by a stale Attempt');
    }
    const storedIdempotencyKey = digest(command.idempotencyKey);
    const existing = options.db.prepare(
      `SELECT * FROM continuity_checkpoints WHERE job_id=? AND attempt_id=? AND attempt_generation=?
       AND idempotency_namespace=? AND idempotency_key=?`,
    ).get(
      job.id, attempt.id, attempt.generation, boundedText(command.idempotencyNamespace, 120), storedIdempotencyKey,
    ) as Row | undefined;
    if (existing) return mapRow(existing);

    const previous = getLatest(job.id);
    const now = command.now ?? Date.now();
    const evidenceIds = options.engine.proof.listEvidence(job.id).map((item) => item.evidenceId);
    const verdict = options.engine.proof.getVerdict(job.id);
    const proofIds = verdict ? [`proof:${verdict.jobId}:${verdict.attemptId}:${verdict.generation}`] : [];
    const eventCursor = Math.max(0, ...options.engine.listEvents(job.id, 0).map((item) => item.jobSequence));
    const decisions = boundedList(command.decisions);
    const blockers = boundedList(command.blockers);
    const proposedNext = boundedList(command.proposedNext);
    const repositoryFingerprint = command.repositoryFingerprint !== undefined
      ? command.repositoryFingerprint
      : job.repositorySnapshotId
        ? options.engine.repository.getSnapshot(job.repositorySnapshotId)?.stateDigest ?? null
        : null;
    const environmentFingerprint = command.environmentFingerprint !== undefined
      ? command.environmentFingerprint
      : fingerprintContinuityEnvironment();
    const recipeDigest = digest({
      jobId: job.id, attemptId: attempt.id, generation: attempt.generation,
      repositorySnapshotId: job.repositorySnapshotId ?? null,
      eventCursor, proofIds, evidenceIds, decisions, blockers, proposedNext,
    });
    const checkpointId = id();
    if (previous) {
      options.db.prepare("UPDATE continuity_checkpoints SET validity='superseded', updated_at=? WHERE checkpoint_id=? AND validity='current'")
        .run(now, previous.checkpointId);
    }
    options.db.prepare(
      `INSERT INTO continuity_checkpoints (
        checkpoint_id, schema_version, workspace_id, root_job_id, job_id, attempt_id, attempt_generation,
        session_id, repository_snapshot_id, repository_fingerprint, event_cursor, proof_ids_json,
        evidence_ids_json, pending_wait_ids_json, pending_approval_ids_json, durable_input_cursor,
        context_recipe_version, context_recipe_digest, decisions_json, blockers_json, proposed_next_json,
        environment_fingerprint, reason, validity, idempotency_namespace, idempotency_key,
        supersedes_checkpoint_id, created_at, updated_at
      ) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,'current',?,?,?,?,?)`,
    ).run(
      checkpointId, job.workspaceId ?? null, job.rootJobId, job.id, attempt.id, attempt.generation,
      job.sessionId, job.repositorySnapshotId ?? null, repositoryFingerprint, eventCursor,
      JSON.stringify(proofIds), JSON.stringify(evidenceIds), JSON.stringify(unique(command.pendingWaitIds)),
      JSON.stringify(unique(command.pendingApprovalIds)), command.durableInputCursor ?? 0, recipeDigest,
      JSON.stringify(decisions), JSON.stringify(blockers), JSON.stringify(proposedNext),
      environmentFingerprint, boundedText(command.reason), boundedText(command.idempotencyNamespace, 120),
      storedIdempotencyKey,
      previous?.checkpointId ?? null, now, now,
    );
    return get(checkpointId)!;
  }).immediate;
  const listForWorkspace = (workspaceId: string | null, limit = 100): ContinuityCheckpointRecord[] => {
    const rows = workspaceId === null
      ? options.db.prepare('SELECT * FROM continuity_checkpoints WHERE workspace_id IS NULL ORDER BY updated_at DESC, checkpoint_sequence DESC LIMIT ?').all(limit) as Row[]
      : options.db.prepare('SELECT * FROM continuity_checkpoints WHERE workspace_id = ? ORDER BY updated_at DESC, checkpoint_sequence DESC LIMIT ?').all(workspaceId, limit) as Row[];
    return rows.map(mapRow);
  };
  return {
    capture: captureTx,
    get,
    getLatest,
    assess(checkpointId, current) {
      const checkpoint = get(checkpointId);
      if (!checkpoint || checkpoint.validity !== 'current') {
        throw new Error('Continuity checkpoint is missing, invalid, or superseded');
      }
      const repositoryDrift = checkpoint.repositoryFingerprint !== null
        && current.repositoryFingerprint !== undefined
        && checkpoint.repositoryFingerprint !== current.repositoryFingerprint;
      const environmentDrift = checkpoint.environmentFingerprint !== null
        && current.environmentFingerprint !== undefined
        && checkpoint.environmentFingerprint !== current.environmentFingerprint;
      return {
        checkpoint,
        assumptions: repositoryDrift || environmentDrift ? 'stale' : 'current',
        repositoryDrift,
        environmentDrift,
      };
    },
    listForWorkspace,
    resolveForWorkspace(workspaceId) {
      const candidates = listForWorkspace(workspaceId)
        .filter((checkpoint) => checkpoint.validity === 'current');
      if (candidates.length === 0) return { decision: 'none', checkpoint: null, candidates };
      if (candidates.length === 1) return { decision: 'selected', checkpoint: candidates[0], candidates };
      return { decision: 'choice_required', checkpoint: null, candidates };
    },
    invalidate(checkpointId, now = Date.now()) {
      options.db.prepare("UPDATE continuity_checkpoints SET validity='invalid', updated_at=? WHERE checkpoint_id=? AND validity!='invalid'")
        .run(now, checkpointId);
      return get(checkpointId);
    },
  };
}
