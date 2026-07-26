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

export interface JobExecutionContext {
  engine: JobEngine;
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  producer: string;
  controlAuthority?: JobControlAuthority;
}

const storage = new AsyncLocalStorage<JobExecutionContext>();

export function runWithJobExecutionContext<T>(context: JobExecutionContext, operation: () => T): T {
  return storage.run(context, operation);
}

export function currentJobExecutionContext(): JobExecutionContext | undefined {
  return storage.getStore();
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
  return { toolCallId, effectId: result.effectId ?? null, mutates: command.mutates };
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
    const result = await command.execute();
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
