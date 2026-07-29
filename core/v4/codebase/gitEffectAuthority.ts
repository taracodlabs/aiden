/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Db } from '../daemon/db/connection';
import type { AttemptRecord, JobRecord, TransitionResult } from '../daemon/jobEngine';
import type { JobProofAuthority } from '../daemon/jobProofAuthority';
import type {
  EffectReconciliationConfidence,
  EffectReconciliationOutcome,
  EffectRetryRecommendation,
} from '../effectReconciliation';
import { isWithin, realpathWithFallback } from '../sandboxFs';
import type { RepositorySnapshotAuthority, RepositorySnapshotRecord } from './repositorySnapshotAuthority';

export type GitEffectKind =
  | 'branch_create' | 'branch_switch' | 'stage' | 'unstage' | 'commit'
  | 'fetch' | 'pull' | 'push' | 'tag' | 'pr_create' | 'merge' | 'remote_branch_delete';

export interface GitEffectPlan {
  kind: GitEffectKind;
  targetRef?: string;
  baseRef?: string;
  remote?: string;
  ownedPaths?: string[];
  expectedOldRef?: string | null;
  expectedNewRef?: string | null;
  expectedTreeHash?: string | null;
  message?: string;
  title?: string;
  body?: string;
  idempotencyKey: string;
}

export interface GitIndexState {
  stagedPaths: string[];
  treeHash: string | null;
  ownedEntries: Record<string, string | null>;
}

export type GitEffectState = 'prepared' | 'executing' | 'succeeded' | 'failed' | 'unknown' | 'reconciled';

export interface GitEffectRecord {
  operationId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  toolCallId: string;
  effectId: string | null;
  approvalId: string | null;
  actionDigest: string | null;
  repositorySnapshotId: string;
  resultingSnapshotId: string | null;
  kind: GitEffectKind;
  repositoryRoot: string;
  baseCommit: string;
  currentBranch: string | null;
  targetRef: string | null;
  expectedOldRef: string | null;
  expectedNewRef: string | null;
  remote: string | null;
  remoteIdentity: string | null;
  ownedPaths: string[];
  indexState: GitIndexState;
  expectedTreeHash: string | null;
  resultingTreeHash: string | null;
  commitHash: string | null;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  idempotencyKey: string;
  planDigest: string;
  reconciliationStrategy: string;
  reconciliationOutcome: 'occurred' | 'did_not_occur' | 'partially_occurred' | 'unknown' | null;
  externalReference: string | null;
  evidenceId: string | null;
  state: GitEffectState;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface PullRequestObservation {
  externalReference: string;
  headCommit: string;
  state: 'open' | 'merged' | 'closed';
}

export interface GitEffectIo {
  beforeMutation?: (record: GitEffectRecord) => Promise<void>;
  afterMutation?: (record: GitEffectRecord) => Promise<void>;
  findPullRequest?: (input: {
    repositoryRoot: string; remote: string | null; headRef: string;
    baseRef: string; idempotencyKey: string;
  }) => Promise<PullRequestObservation | null>;
  createPullRequest?: (input: {
    repositoryRoot: string; remote: string | null; headRef: string; baseRef: string;
    title: string; body: string; headCommit: string; idempotencyKey: string;
  }) => Promise<PullRequestObservation>;
}

export interface GitEffectAuthority {
  prepare(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    toolCallId: string; repositorySnapshotId: string; plan: GitEffectPlan; producer: string;
  }): Promise<GitEffectRecord>;
  bindEffect(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    operationId: string; effectId: string;
  }): GitEffectRecord;
  bindApproval(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    operationId: string; effectId: string; approvalId: string; actionDigest: string;
  }): GitEffectRecord;
  execute(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    operationId: string; effectId: string; approvalId: string; actionDigest: string;
    plan: GitEffectPlan; producer: string; signal?: AbortSignal;
  }): Promise<GitEffectRecord>;
  reconcile(input: {
    operationId: string; producer: string; idempotencyKey: string;
  }): Promise<GitEffectRecord>;
  get(operationId: string): GitEffectRecord | undefined;
  list(jobId: string): GitEffectRecord[];
}

export class GitEffectAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'GitEffectAuthorityError';
  }
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
  recordEffectReconciliation(command: {
    effectId: string; expectedJobStateVersion: number;
    outcome: EffectReconciliationOutcome;
    confidence: EffectReconciliationConfidence; evidence: Record<string, unknown>;
    retryRecommendation: EffectRetryRecommendation;
    humanResolutionRequired: boolean; producer: string; idempotencyKey: string; now?: number;
  }): TransitionResult;
}

interface GitResult { stdout: string; stderr: string }
interface GitObservation {
  outcome: EffectReconciliationOutcome;
  evidence: Record<string, unknown>;
  resultingTreeHash?: string | null;
  commitHash?: string | null;
  externalReference?: string | null;
}

const AUTHOR = Object.freeze({ name: 'Shiva Deore', email: 'shiva.deore111@gmail.com' });
const HASH = 'sha256';
const SECRET_PATH = /(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx))$/i;
const SECRET_VALUE = /(?:api[_-]?key|token|secret|password|authorization|credential)\s*[:=]\s*\S+/i;
const REMOTE_KINDS = new Set<GitEffectKind>(['fetch', 'pull', 'push', 'pr_create', 'remote_branch_delete']);
const TARGET_KINDS = new Set<GitEffectKind>([
  'branch_create', 'branch_switch', 'fetch', 'pull', 'push', 'tag', 'pr_create', 'merge', 'remote_branch_delete',
]);
const LOCAL_SNAPSHOT_KINDS = new Set<GitEffectKind>([
  'branch_create', 'branch_switch', 'stage', 'unstage', 'commit', 'fetch', 'pull', 'tag', 'merge',
]);

