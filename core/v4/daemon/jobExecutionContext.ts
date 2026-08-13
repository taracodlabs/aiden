/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

import type { JobEngine, TransitionResult } from './jobEngine';
import type { JobControlAuthority } from './jobControlAuthority';
import type { DurableEffectDescriptor } from '../effectContract';
import type { RepositorySnapshotAuthority } from '../codebase/repositorySnapshotAuthority';
import type { SafeChangeAuthority } from '../codebase/safeChangeAuthority';
import type {
  StructuredValidationAuthority,
  ValidationEnvironment,
} from '../codebase/structuredValidationAuthority';

export interface RepositoryExecutionBinding {
  rootPath: string;
  inspection: {
    snapshotId: string;
    rootPath: string;
    authority: RepositorySnapshotAuthority;
  };
  change: {
    baseSnapshotId: string;
    rootPath: string;
    authority: SafeChangeAuthority;
  };
  validation: {
    baseSnapshotId: string;
    rootPath: string;
    authority: StructuredValidationAuthority;
    environment: ValidationEnvironment;
  };
  advance(snapshotId: string): void;
}

export interface JobExecutionContext {
  engine: JobEngine;
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  producer: string;
  signal?: AbortSignal;
  controlAuthority?: JobControlAuthority;
  workspacePath?: string;
  repository?: RepositoryExecutionBinding;
  repositoryPromise?: Promise<RepositoryExecutionBinding>;
  /** Source keys already promoted to Evidence during this Attempt. */
  researchEvidenceKeys?: Set<string>;
}

const storage = new AsyncLocalStorage<JobExecutionContext>();
const durableToolCallStorage = new AsyncLocalStorage<PreparedDurableToolCall>();

export function runWithJobExecutionContext<T>(context: JobExecutionContext, operation: () => T): T {
  return storage.run(context, operation);
}

export function currentJobExecutionContext(): JobExecutionContext | undefined {
  return storage.getStore();
}

/** Exact persisted ToolCall currently dispatching physical work. */
export function currentPreparedDurableToolCall(): PreparedDurableToolCall | undefined {
  return durableToolCallStorage.getStore();
}

/** Lazily bind repository tools to the exact active Attempt and source snapshot. */
export async function ensureRepositoryExecutionBinding(
  context: JobExecutionContext,
): Promise<RepositoryExecutionBinding | undefined> {
  if (context.repository) return context.repository;
  if (!context.workspacePath) return undefined;
  if (!context.repositoryPromise) {
    context.repositoryPromise = (async () => {
      const existing = context.engine.repository.getAttemptSnapshot(context.jobId, context.attemptId);
      const snapshot = existing ?? await context.engine.repository.captureSnapshot({
        jobId: context.jobId,
        attemptId: context.attemptId,
        generation: context.generation,
        fenceToken: context.fenceToken,
        requestedPath: context.workspacePath!,
        producer: context.producer,
      });
      const workspace = context.engine.repository.getWorkspace(snapshot.workspaceId);
      if (!workspace) throw new Error('Repository workspace binding is unavailable');
      const rootPath = snapshot.repositoryRoot ?? workspace.canonicalPath;
      const inspection = {
        snapshotId: snapshot.id,
        rootPath,
        authority: context.engine.repository,
      };
      const change = {
        baseSnapshotId: snapshot.id,
        rootPath,
        authority: context.engine.changes,
      };
      const validation = {
        baseSnapshotId: snapshot.id,
        rootPath,
        authority: context.engine.validation,
        environment: {
          platform: process.platform,
          architecture: process.arch,
          nodeVersion: process.version,
          npmVersion: process.env.npm_config_user_agent?.match(/\bnpm\/([^\s]+)/)?.[1] ?? 'unknown',
          variables: {
            CI: process.env.CI ?? '',
            NODE_ENV: process.env.NODE_ENV ?? '',
          },
        },
      };
      const binding: RepositoryExecutionBinding = {
        rootPath,
        inspection,
        change,
        validation,
        advance(snapshotId) {
          inspection.snapshotId = snapshotId;
          change.baseSnapshotId = snapshotId;
          validation.baseSnapshotId = snapshotId;
        },
      };
      context.repository = binding;
      return binding;
    })();
  }
  try {
    return await context.repositoryPromise;
  } catch (error) {
    context.repositoryPromise = undefined;
    throw error;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function normalizedArgsDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(args))).digest('hex');
}

