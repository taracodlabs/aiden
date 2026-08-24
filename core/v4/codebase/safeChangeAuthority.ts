/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Db } from '../daemon/db/connection';
import type { AttemptRecord, JobRecord } from '../daemon/jobEngine';
import type { JobProofAuthority } from '../daemon/jobProofAuthority';
import { isPathAllowed, isWithin, realpathWithFallback } from '../sandboxFs';
import { writeFileVerified } from '../writeFileVerified';
import type {
  RepositorySnapshotAuthority,
  RepositorySnapshotEntry,
  RepositorySnapshotRecord,
} from './repositorySnapshotAuthority';

export type FileChangeOperation = 'create' | 'modify' | 'patch' | 'delete' | 'move' | 'rename';

export interface FileChangePlan {
  operation: FileChangeOperation;
  path: string;
  destinationPath?: string;
  content?: string;
  find?: string;
  replace?: string;
  replaceAll?: boolean;
}

export interface FilePrecondition {
  path: string;
  canonicalPath: string;
  exists: boolean;
  size: number | null;
  modifiedAt: number | null;
  mode: number | null;
  contentHash: string | null;
  encoding: 'utf8' | 'binary' | 'absent';
  byteOrderMark: boolean;
  lineEnding: 'lf' | 'crlf' | 'mixed' | 'none';
}

export interface FilePostcondition extends FilePrecondition {}

export interface ChangeIntentRecord {
  intentId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  toolCallId: string;
  baseSnapshotId: string;
  operation: FileChangeOperation;
  canonicalTarget: string;
  canonicalDestination: string | null;
  expectedScope: string[];
  originalHash: string | null;
  originalMetadata: FilePrecondition;
  destinationOriginalMetadata: FilePrecondition | null;
  planDigest: string;
  plannedResultHash: string | null;
  plannedResultSize: number | null;
  effectId: string | null;
  approvalId: string | null;
  actionDigest: string | null;
  claimId: string;
  state: 'planned' | 'executing' | 'committed' | 'failed' | 'unknown';
  createdAt: number;
  updatedAt: number;
}

export interface ChangeRecord {
  changeId: string;
  intentId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  effectId: string;
  baseSnapshotId: string;
  state: 'committed' | 'failed' | 'unknown';
  resultHash: string | null;
  resultMetadata: FilePostcondition | null;
  diffEvidenceId: string | null;
  descendantSnapshotId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface SafeChangeIo {
  readback?: (canonicalPath: string) => Promise<Buffer>;
  afterMutation?: (intent: ChangeIntentRecord) => Promise<void>;
}

export class SafeChangeAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SafeChangeAuthorityError';
  }
}

export interface SafeChangeAuthority {
  prepare(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    toolCallId: string; baseSnapshotId: string; plan: FileChangePlan; producer: string;
  }): Promise<ChangeIntentRecord>;
  bindEffect(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    intentId: string; effectId: string;
  }): ChangeIntentRecord;
  bindApproval(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    intentId: string; effectId: string; approvalId: string; actionDigest: string;
  }): ChangeIntentRecord;
  execute(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    intentId: string; effectId: string; approvalId: string; actionDigest: string;
    plan: FileChangePlan; producer: string; signal?: AbortSignal;
  }): Promise<ChangeRecord>;
  getIntent(intentId: string): ChangeIntentRecord | undefined;
  getIntentForToolCall(attemptId: string, generation: number, toolCallId: string): ChangeIntentRecord | undefined;
  getRecord(intentId: string): ChangeRecord | undefined;
  listRecords(jobId: string): ChangeRecord[];
}

export async function fileChangePlanForTool(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  rootPath: string,
  priorOperation?: FileChangeOperation,
): Promise<FileChangePlan | null> {
  if (toolName === 'file_write') {
    const requested = String(args.path ?? args.file ?? '').trim();
    const content = typeof args.content === 'string' ? args.content : '';
    if (priorOperation === 'create' || priorOperation === 'modify') {
      return { operation: priorOperation, path: requested, content };
    }
    let exists = false;
    try { exists = (await fs.stat(path.resolve(rootPath, requested))).isFile(); } catch { /* absent */ }
    return { operation: exists ? 'modify' : 'create', path: requested, content };
  }
  if (toolName === 'file_patch') {
    return {
      operation: 'patch', path: String(args.path ?? args.file ?? '').trim(),
      find: typeof args.find === 'string' ? args.find : '',
      replace: typeof args.replace === 'string' ? args.replace : '',
      replaceAll: args.replace_all === true,
    };
  }
  if (toolName === 'file_delete') {
    if (args.recursive === true) throw new SafeChangeAuthorityError('UNSUPPORTED_MULTI_FILE_CHANGE', 'Recursive deletion requires separately tracked file changes');
    return { operation: 'delete', path: String(args.path ?? args.file ?? '').trim() };
  }
  if (toolName === 'file_move') {
    const source = String(args.from ?? args.source ?? '').trim();
    const destinationPath = String(args.to ?? args.dest ?? args.destination ?? '').trim();
    const operation = priorOperation === 'move' || priorOperation === 'rename'
      ? priorOperation
      : path.dirname(path.resolve(rootPath, source)) === path.dirname(path.resolve(rootPath, destinationPath))
        ? 'rename' : 'move';
    return { operation, path: source, destinationPath };
  }
  return null;
}

export function projectSafeChangeResult(
  record: ChangeRecord,
  intent: ChangeIntentRecord,
): Record<string, unknown> {
  return {
    success: record.state === 'committed',
    changeId: record.changeId,
    intentId: intent.intentId,
    effectId: record.effectId,
    operation: intent.operation,
    path: intent.canonicalTarget,
    ...(intent.canonicalDestination ? { destination: intent.canonicalDestination } : {}),
    resultHash: record.resultHash,
    descendantSnapshotId: record.descendantSnapshotId,
    evidenceId: record.diffEvidenceId,
    verified: record.state === 'committed' && record.diffEvidenceId !== null,
  };
}