const makeId = (prefix: string): string => `${prefix}_${randomBytes(16).toString('hex')}`;
const normalizeRelative = (value: string): string => value.split(path.sep).join('/').replace(/^\.\//, '');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

function stableJson(value: unknown): string { return JSON.stringify(canonical(value)); }
function digest(value: unknown): string { return createHash(HASH).update(stableJson(value)).digest('hex'); }
function isTerminal(status: string): boolean {
  return ['succeeded', 'completed', 'failed', 'cancelled', 'timed_out', 'crashed', 'unknown', 'interrupted'].includes(status);
}

function sanitizeRemoteIdentity(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { return `remote_${digest(value)}`; }
  }
  if (/^[^@\s]+@[^:]+:.+$/.test(value)) {
    const hostAndPath = value.slice(value.indexOf('@') + 1);
    return `ssh://${hostAndPath.replace(':', '/')}`;
  }
  return realpathWithFallback(value);
}

function validateRef(value: string | undefined, field: string): string {
  const ref = value?.trim() ?? '';
  if (!ref || ref.length > 255 || /[\s\0~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.startsWith('-')) {
    throw new GitEffectAuthorityError('GIT_INVALID_REF', `${field} is not a safe Git ref`);
  }
  return ref;
}

function validatePlan(plan: GitEffectPlan): void {
  if (!plan.idempotencyKey || plan.idempotencyKey.length > 256 || /[\r\n\0]/.test(plan.idempotencyKey)) {
    throw new GitEffectAuthorityError('GIT_INVALID_PLAN', 'A stable Git idempotency key is required');
  }
  if (TARGET_KINDS.has(plan.kind)) validateRef(plan.targetRef, 'targetRef');
  if (plan.kind === 'pr_create') validateRef(plan.baseRef, 'baseRef');
  if (REMOTE_KINDS.has(plan.kind) && (!plan.remote || plan.remote.startsWith('-') || /[\r\n\0]/.test(plan.remote))) {
    throw new GitEffectAuthorityError('GIT_INVALID_PLAN', 'A Git remote is required');
  }
  if (['stage', 'unstage', 'commit'].includes(plan.kind) && (!plan.ownedPaths || plan.ownedPaths.length === 0)) {
    throw new GitEffectAuthorityError('GIT_INVALID_PLAN', 'Exact owned paths are required');
  }
  if (plan.kind === 'commit' && (!plan.message || /[\0]/.test(plan.message))) {
    throw new GitEffectAuthorityError('GIT_INVALID_PLAN', 'A commit message is required');
  }
  if (plan.kind === 'pr_create' && (!plan.title || /[\r\n\0]/.test(plan.title))) {
    throw new GitEffectAuthorityError('GIT_INVALID_PLAN', 'A pull request title is required');
  }
  if ([plan.message, plan.title, plan.body].some((value) => value && SECRET_VALUE.test(value))) {
    throw new GitEffectAuthorityError('GIT_SECRET_CONTENT_REJECTED', 'Git public metadata cannot contain credential values');
  }
}

function normalizeOwnedPaths(root: string, values: readonly string[] = []): string[] {
  const normalized = [...new Set(values.map((value) => normalizeRelative(value.trim())))].sort();
  for (const relative of normalized) {
    const lexical = path.resolve(root, relative);
    if (!relative || path.isAbsolute(relative) || relative === '.git' || relative.startsWith('.git/')
      || !isWithin(lexical, root) || /[\r\n\0]/.test(relative)) {
      throw new GitEffectAuthorityError('GIT_PATH_OUTSIDE_REPOSITORY', 'Owned Git paths must stay inside the repository');
    }
    if (SECRET_PATH.test(relative)) {
      throw new GitEffectAuthorityError('GIT_SECRET_PATH_REJECTED', 'Secret-bearing paths cannot be included in a Git Effect');
    }
  }
  return normalized;
}

function runGit(
  root: string,
  args: readonly string[],
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'color.ui=false', '-C', root, ...args], {
      windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      signal: options.signal,
      env: {
        ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C',
        ...options.env,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new GitEffectAuthorityError('GIT_COMMAND_FAILED', 'Git command failed before a verified result was observed'));
        return;
      }
      resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
    });
  });
}

async function readGit(root: string, args: readonly string[]): Promise<string | null> {
  try { return (await runGit(root, args)).stdout; }
  catch { return null; }
}

function parseNul(value: string | null): string[] {
  return value ? value.split('\0').filter(Boolean).map(normalizeRelative).sort() : [];
}

async function headCommit(root: string): Promise<string> {
  const value = await readGit(root, ['rev-parse', 'HEAD']);
  if (!value) throw new GitEffectAuthorityError('GIT_REPOSITORY_UNAVAILABLE', 'Repository HEAD is unavailable');
  return value;
}