function opaqueReference(prefix: string, value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalize(value));
  } catch {
    serialized = String(value);
  }
  return `${prefix}:sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function durableToolCallId(context: JobExecutionContext, modelCallId: string): string {
  return `tool-call:sha256:${createHash('sha256')
    .update(`${context.attemptId}\0${context.generation}\0${modelCallId}`)
    .digest('hex')}`;
}

/** Resolve the stable persisted ToolCall identity for the active Attempt. */
export function currentDurableToolCallId(modelCallId: string): string | null {
  const context = currentJobExecutionContext();
  return context ? durableToolCallId(context, modelCallId) : null;
}

export class DurableToolCallConflictError extends Error {
  constructor(readonly operation: string, readonly result: TransitionResult) {
    super(`Durable ToolCall ${operation} rejected: ${result.conflict ?? 'duplicate'}`);
    this.name = 'DurableToolCallConflictError';
  }
}

export interface PreparedDurableToolCall {
  toolCallId: string;
  effectId: string | null;
  mutates: boolean;
  effect?: DurableEffectDescriptor;
}

function requireApplied(operation: string, result: TransitionResult): void {
  if (!result.applied && !result.duplicate) {
    throw new DurableToolCallConflictError(operation, result);
  }
}

export function prepareDurableToolCall(command: {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskTier: string;
  mutates: boolean;
  effect?: DurableEffectDescriptor;
  approvalState?: 'not_required' | 'pending';
}): PreparedDurableToolCall | null {
  const context = currentJobExecutionContext();
  if (!context) return null;
  const toolCallId = durableToolCallId(context, command.toolCallId);
  const argsDigest = normalizedArgsDigest(command.args);
  const effect = command.mutates ? command.effect : undefined;
  const reconciliationData = effect?.reconciliationData ? { ...effect.reconciliationData } : null;
  if (reconciliationData?.path && effect?.kind.startsWith('filesystem.')) {
    try {
      if (!existsSync(reconciliationData.path)) {
        reconciliationData.before = { exists: false };
      } else {
        const stat = statSync(reconciliationData.path);
        reconciliationData.before = {
          exists: true,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ...(stat.isFile() ? {
            contentSha256: createHash('sha256').update(readFileSync(reconciliationData.path)).digest('hex'),
          } : {}),
        };
      }
    } catch {
      reconciliationData.before = undefined;
    }
  }
  const result = context.engine.prepareToolCall({
    toolCallId,
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    modelCallId: command.toolCallId,
    toolName: command.toolName,
    normalizedArgsDigest: argsDigest,
    riskTier: command.riskTier,
    mutates: command.mutates,
    effect: effect && effect.classification !== 'read_only' ? {
      classification: effect.classification,
      kind: effect.kind,
      target: effect.target,
      retrySafety: effect.retrySafety,
      idempotencySupported: effect.idempotencySupported,
      idempotencyKey: effect.idempotencySupported
        ? createHash('sha256').update(`${command.toolName}\0${argsDigest}`).digest('hex')
        : null,
      reconciliationSupported: effect.reconciliationSupported,
      verificationSupported: effect.verificationSupported,
      approvalRequirement: effect.approvalRequirement,
      approvalState: command.approvalState ?? 'not_required',
      sensitiveFields: effect.sensitiveFields,
      redactionRules: effect.redactionRules,
      trusted: effect.trusted,
      reconciliationData,
    } : undefined,
    producer: context.producer,
  });
  if (result.duplicate && command.mutates) {
    throw new DurableToolCallConflictError('duplicate mutation', result);
  }
  requireApplied('prepare', result);
  return {
    toolCallId,
    effectId: result.effectId ?? null,
    mutates: command.mutates,
    ...(effect ? { effect } : {}),
  };
}

function captureDurableFileProof(
  context: JobExecutionContext,
  prepared: PreparedDurableToolCall,
): void {
  const effect = prepared.effect;
  if (!prepared.effectId || effect?.kind !== 'filesystem.write' || !effect.verificationSupported) return;
  const expected = effect.reconciliationData;
  const target = expected?.path;
  const claim = context.engine.proof.createClaim({
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    category: 'contract',
    statement: `file write matches requested content: ${effect.target ?? target ?? 'target'}`,
    required: true,
  });
  let payload: Record<string, unknown> = { path: target ?? effect.target, exists: false, exact: false };
  let verificationResult: 'verified' | 'failed' | 'unknown' = 'unknown';
  let coverage: 'full' | 'unknown' = 'unknown';
  try {
    if (!target || !existsSync(target)) {
      payload = { ...payload, exists: false };
      verificationResult = 'failed';
      coverage = 'full';
    } else {
      const bytes = readFileSync(target);
      const stat = statSync(target);
      const contentSha256 = createHash('sha256').update(bytes).digest('hex');
      const exact = expected?.expectedContentSha256 !== undefined
        && expected.expectedSize !== undefined
        && contentSha256 === expected.expectedContentSha256
        && stat.size === expected.expectedSize;
      payload = { path: target, exists: true, size: stat.size, contentSha256, exact };
      verificationResult = exact ? 'verified' : 'failed';
      coverage = 'full';
    }
  } catch (error) {
    payload = {
      path: target ?? effect.target,
      exists: null,
      exact: null,
      captureError: error instanceof Error ? error.name : 'Error',
    };
  }
  const observedAt = Date.now();
  const evidence = context.engine.proof.recordEvidence({
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    effectId: prepared.effectId,
    source: 'filesystem.readback',
    producer: context.producer,
    observedAt,
    freshUntil: observedAt + 60_000,
    coverage,
    verificationResult,
    payload,
  });
  context.engine.proof.checkClaim({
    claimId: claim.claimId,
    attemptId: context.attemptId,
    generation: context.generation,
    evidenceIds: [evidence.evidenceId],
    state: verificationResult,
  });
}

export function recordDurableToolApproval(command: {
  prepared: PreparedDurableToolCall | null;
  state: 'not_required' | 'pending' | 'approved' | 'denied' | 'interrupted' | 'timed_out' | 'blocked';
  approvalId?: string | null;
  actionDigest?: string | null;
}): void {
  if (!command.prepared?.effectId) return;
  const context = currentJobExecutionContext();
  if (!context) return;
  requireApplied('approval', context.engine.resolveToolCallApproval({
    toolCallId: command.prepared.toolCallId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    state: command.state,
    approvalId: command.approvalId,
    actionDigest: command.actionDigest,
    producer: context.producer,
  }));
}

export async function executeWithDurableToolCall<T>(command: {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskTier: string;
  mutates: boolean;
  effect?: DurableEffectDescriptor;
  prepared?: PreparedDurableToolCall | null;
  execute: () => Promise<T>;
  isSuccessful?: (result: T) => boolean;
  captureFilesystemProof?: boolean;
}): Promise<T> {
  const context = currentJobExecutionContext();
  if (!context) return command.execute();

  const prepared = command.prepared ?? prepareDurableToolCall(command);
  if (!prepared) return command.execute();
  const toolCallId = prepared.toolCallId;
  requireApplied('start', context.engine.startToolCall({
    toolCallId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    producer: context.producer,
  }));

  try {
    const result = await durableToolCallStorage.run(prepared, command.execute);
    const succeeded = command.isSuccessful?.(result) ?? true;
    requireApplied('complete', context.engine.completeToolCall({
      toolCallId,
      attemptId: context.attemptId,
      generation: context.generation,
      fenceToken: context.fenceToken,
      state: succeeded ? 'completed' : 'failed',
      sideEffectState: command.mutates ? (succeeded ? 'committed' : 'unknown') : undefined,
      resultRef: opaqueReference('tool-result', result),
      producer: context.producer,
    }));
    if (succeeded && command.captureFilesystemProof !== false) captureDurableFileProof(context, prepared);
    return result;
  } catch (error) {
    const completion = context.engine.completeToolCall({
      toolCallId,
      attemptId: context.attemptId,
      generation: context.generation,
      fenceToken: context.fenceToken,
      state: 'failed',
      sideEffectState: command.mutates ? 'unknown' : undefined,
      producer: context.producer,
    });
    if (!completion.applied && !completion.duplicate) {
      throw new DurableToolCallConflictError('failure', completion);
    }
    throw error;
  }
}

export function recordDurableToolVerification(toolCallId: string, verification: unknown): void {
  const context = currentJobExecutionContext();
  if (!context) return;
  const persistedToolCallId = durableToolCallId(context, toolCallId);
  requireApplied('verification', context.engine.attachToolVerification({
    toolCallId: persistedToolCallId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    verificationRef: opaqueReference('tool-verification', verification),
    producer: context.producer,
  }));
}

const RESEARCH_EVIDENCE_TOOLS = new Set([
  'web_search',
  'fetch_url',
  'fetch_page',
  'youtube_search',
]);

const SENSITIVE_QUERY_PARAMETER = /^(?:token|api[_-]?key|access[_-]?token|auth(?:orization)?|key|secret|password)$/i;

function redactResearchText(value: string, limit = 2000): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|token|authorization|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

function sanitizeResearchValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactResearchText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 2) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeResearchValue(item, depth + 1));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).slice(0, 24).map((key) => [key, sanitizeResearchValue(record[key], depth + 1)]),
    );
  }
  return String(value);
}

function normalizedResearchSource(toolName: string, args: Record<string, unknown>): {
  key: string;
  source: string;
} {
  const candidate = typeof args.url === 'string'
    ? args.url.trim()
    : typeof args.query === 'string'
      ? args.query.trim()
      : '';
  if (candidate && /^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      url.hash = '';
      for (const key of Array.from(url.searchParams.keys())) {
        if (SENSITIVE_QUERY_PARAMETER.test(key)) url.searchParams.delete(key);
      }
      url.searchParams.sort();
      const normalized = url.toString().replace(/\/$/, '');
      return { key: `url:${normalized.toLowerCase()}`, source: normalized };
    } catch {
      // Fall through to a bounded tool/query key when the input is not a URL.
    }
  }
  const query = redactResearchText(candidate, 500).toLowerCase();
  return { key: `${toolName}:${query}`, source: query || toolName };
}

function researchResultSucceeded(result: unknown): boolean {
  if (!result || typeof result !== 'object') return result !== null && result !== undefined;
  const record = result as Record<string, unknown>;
  if (record.success === false) return false;
  if (typeof record.error === 'string' && record.error.trim() && record.success !== true) return false;
  return true;
}

/** Promote bounded, read-only research output into the existing Proof authority. */
export function recordDurableResearchEvidence(command: {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  observedAt?: number;
}): void {
  if (!RESEARCH_EVIDENCE_TOOLS.has(command.toolName) || !researchResultSucceeded(command.result)) return;
  const context = currentJobExecutionContext();
  if (!context) return;
  const source = normalizedResearchSource(command.toolName, command.args);
  const keys = context.researchEvidenceKeys ?? (context.researchEvidenceKeys = new Set<string>());
  if (keys.has(source.key)) return;
  keys.add(source.key);
  try {
    const observedAt = command.observedAt ?? Date.now();
    context.engine.proof.recordEvidence({
      jobId: context.jobId,
      attemptId: context.attemptId,
      generation: context.generation,
      fenceToken: context.fenceToken,
      effectId: null,
      source: `research.${command.toolName}`,
      producer: context.producer,
      observedAt,
      freshUntil: observedAt + 300_000,
      coverage: 'partial',
      verificationResult: 'unknown',
      payload: {
        source: source.source,
        toolCallId: command.toolCallId,
        durableToolCallId: durableToolCallId(context, command.toolCallId),
        arguments: sanitizeResearchValue(command.args),
        result: sanitizeResearchValue(command.result),
      },
    });
  } catch {
    // Evidence projection must never turn a successful read into a failed Job.
  }
}
