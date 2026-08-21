/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Db } from '../daemon/db/connection';
import type { JobProofAuthority } from '../daemon/jobProofAuthority';
import type { RepositorySnapshotAuthority, RepositorySnapshotRecord } from '../codebase/repositorySnapshotAuthority';
import type { ExternalCodingSessionAuthority } from './sessionAuthority';
import type { ExternalCodingCandidateResult } from './types';
import type { ExternalCodingWorkspaceAuthority } from './workspaceAuthority';
import { realpathWithFallback } from '../sandboxFs';

const execFileAsync = promisify(execFile);

export type ExternalCodingMutationState =
  | 'prepared' | 'observed' | 'verified' | 'rejected' | 'unknown' | 'reconciliation_required';

export interface ExternalCodingMutationReceipt {
  readonly receiptId: string;
  readonly codingSessionId: string;
  readonly workspaceLeaseId: string;
  readonly preSnapshotId: string;
  readonly postSnapshotId: string | null;
  readonly changedPaths: readonly string[];
  readonly protectedPathViolations: readonly string[];
  readonly unexpectedPaths: readonly string[];
  readonly reportedFiles: readonly string[];
  readonly reportMismatch: boolean;
  readonly reportedResultDigest: string | null;
  readonly observedDiffDigest: string | null;
  readonly state: ExternalCodingMutationState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ExternalCodingReconciliationTruth {
  readonly actualOutcomeKnown: boolean;
  readonly providerReportMatches: boolean;
  readonly actualChangedFiles: readonly string[];
  readonly reportedChangedFiles: readonly string[];
  readonly mismatchReasons: readonly string[];
  readonly protectedPathsIntact: boolean;
  readonly workspaceContained: boolean;
  readonly safeForIndependentValidation: boolean;
}

interface ChildAuthority {
  childJobId: string;
  childAttemptId: string;
  childGeneration: number;
  childFenceToken: string;
}

interface MutationAuthorityDeps {
  db: Db;
  sessions: ExternalCodingSessionAuthority;
  workspaces: ExternalCodingWorkspaceAuthority;
  repository: RepositorySnapshotAuthority;
  proof: JobProofAuthority;
}

export interface ExternalCodingMutationAuthority {
  captureBaseline(input: ChildAuthority & {
    codingSessionId: string;
    producer: string;
    now?: number;
  }): Promise<RepositorySnapshotRecord>;
  reconcile(input: ChildAuthority & {
    codingSessionId: string;
    reportedResult: ExternalCodingCandidateResult;
    producer: string;
    now?: number;
  }): Promise<ExternalCodingMutationReceipt>;
  markVerified(input: ChildAuthority & {
    codingSessionId: string;
    receiptId: string;
    validationRefs: readonly string[];
    producer: string;
    now?: number;
  }): ExternalCodingMutationReceipt;
  get(receiptId: string): ExternalCodingMutationReceipt | null;
  getForSession(codingSessionId: string): ExternalCodingMutationReceipt | null;
}

interface ReceiptRow {
  receipt_id: string;
  coding_session_id: string;
  workspace_lease_id: string;
  pre_snapshot_id: string;
  post_snapshot_id: string | null;
  changed_paths_json: string;
  protected_path_violations_json: string;
  unexpected_paths_json: string;
  reported_files_json: string;
  report_mismatch: number;
  reported_result_digest: string | null;
  observed_diff_digest: string | null;
  state: ExternalCodingMutationState;
  created_at: number;
  updated_at: number;
}

export class ExternalCodingMutationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalCodingMutationError';
  }
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

function normalize(value: string): string {
  const slashed = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  const normalized = path.posix.normalize(slashed);
  return (normalized === '.' ? '' : normalized).replace(/\/$/, '');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))].sort();
}

function parse(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === 'string')) : [];
  } catch { return []; }
}