async function currentBranch(root: string): Promise<string | null> {
  return readGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

async function indexState(root: string, ownedPaths: readonly string[]): Promise<GitIndexState> {
  const stagedPaths = parseNul(await readGit(root, ['diff', '--cached', '--name-only', '-z']));
  const treeHash = await readGit(root, ['write-tree']);
  const ownedEntries: Record<string, string | null> = {};
  for (const relative of ownedPaths) {
    const line = await readGit(root, ['ls-files', '--stage', '--', relative]);
    ownedEntries[relative] = line ? line.split(/\s+/)[1] ?? null : null;
  }
  return { stagedPaths, treeHash, ownedEntries };
}

async function remoteRef(root: string, remote: string, targetRef: string): Promise<string | null> {
  const line = await readGit(root, ['ls-remote', '--heads', remote, `refs/heads/${targetRef}`]);
  return line ? line.split(/\s+/)[0] ?? null : null;
}

async function localRef(root: string, ref: string): Promise<string | null> {
  return readGit(root, ['rev-parse', '--verify', ref]);
}

function mapRecord(row: Record<string, unknown>): GitEffectRecord {
  return {
    operationId: String(row.operation_id), jobId: String(row.job_id), attemptId: String(row.attempt_id),
    generation: Number(row.generation), fenceToken: String(row.fence_token), toolCallId: String(row.tool_call_id),
    effectId: row.effect_id === null ? null : String(row.effect_id),
    approvalId: row.approval_id === null ? null : String(row.approval_id),
    actionDigest: row.action_digest === null ? null : String(row.action_digest),
    repositorySnapshotId: String(row.repository_snapshot_id),
    resultingSnapshotId: row.resulting_snapshot_id === null ? null : String(row.resulting_snapshot_id),
    kind: row.kind as GitEffectKind, repositoryRoot: String(row.repository_root), baseCommit: String(row.base_commit),
    currentBranch: row.current_branch === null ? null : String(row.current_branch),
    targetRef: row.target_ref === null ? null : String(row.target_ref),
    expectedOldRef: row.expected_old_ref === null ? null : String(row.expected_old_ref),
    expectedNewRef: row.expected_new_ref === null ? null : String(row.expected_new_ref),
    remote: row.remote_name === null ? null : String(row.remote_name),
    remoteIdentity: row.remote_identity === null ? null : String(row.remote_identity),
    ownedPaths: JSON.parse(String(row.owned_paths_json)) as string[],
    indexState: JSON.parse(String(row.index_state_json)) as GitIndexState,
    expectedTreeHash: row.expected_tree_hash === null ? null : String(row.expected_tree_hash),
    resultingTreeHash: row.resulting_tree_hash === null ? null : String(row.resulting_tree_hash),
    commitHash: row.commit_hash === null ? null : String(row.commit_hash),
    author: { name: String(row.author_name), email: String(row.author_email) },
    committer: { name: String(row.committer_name), email: String(row.committer_email) },
    idempotencyKey: String(row.idempotency_key), planDigest: String(row.plan_digest),
    reconciliationStrategy: String(row.reconciliation_strategy),
    reconciliationOutcome: row.reconciliation_outcome as GitEffectRecord['reconciliationOutcome'],
    externalReference: row.external_reference === null ? null : String(row.external_reference),
    evidenceId: row.evidence_id === null ? null : String(row.evidence_id), state: row.state as GitEffectState,
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    createdAt: Number(row.created_at), startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at), updatedAt: Number(row.updated_at),
  };
}