interface Deps {
  db: Db;
  repository: RepositorySnapshotAuthority;
  proof: JobProofAuthority;
  getJob(jobId: string): JobRecord | null;
  getAttempt(attemptId: string): AttemptRecord | null;
  appendJobEvent(command: {
    jobId: string; attemptId: string; generation: number; type: string;
    payload?: Record<string, unknown> | null; producer: string; idempotencyKey: string;
  }): { applied: boolean; duplicate: boolean; conflict?: string };
}

const HASH = 'sha256';
const id = (prefix: string): string => `${prefix}_${randomBytes(16).toString('hex')}`;
const digest = (value: unknown): string => createHash(HASH).update(stableJson(value)).digest('hex');
const normalizeRelative = (value: string): string => value.split(path.sep).join('/').replace(/^\.\//, '');
const sameCanonicalPath = (left: string, right: string): boolean => (
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
);

function stableJson(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, visit(record[key])]));
    }
    return input;
  };
  return JSON.stringify(visit(value));
}

function isTerminal(status: string): boolean {
  return ['succeeded', 'completed', 'failed', 'cancelled', 'timed_out', 'crashed', 'unknown', 'interrupted'].includes(status);
}

function lineEndingOf(text: string): FilePrecondition['lineEnding'] {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}

function decodeText(bytes: Buffer): { text: string; byteOrderMark: boolean; lineEnding: FilePrecondition['lineEnding'] } | null {
  if (bytes.subarray(0, 8_192).includes(0)) return null;
  try {
    const byteOrderMark = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const body = byteOrderMark ? bytes.subarray(3) : bytes;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { text, byteOrderMark, lineEnding: lineEndingOf(text) };
  } catch {
    return null;
  }
}