function mapReceipt(row: ReceiptRow): ExternalCodingMutationReceipt {
  return {
    receiptId: row.receipt_id,
    codingSessionId: row.coding_session_id,
    workspaceLeaseId: row.workspace_lease_id,
    preSnapshotId: row.pre_snapshot_id,
    postSnapshotId: row.post_snapshot_id,
    changedPaths: parse(row.changed_paths_json),
    protectedPathViolations: parse(row.protected_path_violations_json),
    unexpectedPaths: parse(row.unexpected_paths_json),
    reportedFiles: parse(row.reported_files_json),
    reportMismatch: row.report_mismatch === 1,
    reportedResultDigest: row.reported_result_digest,
    observedDiffDigest: row.observed_diff_digest,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pathMatches(pathname: string, pattern: string): boolean {
  const pathValue = normalize(pathname);
  const policy = normalize(pattern);
  if (!policy) return false;
  if (!policy.includes('*')) return pathValue === policy || pathValue.startsWith(`${policy}/`);
  const expression = policy.split(/(\*\*)|(\*)/g).filter((part) => part !== undefined && part !== '')
    .map((part) => part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('');
  return new RegExp(`^${expression}$`).test(pathValue);
}

export function normalizeExternalCodingReportedFiles(
  values: readonly string[],
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const root = normalize(worktreePath);
  const caseInsensitive = platform === 'win32' || /^[A-Za-z]:\//u.test(root);
  const comparable = (value: string) => caseInsensitive ? value.toLocaleLowerCase('en-US') : value;
  const rootKey = comparable(root);
  const normalized = values.map((value) => {
    const normalized = normalize(value);
    const key = comparable(normalized);
    if (key === rootKey) return '';
    if (key.startsWith(`${rootKey}/`)) return normalized.slice(root.length + 1);
    return normalized;
  }).filter(Boolean);
  const uniqueByIdentity = new Map<string, string>();
  for (const value of normalized) {
    const key = comparable(value);
    if (!uniqueByIdentity.has(key)) uniqueByIdentity.set(key, value);
  }
  return [...uniqueByIdentity.values()].sort();
}

function sameSet(
  left: readonly string[],
  right: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const comparable = (value: string) => platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  const leftValues = left.map(comparable).sort();
  const rightValues = right.map(comparable).sort();
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index]);
}

export function externalCodingReconciliationTruth(
  receipt: ExternalCodingMutationReceipt,
): ExternalCodingReconciliationTruth {
  const actual = new Set(receipt.changedPaths);
  const reported = new Set(receipt.reportedFiles);
  const mismatchReasons = receipt.reportMismatch
    ? [
        ...receipt.changedPaths.filter((value) => !reported.has(value)).map((value) => `not_reported:${value}`),
        ...receipt.reportedFiles.filter((value) => !actual.has(value)).map((value) => `not_observed:${value}`),
      ]
    : [];
  const actualOutcomeKnown = ['observed', 'verified', 'rejected'].includes(receipt.state);
  const protectedPathsIntact = receipt.protectedPathViolations.length === 0;
  const workspaceContained = receipt.unexpectedPaths.length === 0;
  return {
    actualOutcomeKnown,
    providerReportMatches: !receipt.reportMismatch,
    actualChangedFiles: receipt.changedPaths,
    reportedChangedFiles: receipt.reportedFiles,
    mismatchReasons,
    protectedPathsIntact,
    workspaceContained,
    safeForIndependentValidation: actualOutcomeKnown
      && receipt.state !== 'rejected'
      && protectedPathsIntact
      && workspaceContained,
  };
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
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
}

async function gitOutput(root: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-c', 'color.ui=false', '-C', root, ...args], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: gitEnvironment(),
    });
    return result.stdout;
  } catch {
    return null;
  }
}

function nulPaths(raw: string | null): string[] {
  return raw === null ? [] : unique(raw.split('\0').filter(Boolean));
}

