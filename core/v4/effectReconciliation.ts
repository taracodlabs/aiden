/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { promises as fs, readFileSync, statSync } from 'node:fs';

import type { EffectReconciliationData, EffectRetrySafety } from './effectContract';

export type EffectReconciliationOutcome = 'occurred' | 'did_not_occur' | 'partially_occurred' | 'unknown';
export type EffectReconciliationConfidence = 'high' | 'medium' | 'low';
export type EffectRetryRecommendation = 'retry_same_identity' | 'do_not_retry' | 'human_review';

export interface EffectReconciliationInput {
  effectId: string;
  kind: string;
  target: string | null;
  retrySafety: EffectRetrySafety;
  idempotencyKey: string | null;
  reconciliationData: EffectReconciliationData | null;
}

export interface EffectReconciliationResult {
  outcome: EffectReconciliationOutcome;
  confidence: EffectReconciliationConfidence;
  evidence: Record<string, unknown>;
  retryRecommendation: EffectRetryRecommendation;
  humanResolutionRequired: boolean;
}

export interface FileObservation {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  contentSha256?: string;
}

export async function observeFile(path: string): Promise<FileObservation> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    const bytes = await fs.readFile(path);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

export function observeFileSync(path: string): FileObservation {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    const bytes = readFileSync(path);
    return {
      exists: true, size: stat.size, mtimeMs: stat.mtimeMs,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

function unknown(evidence: Record<string, unknown>): EffectReconciliationResult {
  return {
    outcome: 'unknown', confidence: 'low', evidence,
    retryRecommendation: 'human_review', humanResolutionRequired: true,
  };
}

/** Conservative readback for filesystem effects. Other effect kinds remain unknown. */
export async function reconcileFilesystemEffect(
  effect: EffectReconciliationInput,
): Promise<EffectReconciliationResult> {
  const path = effect.reconciliationData?.path ?? effect.target;
  return reconcileFilesystemObservation(effect, path ? await observeFile(path) : null);
}

export function reconcileFilesystemEffectSync(effect: EffectReconciliationInput): EffectReconciliationResult {
  const path = effect.reconciliationData?.path ?? effect.target;
  return reconcileFilesystemObservation(effect, path ? observeFileSync(path) : null);
}

function reconcileFilesystemObservation(
  effect: EffectReconciliationInput,
  current: FileObservation | null,
): EffectReconciliationResult {
  const data = effect.reconciliationData;
  if (!effect.kind.startsWith('filesystem.') || !data) {
    return unknown({ reason: 'no_supported_reconciler', effectKind: effect.kind });
  }
  const path = data.path ?? effect.target;
  if (!path) return unknown({ reason: 'missing_safe_target', effectKind: effect.kind });
  if (!current) return unknown({ reason: 'missing_safe_target', effectKind: effect.kind });
  const evidence: Record<string, unknown> = {
    exists: current.exists,
    ...(current.size !== undefined ? { size: current.size } : {}),
    ...(current.mtimeMs !== undefined ? { mtimeMs: current.mtimeMs } : {}),
    ...(current.contentSha256 ? { contentSha256: current.contentSha256 } : {}),
    ...(data.before ? { before: data.before } : {}),
    after: current,
  };

  if (effect.kind === 'filesystem.write') {
    if (
      current.exists
      && data.expectedContentSha256
      && current.contentSha256 === data.expectedContentSha256
      && (data.expectedSize === undefined || current.size === data.expectedSize)
    ) {
      return {
        outcome: 'occurred', confidence: 'high', evidence,
        retryRecommendation: 'do_not_retry', humanResolutionRequired: false,
      };
    }
    if (!current.exists && data.before?.exists === false) {
      return {
        outcome: 'did_not_occur', confidence: 'high', evidence,
        retryRecommendation: effect.idempotencyKey ? 'retry_same_identity' : 'human_review',
        humanResolutionRequired: !effect.idempotencyKey,
      };
    }
  }

  return unknown(evidence);
}