function rootFor(snapshot: RepositorySnapshotRecord): string {
  if (snapshot.vcsKind !== 'git' || !snapshot.repositoryRoot) {
    throw new GitEffectAuthorityError('GIT_REPOSITORY_REQUIRED', 'This operation requires a Git repository snapshot');
  }
  return realpathWithFallback(snapshot.repositoryRoot);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

export function createGitEffectAuthority(deps: Deps, io: GitEffectIo = {}): GitEffectAuthority {
  const { db } = deps;
  const get = (operationId: string): GitEffectRecord | undefined => {
    const row = db.prepare('SELECT * FROM git_effect_operations WHERE operation_id=?')
      .get(operationId) as Record<string, unknown> | undefined;
    return row ? mapRecord(row) : undefined;
  };

  const assertAuthority = (input: { jobId: string; attemptId: string; generation: number; fenceToken: string }): void => {
    const job = deps.getJob(input.jobId);
    const attempt = deps.getAttempt(input.attemptId);
    if (!job || !attempt || attempt.jobId !== job.id || job.activeAttemptId !== attempt.id || isTerminal(job.status)
      || attempt.generation !== input.generation || attempt.fenceToken !== input.fenceToken
      || attempt.leaseExpiresAt === null || attempt.leaseExpiresAt <= Date.now() || isTerminal(attempt.status)) {
      throw new GitEffectAuthorityError('STALE_GIT_AUTHORITY', 'Attempt generation or fence no longer owns this Git operation');
    }
  };

  const updateFailure = (record: GitEffectRecord, state: 'failed' | 'unknown', code: string, message: string): void => {
    const now = Date.now();
    db.prepare(
      `UPDATE git_effect_operations SET state=?,error_code=?,error_message=?,completed_at=?,updated_at=?
        WHERE operation_id=?`,
    ).run(state, code, message, now, now, record.operationId);
  };

  const assertBindings = (input: {
    jobId: string; attemptId: string; generation: number; operationId: string;
    effectId: string; approvalId: string; actionDigest: string; plan: GitEffectPlan;
  }): GitEffectRecord => {
    const record = get(input.operationId);
    if (!record || record.jobId !== input.jobId || record.attemptId !== input.attemptId
      || record.generation !== input.generation) {
      throw new GitEffectAuthorityError('GIT_OPERATION_NOT_FOUND', 'Git operation is outside the active Attempt');
    }
    if (record.planDigest !== digest(input.plan)) {
      throw new GitEffectAuthorityError('GIT_APPROVED_PLAN_MISMATCH', 'Git execution differs from the approved operation');
    }
    if (record.effectId !== input.effectId || record.approvalId !== input.approvalId
      || record.actionDigest !== input.actionDigest) {
      throw new GitEffectAuthorityError('GIT_APPROVAL_BINDING_MISMATCH', 'Git execution is not bound to the exact Effect and approval');
    }
    return record;
  };

  const assertExecutable = (record: GitEffectRecord): void => {
    const approval = db.prepare(
      `SELECT state,job_id,attempt_id,generation,tool_call_id,effect_id,action_digest
         FROM approvals WHERE approval_id=?`,
    ).get(record.approvalId) as Record<string, unknown> | undefined;
    if (!approval || approval.state !== 'executed' || approval.job_id !== record.jobId
      || approval.attempt_id !== record.attemptId || Number(approval.generation) !== record.generation
      || approval.tool_call_id !== record.toolCallId || approval.effect_id !== record.effectId
      || approval.action_digest !== record.actionDigest) {
      throw new GitEffectAuthorityError('GIT_APPROVAL_NOT_EXECUTABLE', 'Exact Git approval was not revalidated for execution');
    }
    const effect = db.prepare(
      'SELECT job_id,attempt_id,generation,tool_call_id,effect_state FROM side_effect_ledger WHERE key=?',
    ).get(record.effectId) as Record<string, unknown> | undefined;
    if (!effect || effect.job_id !== record.jobId || effect.attempt_id !== record.attemptId
      || Number(effect.generation) !== record.generation || effect.tool_call_id !== record.toolCallId
      || effect.effect_state !== 'started') {
      throw new GitEffectAuthorityError('GIT_EFFECT_NOT_EXECUTABLE', 'Producing Git Effect is not active');
    }
  };

  const assertRepositoryState = async (record: GitEffectRecord): Promise<void> => {
    const root = realpathWithFallback(record.repositoryRoot);
    if (!samePath(root, record.repositoryRoot)) {
      throw new GitEffectAuthorityError('GIT_REPOSITORY_IDENTITY_CHANGED', 'Repository identity changed after approval');
    }
    const liveBranch = await currentBranch(root);
    if (liveBranch !== record.currentBranch) {
      throw new GitEffectAuthorityError('GIT_BRANCH_DRIFT', 'Current branch changed after approval');
    }
    const liveHead = await headCommit(root);
    if (liveHead !== record.baseCommit) {
      throw new GitEffectAuthorityError('GIT_HEAD_DRIFT', 'Repository HEAD changed after approval');
    }
  };

  const assertOwnedSource = async (record: GitEffectRecord): Promise<void> => {
    if (record.kind === 'commit' || record.kind === 'unstage') {
      const current = await indexState(record.repositoryRoot, record.ownedPaths);
      for (const relative of record.ownedPaths) {
        if (current.ownedEntries[relative] !== record.indexState.ownedEntries[relative]) {
          throw new GitEffectAuthorityError('GIT_INDEX_DRIFT', 'Owned index content changed after approval');
        }
      }
      return;
    }
    if (record.kind !== 'stage') return;
    for (const relative of record.ownedPaths) {
      const entry = deps.repository.getEntry(record.repositorySnapshotId, relative);
      const absolute = path.resolve(record.repositoryRoot, relative);
      if (!entry || !isWithin(absolute, record.repositoryRoot)) {
        throw new GitEffectAuthorityError('GIT_OWNED_PATH_NOT_CAPTURED', 'Owned path was not captured by the approved snapshot');
      }
      const bytes = await fs.readFile(absolute);
      if (createHash(HASH).update(bytes).digest('hex') !== entry.contentHash) {
        throw new GitEffectAuthorityError('GIT_OWNED_PATH_DRIFT', 'Owned path changed after approval');
      }
    }
  };

  const observe = async (record: GitEffectRecord, plan?: GitEffectPlan): Promise<GitObservation> => {
    const root = record.repositoryRoot;
    if (record.kind === 'stage' || record.kind === 'unstage') {
      const current = await indexState(root, record.ownedPaths);
      const present = record.ownedPaths.filter((item) => current.stagedPaths.includes(item));
      const occurred = record.kind === 'stage' ? present.length === record.ownedPaths.length : present.length === 0;
      const didNotOccur = record.kind === 'stage' ? present.length === 0 : present.length === record.ownedPaths.length;
      return {
        outcome: occurred ? 'occurred' : didNotOccur ? 'did_not_occur' : 'partially_occurred',
        evidence: { kind: record.kind, ownedPaths: record.ownedPaths, stagedOwnedPaths: present },
        resultingTreeHash: current.treeHash,
      };
    }
    if (record.kind === 'branch_create') {
      const observed = await localRef(root, `refs/heads/${record.targetRef}`);
      return { outcome: observed === record.expectedNewRef ? 'occurred' : observed === null ? 'did_not_occur' : 'unknown', evidence: { targetRef: record.targetRef, observedRef: observed } };
    }
    if (record.kind === 'branch_switch') {
      const observed = await currentBranch(root);
      return { outcome: observed === record.targetRef ? 'occurred' : observed === record.currentBranch ? 'did_not_occur' : 'unknown', evidence: { targetRef: record.targetRef, observedBranch: observed } };
    }
    if (record.kind === 'commit') {
      const observed = await headCommit(root);
      if (observed === record.baseCommit) return { outcome: 'did_not_occur', evidence: { observedHead: observed } };
      const tree = await localRef(root, `${observed}^{tree}`);
      const paths = parseNul(await readGit(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', observed]));
      const identity = await readGit(root, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', observed]);
      const expectedIdentity = `${AUTHOR.name}\0${AUTHOR.email}\0${AUTHOR.name}\0${AUTHOR.email}`;
      const exactScope = paths.length > 0 && paths.every((item) => record.ownedPaths.includes(item));
      const treeMatches = !record.expectedTreeHash || tree === record.expectedTreeHash;
      const occurred = identity === expectedIdentity && exactScope && treeMatches;
      return {
        outcome: occurred ? 'occurred' : 'unknown',
        evidence: { observedHead: observed, treeHash: tree, paths, identityMatches: identity === expectedIdentity },
        resultingTreeHash: tree, commitHash: observed,
      };
    }
    if (record.kind === 'fetch') {
      const observed = await localRef(root, `refs/remotes/${record.remote}/${record.targetRef}`);
      return { outcome: observed === record.expectedNewRef ? 'occurred' : 'unknown', evidence: { observedRef: observed, targetRef: record.targetRef } };
    }
    if (record.kind === 'pull' || record.kind === 'merge') {
      const observed = await headCommit(root);
      return { outcome: observed === record.expectedNewRef ? 'occurred' : observed === record.baseCommit ? 'did_not_occur' : 'unknown', evidence: { observedHead: observed }, commitHash: observed };
    }
    if (record.kind === 'push') {
      const observed = await remoteRef(root, record.remote!, record.targetRef!);
      return { outcome: observed === record.expectedNewRef ? 'occurred' : observed === record.expectedOldRef ? 'did_not_occur' : 'unknown', evidence: { observedRef: observed, targetRef: record.targetRef } };
    }
    if (record.kind === 'tag') {
      const observed = await localRef(root, `refs/tags/${record.targetRef}`);
      return { outcome: observed === record.expectedNewRef ? 'occurred' : observed === null ? 'did_not_occur' : 'unknown', evidence: { observedRef: observed, targetRef: record.targetRef } };
    }
    if (record.kind === 'remote_branch_delete') {
      const observed = await remoteRef(root, record.remote!, record.targetRef!);
      return { outcome: observed === null ? 'occurred' : observed === record.expectedOldRef ? 'did_not_occur' : 'unknown', evidence: { observedRef: observed, targetRef: record.targetRef } };
    }
    if (!io.findPullRequest) return { outcome: 'unknown', evidence: { reason: 'pull_request_observer_unavailable' } };
    const observed = await io.findPullRequest({
      repositoryRoot: root, remote: record.remote, headRef: record.targetRef!,
      baseRef: plan?.baseRef ?? '', idempotencyKey: record.idempotencyKey,
    });
    return {
      outcome: observed && observed.headCommit === record.baseCommit ? 'occurred' : observed ? 'unknown' : 'did_not_occur',
      evidence: { externalReference: observed?.externalReference ?? null, state: observed?.state ?? null },
      externalReference: observed?.externalReference ?? null,
    };
  };

  return {
    async prepare(input) {
      assertAuthority(input);
      validatePlan(input.plan);
      const snapshot = deps.repository.getSnapshot(input.repositorySnapshotId);
      if (!snapshot || snapshot.jobId !== input.jobId || snapshot.attemptId !== input.attemptId
        || snapshot.generation !== input.generation) {
        throw new GitEffectAuthorityError('GIT_INVALID_SNAPSHOT', 'Repository snapshot is outside the active Attempt');
      }
      const root = rootFor(snapshot);
      const planDigest = digest(input.plan);
      const duplicate = db.prepare(
        'SELECT * FROM git_effect_operations WHERE job_id=? AND idempotency_key=?',
      ).get(input.jobId, input.plan.idempotencyKey) as Record<string, unknown> | undefined;
      if (duplicate) {
        const existing = mapRecord(duplicate);
        if (existing.planDigest !== planDigest) {
          throw new GitEffectAuthorityError('GIT_IDEMPOTENCY_CONFLICT', 'Git idempotency key is already bound to different inputs');
        }
        return existing;
      }
      const baseCommit = await headCommit(root);
      const branch = await currentBranch(root);
      if (snapshot.headCommit !== baseCommit || snapshot.branch !== branch) {
        throw new GitEffectAuthorityError('GIT_SNAPSHOT_DRIFT', 'Live Git state differs from the approved repository snapshot');
      }
      const ownedPaths = normalizeOwnedPaths(root, input.plan.ownedPaths);
      const currentIndex = await indexState(root, ownedPaths);
      let remoteIdentity: string | null = null;
      if (input.plan.remote) {
        const remoteUrl = await readGit(root, ['remote', 'get-url', input.plan.remote]);
        if (!remoteUrl) throw new GitEffectAuthorityError('GIT_REMOTE_NOT_FOUND', 'Configured Git remote is unavailable');
        remoteIdentity = sanitizeRemoteIdentity(remoteUrl);
      }
      let expectedOldRef = input.plan.expectedOldRef ?? null;
      let expectedNewRef = input.plan.expectedNewRef ?? null;
      if (input.plan.kind === 'branch_create' || input.plan.kind === 'tag' || input.plan.kind === 'push') {
        expectedNewRef ??= baseCommit;
      }
      if (input.plan.kind === 'push' || input.plan.kind === 'remote_branch_delete') {
        const observed = await remoteRef(root, input.plan.remote!, input.plan.targetRef!);
        if (input.plan.expectedOldRef !== undefined && observed !== expectedOldRef) {
          throw new GitEffectAuthorityError('GIT_REMOTE_REF_DRIFT', 'Remote ref differs from the expected approved value');
        }
        expectedOldRef = observed;
      }
      const operationId = makeId('git_effect');
      const now = Date.now();
      db.prepare(
        `INSERT INTO git_effect_operations (
          operation_id,job_id,attempt_id,generation,fence_token,tool_call_id,effect_id,approval_id,action_digest,
          repository_snapshot_id,resulting_snapshot_id,kind,repository_root,base_commit,current_branch,target_ref,
          expected_old_ref,expected_new_ref,remote_name,remote_identity,owned_paths_json,index_state_json,
          expected_tree_hash,resulting_tree_hash,commit_hash,author_name,author_email,committer_name,committer_email,
          idempotency_key,plan_digest,reconciliation_strategy,reconciliation_outcome,external_reference,evidence_id,
          state,error_code,error_message,created_at,started_at,completed_at,updated_at
        ) VALUES (
          @operationId,@jobId,@attemptId,@generation,@fenceToken,@toolCallId,NULL,NULL,NULL,
          @repositorySnapshotId,NULL,@kind,@repositoryRoot,@baseCommit,@currentBranch,@targetRef,
          @expectedOldRef,@expectedNewRef,@remoteName,@remoteIdentity,@ownedPathsJson,@indexStateJson,
          @expectedTreeHash,NULL,NULL,@authorName,@authorEmail,@committerName,@committerEmail,
          @idempotencyKey,@planDigest,'query_then_retry',NULL,NULL,NULL,
          'prepared',NULL,NULL,@createdAt,NULL,NULL,@updatedAt
        )`,
      ).run({
        operationId, jobId: input.jobId, attemptId: input.attemptId, generation: input.generation,
        fenceToken: input.fenceToken, toolCallId: input.toolCallId,
        repositorySnapshotId: input.repositorySnapshotId, kind: input.plan.kind,
        repositoryRoot: root, baseCommit, currentBranch: branch, targetRef: input.plan.targetRef ?? null,
        expectedOldRef, expectedNewRef, remoteName: input.plan.remote ?? null, remoteIdentity,
        ownedPathsJson: JSON.stringify(ownedPaths), indexStateJson: JSON.stringify(currentIndex),
        expectedTreeHash: input.plan.expectedTreeHash ?? null,
        authorName: AUTHOR.name, authorEmail: AUTHOR.email,
        committerName: AUTHOR.name, committerEmail: AUTHOR.email,
        idempotencyKey: input.plan.idempotencyKey, planDigest, createdAt: now, updatedAt: now,
      });
      deps.appendJobEvent({
        jobId: input.jobId, attemptId: input.attemptId, generation: input.generation,
        type: 'git.effect_prepared', payload: { operationId, kind: input.plan.kind, repositorySnapshotId: snapshot.id },
        producer: input.producer, idempotencyKey: `git-effect-prepared:${operationId}`,
      });
      return get(operationId)!;
    },

    bindEffect(input) {
      assertAuthority(input);
      const record = get(input.operationId);
      if (!record || record.jobId !== input.jobId || record.attemptId !== input.attemptId
        || record.generation !== input.generation) {
        throw new GitEffectAuthorityError('GIT_OPERATION_NOT_FOUND', 'Git operation is outside the active Attempt');
      }
      const effect = db.prepare('SELECT job_id,attempt_id,generation,tool_call_id FROM side_effect_ledger WHERE key=?')
        .get(input.effectId) as Record<string, unknown> | undefined;
      if (!effect || effect.job_id !== input.jobId || effect.attempt_id !== input.attemptId
        || Number(effect.generation) !== input.generation || effect.tool_call_id !== record.toolCallId) {
        throw new GitEffectAuthorityError('GIT_EFFECT_BINDING_MISMATCH', 'Effect does not match the planned Git operation');
      }
      if (record.effectId && record.effectId !== input.effectId) {
        throw new GitEffectAuthorityError('GIT_EFFECT_BINDING_MISMATCH', 'Git operation already has a different Effect');
      }
      db.prepare('UPDATE git_effect_operations SET effect_id=?,updated_at=? WHERE operation_id=?')
        .run(input.effectId, Date.now(), input.operationId);
      return get(input.operationId)!;
    },

    bindApproval(input) {
      assertAuthority(input);
      const record = get(input.operationId);
      if (!record || record.effectId !== input.effectId) {
        throw new GitEffectAuthorityError('GIT_EFFECT_BINDING_MISMATCH', 'Git operation is not bound to this Effect');
      }
      const approval = db.prepare(
        'SELECT job_id,attempt_id,generation,tool_call_id,effect_id,action_digest FROM approvals WHERE approval_id=?',
      ).get(input.approvalId) as Record<string, unknown> | undefined;
      if (!approval || approval.job_id !== input.jobId || approval.attempt_id !== input.attemptId
        || Number(approval.generation) !== input.generation || approval.tool_call_id !== record.toolCallId
        || approval.effect_id !== input.effectId || approval.action_digest !== input.actionDigest) {
        throw new GitEffectAuthorityError('GIT_APPROVAL_BINDING_MISMATCH', 'Approval does not match the exact Git operation');
      }
      if ((record.approvalId && record.approvalId !== input.approvalId)
        || (record.actionDigest && record.actionDigest !== input.actionDigest)) {
        throw new GitEffectAuthorityError('GIT_APPROVAL_BINDING_MISMATCH', 'Git operation already has a different approval');
      }
      db.prepare('UPDATE git_effect_operations SET approval_id=?,action_digest=?,updated_at=? WHERE operation_id=?')
        .run(input.approvalId, input.actionDigest, Date.now(), input.operationId);
      return get(input.operationId)!;
    },

    async execute(input) {
      const record = assertBindings(input);
      if (record.state === 'succeeded' || record.state === 'reconciled') return record;
      if (record.state === 'unknown') {
        throw new GitEffectAuthorityError('GIT_OUTCOME_UNRESOLVED', 'Unknown Git outcome must reconcile before retry');
      }
      if (record.state !== 'prepared') {
        throw new GitEffectAuthorityError('GIT_OPERATION_NOT_EXECUTABLE', 'Git operation is not in a prepared state');
      }
      assertAuthority(input);
      assertExecutable(record);
      if (input.signal?.aborted) {
        updateFailure(record, 'failed', 'GIT_CANCELLED', 'Git operation was cancelled before execution');
        throw new GitEffectAuthorityError('GIT_CANCELLED', 'Git operation was cancelled before execution');
      }
      await assertRepositoryState(record);
      await assertOwnedSource(record);
      if (record.kind === 'push' || record.kind === 'remote_branch_delete') {
        const observed = await remoteRef(record.repositoryRoot, record.remote!, record.targetRef!);
        if (observed !== record.expectedOldRef) {
          throw new GitEffectAuthorityError('GIT_REMOTE_REF_DRIFT', 'Remote ref advanced after approval');
        }
      }
      const startedAt = Date.now();
      db.prepare("UPDATE git_effect_operations SET state='executing',started_at=?,updated_at=? WHERE operation_id=? AND state='prepared'")
        .run(startedAt, startedAt, record.operationId);
      let externalReference: string | null = null;
      try {
        await io.beforeMutation?.(get(record.operationId)!);
        const root = record.repositoryRoot;
        if (record.kind === 'stage') {
          await runGit(root, ['add', '--', ...record.ownedPaths], { signal: input.signal });
        } else if (record.kind === 'unstage') {
          await runGit(root, ['restore', '--staged', '--', ...record.ownedPaths], { signal: input.signal });
        } else if (record.kind === 'commit') {
          const current = await indexState(root, record.ownedPaths);
          if (!record.ownedPaths.every((item) => current.stagedPaths.includes(item))) {
            throw new GitEffectAuthorityError('GIT_OWNED_PATH_NOT_STAGED', 'Every owned commit path must be staged');
          }
          await runGit(root, [
            '-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`,
            'commit', '--only', '-m', input.plan.message!, '--', ...record.ownedPaths,
          ], {
            signal: input.signal,
            env: {
              GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email,
              GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email,
            },
          });
        } else if (record.kind === 'branch_create') {
          await runGit(root, ['branch', record.targetRef!, record.expectedNewRef!], { signal: input.signal });
        } else if (record.kind === 'branch_switch') {
          await runGit(root, ['switch', record.targetRef!], { signal: input.signal });
        } else if (record.kind === 'fetch') {
          await runGit(root, ['fetch', record.remote!, record.targetRef!], { signal: input.signal });
        } else if (record.kind === 'pull') {
          await runGit(root, ['pull', '--ff-only', record.remote!, record.targetRef!], { signal: input.signal });
        } else if (record.kind === 'push') {
          await runGit(root, ['push', record.remote!, `${record.expectedNewRef}:refs/heads/${record.targetRef}`], { signal: input.signal });
        } else if (record.kind === 'tag') {
          await runGit(root, ['tag', record.targetRef!, record.expectedNewRef!], { signal: input.signal });
        } else if (record.kind === 'merge') {
          await runGit(root, ['merge', '--ff-only', record.targetRef!], { signal: input.signal });
        } else if (record.kind === 'remote_branch_delete') {
          await runGit(root, ['push', record.remote!, '--delete', record.targetRef!], { signal: input.signal });
        } else {
          if (!io.findPullRequest || !io.createPullRequest) {
            throw new GitEffectAuthorityError('GIT_REMOTE_ADAPTER_UNAVAILABLE', 'Pull request integration is unavailable');
          }
          const lookup = {
            repositoryRoot: root, remote: record.remote, headRef: record.targetRef!,
            baseRef: input.plan.baseRef!, idempotencyKey: record.idempotencyKey,
          };
          const existing = await io.findPullRequest(lookup);
          const created = existing ?? await io.createPullRequest({
            ...lookup, title: input.plan.title!, body: input.plan.body ?? '',
            headCommit: record.baseCommit,
          });
          if (created.headCommit !== record.baseCommit) {
            throw new GitEffectAuthorityError('GIT_REMOTE_REF_DRIFT', 'Pull request head differs from the approved commit');
          }
          externalReference = created.externalReference;
        }
      } catch (error) {
        const safe = error instanceof GitEffectAuthorityError
          ? error : new GitEffectAuthorityError('GIT_COMMAND_FAILED', 'Git command failed before a verified result was observed');
        if (input.signal?.aborted) {
          updateFailure(record, 'unknown', 'GIT_OUTCOME_UNKNOWN', 'Cancellation raced with a Git mutation');
          throw new GitEffectAuthorityError('GIT_OUTCOME_UNKNOWN', 'Git outcome requires reconciliation after cancellation');
        }
        updateFailure(record, 'failed', safe.code, safe.message);
        throw safe;
      }

      try { await io.afterMutation?.(get(record.operationId)!); }
      catch {
        updateFailure(record, 'unknown', 'GIT_OUTCOME_UNKNOWN', 'Git result was not observed after mutation');
        throw new GitEffectAuthorityError('GIT_OUTCOME_UNKNOWN', 'Git outcome requires reconciliation');
      }
      if (input.signal?.aborted) {
        updateFailure(record, 'unknown', 'GIT_OUTCOME_UNKNOWN', 'Cancellation raced with a Git mutation');
        throw new GitEffectAuthorityError('GIT_OUTCOME_UNKNOWN', 'Git outcome requires reconciliation after cancellation');
      }

      const observation = await observe(record, input.plan);
      if (externalReference) observation.externalReference = externalReference;
      if (observation.outcome !== 'occurred') {
        updateFailure(record, 'unknown', 'GIT_OUTCOME_UNKNOWN', 'Fresh Git readback did not prove the approved result');
        throw new GitEffectAuthorityError('GIT_OUTCOME_UNKNOWN', 'Git outcome requires reconciliation after readback');
      }
      let descendantSnapshotId: string | null = null;
      if (LOCAL_SNAPSHOT_KINDS.has(record.kind)) {
        try {
          const descendant = await deps.repository.captureSnapshot({
            jobId: record.jobId, attemptId: record.attemptId, generation: record.generation,
            fenceToken: input.fenceToken, requestedPath: record.repositoryRoot,
            previousSnapshotId: record.repositorySnapshotId, producer: input.producer,
          });
          descendantSnapshotId = descendant.id;
        } catch {
          updateFailure(record, 'unknown', 'GIT_DESCENDANT_SNAPSHOT_FAILED', 'Git result could not be bound to a descendant snapshot');
          throw new GitEffectAuthorityError('GIT_OUTCOME_UNKNOWN', 'Git outcome requires reconciliation after snapshot capture failure');
        }
      }
      const observedAt = Date.now();
      const evidence = deps.proof.recordEvidence({
        jobId: record.jobId, attemptId: record.attemptId, generation: record.generation,
        fenceToken: input.fenceToken, effectId: record.effectId, source: 'git.effect.readback',
        producer: input.producer, observedAt, freshUntil: observedAt + 60_000,
        coverage: 'full', verificationResult: 'verified', payload: {
          operationId: record.operationId, kind: record.kind, repositorySnapshotId: record.repositorySnapshotId,
          resultingSnapshotId: descendantSnapshotId, targetRef: record.targetRef,
          expectedOldRef: record.expectedOldRef, expectedNewRef: record.expectedNewRef,
          observed: observation.evidence,
        },
      });
      db.transaction(() => {
        assertAuthority(input);
        const now = Date.now();
        db.prepare(
          `UPDATE git_effect_operations SET state='succeeded',reconciliation_outcome='occurred',
             resulting_snapshot_id=?,resulting_tree_hash=?,commit_hash=?,external_reference=?,evidence_id=?,
             error_code=NULL,error_message=NULL,completed_at=?,updated_at=? WHERE operation_id=? AND state='executing'`,
        ).run(
          descendantSnapshotId,observation.resultingTreeHash??null,observation.commitHash??null,
          observation.externalReference??null,evidence.evidenceId,now,now,record.operationId,
        );
      }).immediate();
      deps.appendJobEvent({
        jobId: record.jobId, attemptId: record.attemptId, generation: record.generation,
        type: 'git.effect_succeeded', payload: { operationId: record.operationId, kind: record.kind, evidenceId: evidence.evidenceId },
        producer: input.producer, idempotencyKey: `git-effect-succeeded:${record.operationId}`,
      });
      return get(record.operationId)!;
    },

    async reconcile(input) {
      const record = get(input.operationId);
      if (!record) throw new GitEffectAuthorityError('GIT_OPERATION_NOT_FOUND', 'Git operation does not exist');
      if (record.reconciliationOutcome === 'occurred' && record.state === 'reconciled') return record;
      if (record.state !== 'unknown') {
        throw new GitEffectAuthorityError('GIT_RECONCILIATION_NOT_REQUIRED', 'Git operation is not awaiting reconciliation');
      }
      const observation = await observe(record);
      const job = deps.getJob(record.jobId);
      if (!job) throw new GitEffectAuthorityError('GIT_JOB_NOT_FOUND', 'Producing Job is unavailable');
      const recommendation: EffectRetryRecommendation = observation.outcome === 'did_not_occur' ? 'retry_same_identity'
        : observation.outcome === 'occurred' ? 'do_not_retry' : 'human_review';
      const result = deps.recordEffectReconciliation({
        effectId: record.effectId!, expectedJobStateVersion: job.stateVersion,
        outcome: observation.outcome, confidence: observation.outcome === 'unknown' ? 'low' : 'high',
        evidence: { operationId: record.operationId, kind: record.kind, ...observation.evidence },
        retryRecommendation: recommendation,
        humanResolutionRequired: observation.outcome === 'unknown' || observation.outcome === 'partially_occurred',
        producer: input.producer, idempotencyKey: input.idempotencyKey,
      });
      if (!result.applied && !result.duplicate) {
        throw new GitEffectAuthorityError('GIT_RECONCILIATION_CONFLICT', `Effect reconciliation failed: ${result.conflict ?? 'unknown'}`);
      }
      const state: GitEffectState = observation.outcome === 'unknown' || observation.outcome === 'partially_occurred'
        ? 'unknown' : 'reconciled';
      const now = Date.now();
      db.prepare(
        `UPDATE git_effect_operations SET state=?,reconciliation_outcome=?,resulting_tree_hash=?,commit_hash=?,
           external_reference=?,error_code=NULL,error_message=NULL,completed_at=?,updated_at=? WHERE operation_id=?`,
      ).run(
        state,observation.outcome,observation.resultingTreeHash??null,observation.commitHash??null,
        observation.externalReference??record.externalReference,now,now,record.operationId,
      );
      deps.appendJobEvent({
        jobId: record.jobId, attemptId: record.attemptId, generation: record.generation,
        type: 'git.effect_reconciled', payload: { operationId: record.operationId, outcome: observation.outcome },
        producer: input.producer, idempotencyKey: `git-effect-reconciled:${record.operationId}:${input.idempotencyKey}`,
      });
      return get(record.operationId)!;
    },

    get,
    list(jobId) {
      return (db.prepare('SELECT * FROM git_effect_operations WHERE job_id=? ORDER BY created_at,operation_id')
        .all(jobId) as Record<string, unknown>[]).map(mapRecord);
    },
  };
}