function normalizeNewlines(text: string, lineEnding: FilePrecondition['lineEnding']): string {
  if (lineEnding !== 'crlf') return text;
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

function formatContent(text: string, precondition: FilePrecondition): string {
  const normalized = normalizeNewlines(text, precondition.lineEnding);
  return precondition.byteOrderMark ? `\ufeff${normalized.replace(/^\ufeff/, '')}` : normalized.replace(/^\ufeff/, '');
}

async function inspectFile(canonicalPath: string): Promise<FilePrecondition> {
  try {
    const stat = await fs.stat(canonicalPath);
    if (!stat.isFile()) throw new SafeChangeAuthorityError('UNSUPPORTED_PATH_KIND', 'Codebase changes require a regular file');
    const bytes = await fs.readFile(canonicalPath);
    const decoded = decodeText(bytes);
    return {
      path: canonicalPath,
      canonicalPath,
      exists: true,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      mode: stat.mode,
      contentHash: createHash(HASH).update(bytes).digest('hex'),
      encoding: decoded ? 'utf8' : 'binary',
      byteOrderMark: decoded?.byteOrderMark ?? false,
      lineEnding: decoded?.lineEnding ?? 'none',
    };
  } catch (error) {
    if (error instanceof SafeChangeAuthorityError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      path: canonicalPath,
      canonicalPath,
      exists: false,
      size: null,
      modifiedAt: null,
      mode: null,
      contentHash: null,
      encoding: 'absent',
      byteOrderMark: false,
      lineEnding: 'none',
    };
  }
}

function sameSource(expected: RepositorySnapshotEntry, current: FilePrecondition): boolean {
  return current.exists
    && expected.contentHash !== null
    && current.contentHash === expected.contentHash
    && current.size === expected.size
    && current.modifiedAt === expected.modifiedAt
    && current.mode === expected.mode;
}

function simpleDiff(before: string | null, after: string | null, relativePath: string): string {
  const from = before === null ? [] : before.split(/\r?\n/);
  const to = after === null ? [] : after.split(/\r?\n/);
  const lines = [`--- a/${relativePath}`, `+++ b/${relativePath}`];
  const max = Math.max(from.length, to.length);
  for (let index = 0; index < max; index += 1) {
    if (from[index] === to[index]) continue;
    if (from[index] !== undefined) lines.push(`-${from[index]}`);
    if (to[index] !== undefined) lines.push(`+${to[index]}`);
    if (lines.join('\n').length > 128_000) { lines.push('... diff truncated ...'); break; }
  }
  return `${lines.join('\n')}\n`;
}

function planHasRequiredFields(plan: FileChangePlan): void {
  if (!plan.path || /[\0\r\n]/.test(plan.path)) throw new SafeChangeAuthorityError('INVALID_CHANGE_PLAN', 'Change target path is required');
  if ((plan.operation === 'create' || plan.operation === 'modify') && typeof plan.content !== 'string') {
    throw new SafeChangeAuthorityError('INVALID_CHANGE_PLAN', 'Text content is required');
  }
  if (plan.operation === 'patch' && (typeof plan.find !== 'string' || !plan.find || typeof plan.replace !== 'string')) {
    throw new SafeChangeAuthorityError('INVALID_CHANGE_PLAN', 'Patch find and replace text are required');
  }
  if ((plan.operation === 'move' || plan.operation === 'rename') && !plan.destinationPath) {
    throw new SafeChangeAuthorityError('INVALID_CHANGE_PLAN', 'Move destination is required');
  }
}

export function createSafeChangeAuthority(deps: Deps, io: SafeChangeIo = {}): SafeChangeAuthority {
  const { db } = deps;

  const assertAuthority = (input: { jobId: string; attemptId: string; generation: number; fenceToken: string }): void => {
    const job = deps.getJob(input.jobId);
    const attempt = deps.getAttempt(input.attemptId);
    if (!job || !attempt || attempt.jobId !== job.id || job.activeAttemptId !== attempt.id
      || isTerminal(job.status) || attempt.generation !== input.generation
      || attempt.fenceToken !== input.fenceToken || attempt.leaseExpiresAt === null
      || attempt.leaseExpiresAt <= Date.now() || isTerminal(attempt.status)) {
      throw new SafeChangeAuthorityError('STALE_CHANGE_AUTHORITY', 'Attempt generation or fence no longer owns this repository change');
    }
  };

  const mapIntent = (row: Record<string, unknown>): ChangeIntentRecord => ({
    intentId: String(row.intent_id), jobId: String(row.job_id), attemptId: String(row.attempt_id),
    generation: Number(row.generation), fenceToken: String(row.fence_token), toolCallId: String(row.tool_call_id),
    baseSnapshotId: String(row.base_snapshot_id), operation: row.operation as FileChangeOperation,
    canonicalTarget: String(row.canonical_target),
    canonicalDestination: row.canonical_destination === null ? null : String(row.canonical_destination),
    expectedScope: JSON.parse(String(row.expected_scope_json)) as string[],
    originalHash: row.original_hash === null ? null : String(row.original_hash),
    originalMetadata: JSON.parse(String(row.original_metadata_json)) as FilePrecondition,
    destinationOriginalMetadata: row.destination_original_metadata_json === null
      ? null : JSON.parse(String(row.destination_original_metadata_json)) as FilePrecondition,
    planDigest: String(row.plan_digest), effectId: row.effect_id === null ? null : String(row.effect_id),
    plannedResultHash: row.planned_result_hash === null ? null : String(row.planned_result_hash),
    plannedResultSize: row.planned_result_size === null ? null : Number(row.planned_result_size),
    approvalId: row.approval_id === null ? null : String(row.approval_id),
    actionDigest: row.action_digest === null ? null : String(row.action_digest),
    claimId: String(row.claim_id), state: row.state as ChangeIntentRecord['state'],
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  });
  const getIntent = (intentId: string): ChangeIntentRecord | undefined => {
    const row = db.prepare('SELECT * FROM repository_change_intents WHERE intent_id=?').get(intentId) as Record<string, unknown> | undefined;
    return row ? mapIntent(row) : undefined;
  };
  const getIntentForToolCall = (attemptId: string, generation: number, toolCallId: string): ChangeIntentRecord | undefined => {
    const row = db.prepare(
      'SELECT * FROM repository_change_intents WHERE attempt_id=? AND generation=? AND tool_call_id=?',
    ).get(attemptId, generation, toolCallId) as Record<string, unknown> | undefined;
    return row ? mapIntent(row) : undefined;
  };
  const mapRecord = (row: Record<string, unknown>): ChangeRecord => ({
    changeId: String(row.change_id), intentId: String(row.intent_id), jobId: String(row.job_id),
    attemptId: String(row.attempt_id), generation: Number(row.generation), fenceToken: String(row.fence_token),
    effectId: String(row.effect_id),
    baseSnapshotId: String(row.base_snapshot_id), state: row.state as ChangeRecord['state'],
    resultHash: row.result_hash === null ? null : String(row.result_hash),
    resultMetadata: row.result_metadata_json === null ? null : JSON.parse(String(row.result_metadata_json)) as FilePostcondition,
    diffEvidenceId: row.diff_evidence_id === null ? null : String(row.diff_evidence_id),
    descendantSnapshotId: row.descendant_snapshot_id === null ? null : String(row.descendant_snapshot_id),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    createdAt: Number(row.created_at), completedAt: row.completed_at === null ? null : Number(row.completed_at),
  });
  const getRecord = (intentId: string): ChangeRecord | undefined => {
    const row = db.prepare('SELECT * FROM repository_change_records WHERE intent_id=?').get(intentId) as Record<string, unknown> | undefined;
    return row ? mapRecord(row) : undefined;
  };
  const listRecords = (jobId: string): ChangeRecord[] => (
    db.prepare('SELECT * FROM repository_change_records WHERE job_id=? ORDER BY created_at,change_id').all(jobId) as Array<Record<string, unknown>>
  ).map(mapRecord);

  const rootFor = (snapshot: RepositorySnapshotRecord): string => {
    const workspace = deps.repository.getWorkspace(snapshot.workspaceId);
    if (!workspace) throw new SafeChangeAuthorityError('WORKSPACE_NOT_FOUND', 'Repository workspace is unavailable');
    return realpathWithFallback(snapshot.repositoryRoot ?? workspace.canonicalPath);
  };

  const resolveTarget = (root: string, requested: string): { canonical: string; relative: string } => {
    const lexical = path.resolve(root, requested);
    const canonical = realpathWithFallback(lexical);
    if (sameCanonicalPath(canonical, root) || !isWithin(canonical, root)) {
      throw new SafeChangeAuthorityError('PATH_OUTSIDE_WORKSPACE', 'Change target resolves outside the repository workspace');
    }
    const sandbox = isPathAllowed(canonical, 'write', root);
    if (!sandbox.allowed) throw new SafeChangeAuthorityError('PATH_NOT_ALLOWED', sandbox.violation?.message ?? 'Path is not allowed');
    return { canonical, relative: normalizeRelative(path.relative(root, canonical)) };
  };

  const failRecord = (
    intent: ChangeIntentRecord,
    state: 'failed' | 'unknown',
    code: string,
    message: string,
    extras: Partial<Pick<ChangeRecord, 'resultHash' | 'resultMetadata' | 'diffEvidenceId' | 'descendantSnapshotId'>> = {},
  ): void => {
    const now = Date.now();
    db.prepare(
      `UPDATE repository_change_records SET state=?,result_hash=?,result_metadata_json=?,diff_evidence_id=?,
       descendant_snapshot_id=?,error_code=?,error_message=?,completed_at=? WHERE intent_id=?`,
    ).run(state, extras.resultHash ?? null, extras.resultMetadata ? JSON.stringify(extras.resultMetadata) : null,
      extras.diffEvidenceId ?? null, extras.descendantSnapshotId ?? null, code, message, now, intent.intentId);
    db.prepare('UPDATE repository_change_intents SET state=?,updated_at=? WHERE intent_id=?').run(state, now, intent.intentId);
  };

  const recordUnknownEvidence = (input: {
    intent: ChangeIntentRecord; fenceToken: string; producer: string; code: string; message: string;
    resultMetadata?: FilePostcondition | null; resultHash?: string | null;
  }): string => {
    const observedAt = Date.now();
    const evidence = deps.proof.recordEvidence({
      jobId: input.intent.jobId, attemptId: input.intent.attemptId, generation: input.intent.generation,
      fenceToken: input.fenceToken, effectId: input.intent.effectId, source: 'repository.change.readback',
      producer: input.producer, observedAt, freshUntil: null, coverage: 'unknown',
      verificationResult: 'unknown', payload: {
        operation: input.intent.operation, target: input.intent.canonicalTarget,
        resultHash: input.resultHash ?? null, errorCode: input.code,
      },
    });
    deps.proof.checkClaim({
      claimId: input.intent.claimId, attemptId: input.intent.attemptId,
      generation: input.intent.generation, evidenceIds: [evidence.evidenceId], state: 'unknown',
    });
    return evidence.evidenceId;
  };

  const recordConflictEvidence = (input: {
    intent: ChangeIntentRecord; fenceToken: string; producer: string;
    code: 'STALE_SOURCE' | 'STALE_DESTINATION'; message: string;
    expected: FilePrecondition; observed: FilePrecondition;
  }): string => {
    const existing = deps.proof.listEvidence(input.intent.jobId).find((evidence) => (
      evidence.source === 'repository.change.conflict'
      && evidence.effectId === input.intent.effectId
      && (evidence.payload as { intentId?: unknown }).intentId === input.intent.intentId
      && (evidence.payload as { errorCode?: unknown }).errorCode === input.code
    ));
    const observedAt = Date.now();
    const evidence = existing ?? deps.proof.recordEvidence({
      jobId: input.intent.jobId, attemptId: input.intent.attemptId, generation: input.intent.generation,
      fenceToken: input.fenceToken, effectId: input.intent.effectId,
      repositorySnapshotId: input.intent.baseSnapshotId,
      source: 'repository.change.conflict', producer: input.producer,
      observedAt, freshUntil: null, coverage: 'full', verificationResult: 'unknown',
      payload: {
        intentId: input.intent.intentId, operation: input.intent.operation,
        baseSnapshotId: input.intent.baseSnapshotId, target: input.intent.canonicalTarget,
        errorCode: input.code, message: input.message, expectedHash: input.expected.contentHash,
        observedHash: input.observed.contentHash, expectedMetadata: input.expected,
        observedMetadata: input.observed,
      },
    });
    deps.proof.checkClaim({
      claimId: input.intent.claimId, attemptId: input.intent.attemptId,
      generation: input.intent.generation, evidenceIds: [evidence.evidenceId], state: 'unknown',
    });
    db.prepare("UPDATE repository_change_intents SET state='failed',updated_at=? WHERE intent_id=? AND state='planned'")
      .run(observedAt, input.intent.intentId);
    deps.appendJobEvent({
      jobId: input.intent.jobId, attemptId: input.intent.attemptId, generation: input.intent.generation,
      type: 'repository.change_conflict', payload: {
        intentId: input.intent.intentId, errorCode: input.code,
        baseSnapshotId: input.intent.baseSnapshotId, evidenceId: evidence.evidenceId,
      },
      producer: input.producer,
      idempotencyKey: `repository-change-conflict:${input.intent.intentId}:${input.code}`,
    });
    return evidence.evidenceId;
  };

  return {
    async prepare(input) {
      assertAuthority(input);
      planHasRequiredFields(input.plan);
      const snapshot = deps.repository.getSnapshot(input.baseSnapshotId);
      if (!snapshot || snapshot.jobId !== input.jobId || snapshot.attemptId !== input.attemptId
        || snapshot.generation !== input.generation) {
        throw new SafeChangeAuthorityError('INVALID_BASE_SNAPSHOT', 'Base repository snapshot is outside the active Attempt');
      }
      const root = rootFor(snapshot);
      const target = resolveTarget(root, input.plan.path);
      const destination = input.plan.destinationPath ? resolveTarget(root, input.plan.destinationPath) : null;
      if (destination?.canonical === target.canonical) {
        throw new SafeChangeAuthorityError('INVALID_CHANGE_PLAN', 'Source and destination must differ');
      }
      const planDigest = digest(input.plan);
      const duplicate = db.prepare(
        'SELECT * FROM repository_change_intents WHERE attempt_id=? AND generation=? AND tool_call_id=?',
      ).get(input.attemptId, input.generation, input.toolCallId) as Record<string, unknown> | undefined;
      if (duplicate) {
        const existing = mapIntent(duplicate);
        if (existing.planDigest !== planDigest || (existing.state !== 'committed' && existing.baseSnapshotId !== input.baseSnapshotId)) {
          throw new SafeChangeAuthorityError('CHANGE_INTENT_CONFLICT', 'ToolCall identity is already bound to a different change');
        }
        return existing;
      }
      const baseEntry = deps.repository.getEntry(snapshot.id, target.relative);
      const current = await inspectFile(target.canonical);
      if (input.plan.operation === 'create') {
        if (baseEntry || current.exists) throw new SafeChangeAuthorityError('STALE_SOURCE', 'Create target already exists');
      } else {
        if (!baseEntry || baseEntry.captureStatus !== 'captured' || baseEntry.contentHash === null) {
          throw new SafeChangeAuthorityError(current.encoding === 'binary' ? 'BINARY_EDIT_UNSUPPORTED' : 'SOURCE_NOT_CAPTURED', 'Change source was not captured with a full content hash');
        }
        if (!sameSource(baseEntry, current)) throw new SafeChangeAuthorityError('STALE_SOURCE', 'Source metadata or content differs from the approved snapshot');
        if (current.encoding === 'binary') throw new SafeChangeAuthorityError('BINARY_EDIT_UNSUPPORTED', 'Binary repository edits are not supported');
      }
      let destinationCurrent: FilePrecondition | null = null;
      if (destination) {
        const destinationEntry = deps.repository.getEntry(snapshot.id, destination.relative);
        destinationCurrent = await inspectFile(destination.canonical);
        if (destinationEntry || destinationCurrent.exists) {
          throw new SafeChangeAuthorityError('STALE_DESTINATION', 'Move destination already exists');
        }
      }
      let plannedResultHash: string | null = null;
      let plannedResultSize: number | null = null;
      if (input.plan.operation === 'create') {
        plannedResultHash = createHash(HASH).update(input.plan.content!).digest('hex');
        plannedResultSize = Buffer.byteLength(input.plan.content!);
      } else if (input.plan.operation === 'modify') {
        const planned = formatContent(input.plan.content!, current);
        plannedResultHash = createHash(HASH).update(planned).digest('hex');
        plannedResultSize = Buffer.byteLength(planned);
      } else if (input.plan.operation === 'patch') {
        const bytes = await fs.readFile(target.canonical);
        const decoded = decodeText(bytes);
        if (!decoded) throw new SafeChangeAuthorityError('BINARY_EDIT_UNSUPPORTED', 'Binary repository edits are not supported');
        const count = decoded.text.split(input.plan.find!).length - 1;
        if (count === 0) throw new SafeChangeAuthorityError('PATCH_NO_MATCH', 'Patch find text has no exact match');
        if (count > 1 && input.plan.replaceAll !== true) throw new SafeChangeAuthorityError('PATCH_AMBIGUOUS', `Patch find text has ${count} matches`);
        const replacement = normalizeNewlines(input.plan.replace!, current.lineEnding);
        const next = input.plan.replaceAll === true
          ? decoded.text.split(input.plan.find!).join(replacement)
          : decoded.text.replace(input.plan.find!, replacement);
        const planned = formatContent(next, current);
        plannedResultHash = createHash(HASH).update(planned).digest('hex');
        plannedResultSize = Buffer.byteLength(planned);
      } else if (input.plan.operation === 'move' || input.plan.operation === 'rename') {
        plannedResultHash = current.contentHash;
        plannedResultSize = current.size;
      }
      const intentId = id('change_intent');
      const claim = deps.proof.createClaim({
        jobId: input.jobId, attemptId: input.attemptId, generation: input.generation,
        category: 'contract', statement: `repository ${input.plan.operation} matches approved source: ${target.relative}`,
        required: true,
      });
      const now = Date.now();
      const expectedScope = [target.relative, ...(destination ? [destination.relative] : [])].sort();
      db.prepare(
        `INSERT INTO repository_change_intents (
          intent_id,job_id,attempt_id,generation,fence_token,tool_call_id,base_snapshot_id,operation,
          canonical_target,canonical_destination,expected_scope_json,original_hash,original_metadata_json,
          destination_original_metadata_json,plan_digest,planned_result_hash,planned_result_size,
          effect_id,approval_id,action_digest,claim_id,state,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'planned',?,?)`,
      ).run(intentId,input.jobId,input.attemptId,input.generation,input.fenceToken,input.toolCallId,input.baseSnapshotId,input.plan.operation,
        target.canonical,destination?.canonical??null,JSON.stringify(expectedScope),current.contentHash,JSON.stringify(current),
        destinationCurrent ? JSON.stringify(destinationCurrent) : null,planDigest,plannedResultHash,plannedResultSize,
        null,null,null,claim.claimId,now,now);
      deps.appendJobEvent({
        jobId: input.jobId, attemptId: input.attemptId, generation: input.generation,
        type: 'repository.change_intent_prepared', payload: { intentId, operation: input.plan.operation, baseSnapshotId: input.baseSnapshotId },
        producer: input.producer, idempotencyKey: `repository-change-intent:${intentId}`,
      });
      return getIntent(intentId)!;
    },

    bindEffect(input) {
      assertAuthority(input);
      const intent = getIntent(input.intentId);
      if (!intent || intent.jobId !== input.jobId || intent.attemptId !== input.attemptId || intent.generation !== input.generation) {
        throw new SafeChangeAuthorityError('CHANGE_INTENT_NOT_FOUND', 'Change intent is outside the active Attempt');
      }
      const effect = db.prepare('SELECT job_id,attempt_id,generation,tool_call_id FROM side_effect_ledger WHERE key=?')
        .get(input.effectId) as { job_id: string; attempt_id: string; generation: number; tool_call_id: string } | undefined;
      if (!effect || effect.job_id !== input.jobId || effect.attempt_id !== input.attemptId
        || effect.generation !== input.generation || effect.tool_call_id !== intent.toolCallId) {
        throw new SafeChangeAuthorityError('EFFECT_BINDING_MISMATCH', 'Effect does not match the planned repository change');
      }
      if (intent.effectId && intent.effectId !== input.effectId) throw new SafeChangeAuthorityError('EFFECT_BINDING_MISMATCH', 'Change intent already has a different Effect');
      db.prepare('UPDATE repository_change_intents SET effect_id=?,updated_at=? WHERE intent_id=?')
        .run(input.effectId, Date.now(), input.intentId);
      return getIntent(input.intentId)!;
    },

    bindApproval(input) {
      assertAuthority(input);
      const intent = getIntent(input.intentId);
      if (!intent || intent.effectId !== input.effectId) throw new SafeChangeAuthorityError('EFFECT_BINDING_MISMATCH', 'Change intent is not bound to this Effect');
      const approval = db.prepare(
        'SELECT job_id,attempt_id,generation,tool_call_id,effect_id,action_digest FROM approvals WHERE approval_id=?',
      ).get(input.approvalId) as {
        job_id: string; attempt_id: string; generation: number; tool_call_id: string;
        effect_id: string | null; action_digest: string;
      } | undefined;
      if (!approval || approval.job_id !== input.jobId || approval.attempt_id !== input.attemptId
        || approval.generation !== input.generation || approval.tool_call_id !== intent.toolCallId
        || approval.effect_id !== input.effectId || approval.action_digest !== input.actionDigest) {
        throw new SafeChangeAuthorityError('APPROVAL_BINDING_MISMATCH', 'Approval does not match the exact planned change');
      }
      if ((intent.approvalId && intent.approvalId !== input.approvalId)
        || (intent.actionDigest && intent.actionDigest !== input.actionDigest)) {
        throw new SafeChangeAuthorityError('APPROVAL_BINDING_MISMATCH', 'Change intent already has a different approval');
      }
      db.prepare('UPDATE repository_change_intents SET approval_id=?,action_digest=?,updated_at=? WHERE intent_id=?')
        .run(input.approvalId, input.actionDigest, Date.now(), input.intentId);
      return getIntent(input.intentId)!;
    },

    async execute(input) {
      const intent = getIntent(input.intentId);
      if (!intent || intent.jobId !== input.jobId || intent.attemptId !== input.attemptId || intent.generation !== input.generation) {
        throw new SafeChangeAuthorityError('CHANGE_INTENT_NOT_FOUND', 'Change intent is outside the active Attempt');
      }
      if (intent.planDigest !== digest(input.plan)) throw new SafeChangeAuthorityError('APPROVED_CHANGE_MISMATCH', 'Execution plan differs from the approved change intent');
      if (intent.effectId !== input.effectId || intent.approvalId !== input.approvalId || intent.actionDigest !== input.actionDigest) {
        throw new SafeChangeAuthorityError('APPROVAL_BINDING_MISMATCH', 'Execution does not match the bound Effect and approval');
      }
      const prior = getRecord(input.intentId);
      if (prior?.state === 'committed') return prior;
      if (prior) throw new SafeChangeAuthorityError('CHANGE_OUTCOME_UNRESOLVED', 'A prior change attempt did not reach a verified committed state');
      assertAuthority(input);
      const approval = db.prepare(
        `SELECT state,job_id,attempt_id,generation,tool_call_id,effect_id,action_digest
           FROM approvals WHERE approval_id=?`,
      ).get(input.approvalId) as Record<string, unknown> | undefined;
      if (!approval || approval.state !== 'executed' || approval.job_id !== input.jobId
        || approval.attempt_id !== input.attemptId || Number(approval.generation) !== input.generation
        || approval.tool_call_id !== intent.toolCallId || approval.effect_id !== input.effectId
        || approval.action_digest !== input.actionDigest) {
        throw new SafeChangeAuthorityError('APPROVAL_NOT_EXECUTABLE', 'Exact approval was not revalidated for execution');
      }
      const effect = db.prepare(
        'SELECT job_id,attempt_id,generation,tool_call_id,effect_state FROM side_effect_ledger WHERE key=?',
      ).get(input.effectId) as Record<string, unknown> | undefined;
      if (!effect || effect.job_id !== input.jobId || effect.attempt_id !== input.attemptId
        || Number(effect.generation) !== input.generation || effect.tool_call_id !== intent.toolCallId
        || effect.effect_state !== 'started') {
        throw new SafeChangeAuthorityError('EFFECT_NOT_EXECUTABLE', 'Producing Effect is not active for this change');
      }
      if (input.signal?.aborted) throw new SafeChangeAuthorityError('CHANGE_CANCELLED', 'Repository change was cancelled before mutation');

      const baseSnapshot = deps.repository.getSnapshot(intent.baseSnapshotId);
      if (!baseSnapshot) throw new SafeChangeAuthorityError('INVALID_BASE_SNAPSHOT', 'Base repository snapshot is unavailable');
      const root = rootFor(baseSnapshot);
      const refreshedTarget = realpathWithFallback(intent.canonicalTarget);
      if (!isWithin(refreshedTarget, root) || !sameCanonicalPath(refreshedTarget, intent.canonicalTarget)) {
        throw new SafeChangeAuthorityError('TARGET_IDENTITY_CHANGED', 'Canonical target identity changed after approval');
      }
      if (intent.canonicalDestination) {
        const refreshedDestination = realpathWithFallback(intent.canonicalDestination);
        if (!isWithin(refreshedDestination, root) || !sameCanonicalPath(refreshedDestination, intent.canonicalDestination)) {
          throw new SafeChangeAuthorityError('TARGET_IDENTITY_CHANGED', 'Canonical destination identity changed after approval');
        }
      }

      const current = await inspectFile(intent.canonicalTarget);
      const expected = intent.originalMetadata;
      if (expected.exists !== current.exists || expected.contentHash !== current.contentHash
        || expected.size !== current.size || expected.modifiedAt !== current.modifiedAt || expected.mode !== current.mode) {
        recordConflictEvidence({
          intent: { ...intent, effectId: input.effectId }, fenceToken: input.fenceToken,
          producer: input.producer, code: 'STALE_SOURCE',
          message: 'Source metadata or content changed after approval', expected, observed: current,
        });
        throw new SafeChangeAuthorityError('STALE_SOURCE', 'Source metadata or content changed after approval');
      }
      if (intent.canonicalDestination) {
        const destination = await inspectFile(intent.canonicalDestination);
        const expectedDestination = intent.destinationOriginalMetadata;
        if (!expectedDestination || destination.exists !== expectedDestination.exists
          || destination.contentHash !== expectedDestination.contentHash || destination.modifiedAt !== expectedDestination.modifiedAt) {
          recordConflictEvidence({
            intent: { ...intent, effectId: input.effectId }, fenceToken: input.fenceToken,
            producer: input.producer, code: 'STALE_DESTINATION',
            message: 'Destination changed after approval',
            expected: expectedDestination ?? {
              path: intent.canonicalDestination, canonicalPath: intent.canonicalDestination,
              exists: false, size: null, modifiedAt: null, mode: null, contentHash: null,
              encoding: 'absent', byteOrderMark: false, lineEnding: 'none',
            },
            observed: destination,
          });
          throw new SafeChangeAuthorityError('STALE_DESTINATION', 'Destination changed after approval');
        }
      }
      const now = Date.now();
      const changeId = id('change');
      db.transaction(() => {
        assertAuthority(input);
        db.prepare('UPDATE repository_change_intents SET state=\'executing\',updated_at=? WHERE intent_id=? AND state=\'planned\'')
          .run(now, intent.intentId);
        db.prepare(
          `INSERT INTO repository_change_records (
            change_id,intent_id,job_id,attempt_id,generation,fence_token,effect_id,base_snapshot_id,state,
            result_hash,result_metadata_json,diff_evidence_id,descendant_snapshot_id,error_code,error_message,created_at,completed_at
          ) VALUES (?,?,?,?,?,?,?,?,'unknown',NULL,NULL,NULL,NULL,NULL,NULL,?,NULL)`,
        ).run(changeId,intent.intentId,input.jobId,input.attemptId,input.generation,input.fenceToken,input.effectId,intent.baseSnapshotId,now);
      }).immediate();

      let beforeText: string | null = null;
      let expectedText: string | null = null;
      try {
        if (current.exists) {
          const bytes = await fs.readFile(intent.canonicalTarget);
          const decoded = decodeText(bytes);
          if (!decoded) throw new SafeChangeAuthorityError('BINARY_EDIT_UNSUPPORTED', 'Binary repository edits are not supported');
          beforeText = `${decoded.byteOrderMark ? '\ufeff' : ''}${decoded.text}`;
        }
        if (input.plan.operation === 'create') {
          expectedText = input.plan.content!;
          await writeFileVerified(intent.canonicalTarget, expectedText);
        } else if (input.plan.operation === 'modify') {
          expectedText = formatContent(input.plan.content!, current);
          await writeFileVerified(intent.canonicalTarget, expectedText);
        } else if (input.plan.operation === 'patch') {
          const body = beforeText!.replace(/^\ufeff/, '');
          const count = body.split(input.plan.find!).length - 1;
          if (count === 0) throw new SafeChangeAuthorityError('PATCH_NO_MATCH', 'Patch find text has no exact match');
          if (count > 1 && input.plan.replaceAll !== true) throw new SafeChangeAuthorityError('PATCH_AMBIGUOUS', `Patch find text has ${count} matches`);
          const replacement = normalizeNewlines(input.plan.replace!, current.lineEnding);
          const next = input.plan.replaceAll === true
            ? body.split(input.plan.find!).join(replacement)
            : body.replace(input.plan.find!, replacement);
          expectedText = formatContent(next, current);
          await writeFileVerified(intent.canonicalTarget, expectedText);
        } else if (input.plan.operation === 'delete') {
          await fs.unlink(intent.canonicalTarget);
        } else {
          await fs.mkdir(path.dirname(intent.canonicalDestination!), { recursive: true });
          try { await fs.rename(intent.canonicalTarget, intent.canonicalDestination!); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
              throw new SafeChangeAuthorityError('CROSS_DEVICE_MOVE_UNSUPPORTED', 'Cross-device repository moves require an explicit recoverable plan');
            }
            throw error;
          }
        }
        await io.afterMutation?.(intent);
      } catch (error) {
        const safe = error instanceof SafeChangeAuthorityError
          ? error : new SafeChangeAuthorityError('MUTATION_FAILED', error instanceof Error ? error.message : String(error));
        failRecord(intent, 'unknown', safe.code, safe.message);
        throw safe;
      }

      if (input.signal?.aborted) {
        const code = 'CHANGE_CANCELLED_UNKNOWN';
        const evidenceId = recordUnknownEvidence({ intent: { ...intent, effectId: input.effectId }, fenceToken: input.fenceToken, producer: input.producer, code, message: 'Cancellation raced with mutation' });
        failRecord(intent, 'unknown', code, 'Cancellation raced with mutation', { diffEvidenceId: evidenceId });
        throw new SafeChangeAuthorityError(code, 'Repository change outcome requires reconciliation after cancellation');
      }

      let resultMetadata: FilePostcondition;
      let afterText: string | null = null;
      try {
        if (input.plan.operation === 'delete') {
          resultMetadata = await inspectFile(intent.canonicalTarget);
          if (resultMetadata.exists) throw new Error('deleted target still exists');
        } else if (input.plan.operation === 'move' || input.plan.operation === 'rename') {
          const source = await inspectFile(intent.canonicalTarget);
          resultMetadata = await inspectFile(intent.canonicalDestination!);
          if (source.exists || !resultMetadata.exists || resultMetadata.contentHash !== current.contentHash) {
            throw new Error('moved file did not reach the exact destination');
          }
          const bytes = io.readback ? await io.readback(intent.canonicalDestination!) : await fs.readFile(intent.canonicalDestination!);
          const decoded = decodeText(bytes);
          if (!decoded || createHash(HASH).update(bytes).digest('hex') !== resultMetadata.contentHash) throw new Error('move readback mismatch');
          afterText = `${decoded.byteOrderMark ? '\ufeff' : ''}${decoded.text}`;
        } else {
          const bytes = io.readback ? await io.readback(intent.canonicalTarget) : await fs.readFile(intent.canonicalTarget);
          const decoded = decodeText(bytes);
          if (!decoded) throw new Error('readback is not supported UTF-8 text');
          afterText = `${decoded.byteOrderMark ? '\ufeff' : ''}${decoded.text}`;
          if (afterText !== expectedText) throw new Error('readback content differs from the planned result');
          resultMetadata = await inspectFile(intent.canonicalTarget);
          if (resultMetadata.contentHash !== createHash(HASH).update(bytes).digest('hex')) throw new Error('readback hash mismatch');
        }
      } catch (error) {
        const code = 'READBACK_FAILED';
        const evidenceId = recordUnknownEvidence({ intent: { ...intent, effectId: input.effectId }, fenceToken: input.fenceToken, producer: input.producer, code, message: error instanceof Error ? error.message : String(error) });
        failRecord(intent, 'unknown', code, error instanceof Error ? error.message : String(error), { diffEvidenceId: evidenceId });
        throw new SafeChangeAuthorityError(code, 'Repository mutation could not be verified by fresh readback');
      }

      let descendant: RepositorySnapshotRecord;
      try {
        descendant = await deps.repository.captureSnapshot({
          jobId: input.jobId, attemptId: input.attemptId, generation: input.generation,
          fenceToken: input.fenceToken, requestedPath: rootFor(deps.repository.getSnapshot(intent.baseSnapshotId)!),
          previousSnapshotId: intent.baseSnapshotId, producer: input.producer,
        });
      } catch (error) {
        const code = 'DESCENDANT_SNAPSHOT_FAILED';
        const evidenceId = recordUnknownEvidence({ intent: { ...intent, effectId: input.effectId }, fenceToken: input.fenceToken, producer: input.producer, code, message: error instanceof Error ? error.message : String(error), resultMetadata, resultHash: resultMetadata.contentHash });
        failRecord(intent, 'unknown', code, error instanceof Error ? error.message : String(error), { resultHash: resultMetadata.contentHash, resultMetadata, diffEvidenceId: evidenceId });
        throw new SafeChangeAuthorityError(code, 'Verified filesystem result could not be bound to a descendant snapshot');
      }
      const comparison = deps.repository.compareSnapshots(intent.baseSnapshotId, descendant.id);
      const changedScope = [...new Set([...comparison.added, ...comparison.removed, ...comparison.changed])].sort();
      const undeclared = changedScope.filter((item) => !intent.expectedScope.includes(item));
      const observedAt = Date.now();
      const evidence = deps.proof.recordEvidence({
        jobId: input.jobId, attemptId: input.attemptId, generation: input.generation,
        fenceToken: input.fenceToken, effectId: input.effectId, source: 'repository.change.readback',
        producer: input.producer, observedAt, freshUntil: observedAt + 60_000,
        coverage: 'full', verificationResult: undeclared.length ? 'failed' : 'verified',
        payload: {
          operation: intent.operation, baseSnapshotId: intent.baseSnapshotId,
          descendantSnapshotId: descendant.id, target: intent.canonicalTarget,
          destination: intent.canonicalDestination, beforeHash: intent.originalHash,
          resultHash: resultMetadata.contentHash, changedScope,
          diff: simpleDiff(beforeText, afterText, intent.expectedScope[0]),
        },
      });
      if (undeclared.length) {
        deps.proof.checkClaim({
          claimId: intent.claimId, attemptId: input.attemptId, generation: input.generation,
          evidenceIds: [evidence.evidenceId], state: 'failed',
        });
        failRecord(intent, 'failed', 'UNDECLARED_WORKSPACE_CHANGE', `Mutation changed paths outside its approved scope: ${undeclared.join(', ')}`, {
          resultHash: resultMetadata.contentHash, resultMetadata,
          diffEvidenceId: evidence.evidenceId, descendantSnapshotId: descendant.id,
        });
        throw new SafeChangeAuthorityError('UNDECLARED_WORKSPACE_CHANGE', 'Repository changed outside the approved scope');
      }
      deps.proof.checkClaim({
        claimId: intent.claimId, attemptId: input.attemptId, generation: input.generation,
        evidenceIds: [evidence.evidenceId], state: 'verified',
      });
      const completedAt = Date.now();
      db.transaction(() => {
        assertAuthority(input);
        db.prepare(
          `UPDATE repository_change_records SET state='committed',result_hash=?,result_metadata_json=?,
           diff_evidence_id=?,descendant_snapshot_id=?,completed_at=? WHERE intent_id=?`,
        ).run(resultMetadata.contentHash,JSON.stringify(resultMetadata),evidence.evidenceId,descendant.id,completedAt,intent.intentId);
        db.prepare("UPDATE repository_change_intents SET state='committed',updated_at=? WHERE intent_id=?")
          .run(completedAt,intent.intentId);
      }).immediate();
      deps.appendJobEvent({
        jobId: input.jobId, attemptId: input.attemptId, generation: input.generation,
        type: 'repository.change_committed', payload: { intentId: intent.intentId, changeId, descendantSnapshotId: descendant.id, evidenceId: evidence.evidenceId },
        producer: input.producer, idempotencyKey: `repository-change-committed:${intent.intentId}`,
      });
      return getRecord(intent.intentId)!;
    },

    getIntent,
    getIntentForToolCall,
    getRecord,
    listRecords,
  };
}