async function inspectGitWorkspace(lease: {
  sourcePath: string;
  worktreePath: string;
  baseHead: string;
}): Promise<{ changedPaths: string[]; metadataViolations: string[]; incomplete: boolean }> {
  const [head, branch, staged, tracked, untracked, common, sourceCommon] = await Promise.all([
    gitOutput(lease.worktreePath, ['rev-parse', '--verify', 'HEAD']),
    gitOutput(lease.worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitOutput(lease.worktreePath, ['diff', '--cached', '--name-only', '-z']),
    gitOutput(lease.worktreePath, ['diff', '--name-only', '-z', 'HEAD']),
    gitOutput(lease.worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']),
    gitOutput(lease.worktreePath, ['rev-parse', '--git-common-dir']),
    gitOutput(lease.sourcePath, ['rev-parse', '--git-common-dir']),
  ]);
  const incomplete = [head, staged, tracked, untracked, common, sourceCommon].some((value) => value === null);
  const violations: string[] = [];
  if (head !== null && head.trim() !== lease.baseHead) violations.push('.git/HEAD');
  if (branch !== null && branch.trim() !== '') violations.push('.git/HEAD');
  if (staged !== null && nulPaths(staged).length > 0) violations.push('.git/index');
  if (common !== null && sourceCommon !== null) {
    const worktreeCommon = realpathWithFallback(path.resolve(lease.worktreePath, common.trim()));
    const canonicalSourceCommon = realpathWithFallback(path.resolve(lease.sourcePath, sourceCommon.trim()));
    const same = process.platform === 'win32'
      ? worktreeCommon.toLowerCase() === canonicalSourceCommon.toLowerCase()
      : worktreeCommon === canonicalSourceCommon;
    if (!same) violations.push('.git');
  }
  return {
    changedPaths: unique([...nulPaths(tracked), ...nulPaths(untracked)]),
    metadataViolations: unique(violations),
    incomplete,
  };
}

export function createExternalCodingMutationAuthority(deps: MutationAuthorityDeps): ExternalCodingMutationAuthority {
  const get = (receiptId: string): ExternalCodingMutationReceipt | null => {
    const row = deps.db.prepare('SELECT * FROM external_coding_mutation_receipts WHERE receipt_id=?')
      .get(receiptId) as ReceiptRow | undefined;
    return row ? mapReceipt(row) : null;
  };
  const forSession = (codingSessionId: string): ExternalCodingMutationReceipt | null => {
    const row = deps.db.prepare('SELECT * FROM external_coding_mutation_receipts WHERE coding_session_id=?')
      .get(codingSessionId) as ReceiptRow | undefined;
    return row ? mapReceipt(row) : null;
  };
  const sessionFor = (input: ChildAuthority & { codingSessionId: string }) => {
    const session = deps.sessions.get(input.codingSessionId);
    if (!session
      || session.childJobId !== input.childJobId
      || session.childAttemptId !== input.childAttemptId
      || session.childGeneration !== input.childGeneration) {
      throw new ExternalCodingMutationError('SESSION_LINEAGE_MISMATCH', 'Coding mutation lineage does not match');
    }
    return session;
  };

  return {
    async captureBaseline(input) {
      const session = sessionFor(input);
      if (session.preSnapshotId) {
        const prior = deps.repository.getSnapshot(session.preSnapshotId);
        if (!prior) throw new ExternalCodingMutationError('BASELINE_MISSING', 'Persisted coding baseline snapshot is missing');
        return prior;
      }
      const lease = deps.workspaces.get(session.workspaceLeaseId);
      if (!lease || lease.state !== 'ready') {
        throw new ExternalCodingMutationError('WORKSPACE_NOT_READY', 'Coding workspace is not ready for baseline capture');
      }
      const snapshot = await deps.repository.captureSnapshot({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
        fenceToken: input.childFenceToken,
        requestedPath: lease.worktreePath,
        producer: input.producer,
      });
      if (snapshot.incomplete) throw new ExternalCodingMutationError('INCOMPLETE_BASELINE', 'Coding baseline snapshot is incomplete');
      deps.sessions.attachSnapshots({ ...input, preSnapshotId: snapshot.id });
      return snapshot;
    },
    async reconcile(input) {
      const session = sessionFor(input);
      const existing = forSession(input.codingSessionId);
      if (existing) return existing;
      if (!session.preSnapshotId) throw new ExternalCodingMutationError('BASELINE_REQUIRED', 'Coding baseline must be captured before execution');
      const baseline = deps.repository.getSnapshot(session.preSnapshotId);
      if (!baseline) throw new ExternalCodingMutationError('BASELINE_MISSING', 'Persisted coding baseline snapshot is missing');
      const lease = deps.workspaces.get(session.workspaceLeaseId);
      if (!lease || lease.state === 'released' || lease.state === 'failed') {
        throw new ExternalCodingMutationError('WORKSPACE_NOT_AVAILABLE', 'Coding workspace is unavailable for reconciliation');
      }
      const post = await deps.repository.captureSnapshot({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
        fenceToken: input.childFenceToken,
        requestedPath: lease.worktreePath,
        producer: input.producer,
        ...(baseline.attemptId === input.childAttemptId && baseline.generation === input.childGeneration
          ? { previousSnapshotId: session.preSnapshotId }
          : {}),
      });
      const comparison = deps.repository.compareSnapshots(session.preSnapshotId, post.id);
      const git = await inspectGitWorkspace(lease);
      const changedPaths = unique([...comparison.added, ...comparison.removed, ...comparison.changed, ...git.changedPaths]);
      const protectedPaths = unique([...lease.protectedPaths, ...session.taskEnvelope.protectedPaths]);
      const protectedPathViolations = unique([
        ...changedPaths.filter((item) => protectedPaths.some((policy) => pathMatches(item, policy))),
        ...git.metadataViolations,
      ]);
      const unexpectedPaths = changedPaths.filter((item) => !session.taskEnvelope.allowedScope.some((policy) => pathMatches(item, policy))
        && !protectedPathViolations.includes(item));
      const reportedFiles = normalizeExternalCodingReportedFiles(input.reportedResult.reportedFiles, lease.worktreePath);
      const reportMismatch = !sameSet(changedPaths, reportedFiles);
      const reportedResultDigest = digest(input.reportedResult);
      const observedDiffDigest = digest({ ...comparison, changedPaths });
      const state: ExternalCodingMutationState = protectedPathViolations.length > 0 || unexpectedPaths.length > 0
          ? 'rejected'
        : post.incomplete || git.incomplete || input.reportedResult.externalOutcome === 'unknown'
          ? 'unknown'
          : 'observed';
      const receiptId = `coding_mutation_${randomBytes(16).toString('hex')}`;
      const now = input.now ?? Date.now();
      deps.db.prepare(
        `INSERT INTO external_coding_mutation_receipts
           (receipt_id,coding_session_id,workspace_lease_id,pre_snapshot_id,post_snapshot_id,
            changed_paths_json,protected_path_violations_json,unexpected_paths_json,
            reported_files_json,report_mismatch,reported_result_digest,observed_diff_digest,
            state,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        receiptId, input.codingSessionId, session.workspaceLeaseId, session.preSnapshotId, post.id,
        JSON.stringify(changedPaths), JSON.stringify(protectedPathViolations), JSON.stringify(unexpectedPaths),
        JSON.stringify(reportedFiles), reportMismatch ? 1 : 0, reportedResultDigest, observedDiffDigest,
        state, now, now,
      );
      deps.sessions.attachSnapshots({ ...input, postSnapshotId: post.id, now });
      deps.sessions.attachResult({ ...input, resultRef: receiptId, now });
      deps.proof.recordEvidence({
        jobId: input.childJobId,
        attemptId: input.childAttemptId,
        generation: input.childGeneration,
        fenceToken: input.childFenceToken,
        repositorySnapshotId: post.id,
        source: 'external-coding.diff',
        producer: input.producer,
        observedAt: now,
        coverage: post.incomplete ? 'partial' : 'full',
        verificationResult: state === 'rejected' ? 'failed' : state === 'unknown' ? 'unknown' : 'partial',
        payload: {
          receiptId,
          changedPaths,
          protectedPathViolations,
          unexpectedPaths,
          reportedFiles,
          reportMismatch,
          reportedResultDigest,
          observedDiffDigest,
          gitInspectionIncomplete: git.incomplete,
          gitMetadataViolations: git.metadataViolations,
        },
        now,
      });
      deps.sessions.appendEvent({
        ...input,
        type: 'reconciliation.completed',
        payload: { receiptId, state, changedPaths: changedPaths.length, reportMismatch },
        idempotencyKey: `coding-mutation-reconciled:${receiptId}`,
      });
      if (state === 'rejected') {
        const current = deps.sessions.get(input.codingSessionId)!;
        if (current.state === 'preparing' || current.state === 'starting' || current.state === 'running'
          || current.state === 'process_terminal' || current.state === 'verification_pending') {
          deps.sessions.transition({
            ...input,
            to: 'failed',
            producer: input.producer,
            idempotencyKey: `coding-mutation-rejected:${receiptId}`,
            now,
          });
        }
      }
      return get(receiptId)!;
    },
    markVerified(input) {
      sessionFor(input);
      const current = get(input.receiptId);
      if (!current || current.codingSessionId !== input.codingSessionId) {
        throw new ExternalCodingMutationError('RECEIPT_NOT_FOUND', 'Coding mutation receipt lineage does not match');
      }
      if (current.state === 'verified') return current;
      if (current.state !== 'observed') {
        throw new ExternalCodingMutationError(
          'MUTATION_NOT_VERIFIABLE',
          `Coding mutation receipt cannot be verified from state ${current.state}`,
        );
      }
      if (input.validationRefs.length === 0) {
        throw new ExternalCodingMutationError('VALIDATION_REQUIRED', 'Fresh validation evidence is required');
      }
      const now = input.now ?? Date.now();
      deps.db.prepare(
        `UPDATE external_coding_mutation_receipts SET state='verified',updated_at=?
          WHERE receipt_id=? AND coding_session_id=? AND state='observed'`,
      ).run(now, input.receiptId, input.codingSessionId);
      deps.sessions.appendEvent({
        ...input,
        type: 'verification.completed',
        payload: { receiptId: input.receiptId, state: 'verified', validationRefCount: input.validationRefs.length },
        idempotencyKey: `coding-mutation-verified:${input.receiptId}`,
      });
      return get(input.receiptId)!;
    },
    get,
    getForSession: forSession,
  };
}
