/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type EffectClassification =
  | 'read_only'
  | 'idempotent_mutation'
  | 'reconcilable_mutation'
  | 'unsafe_mutation'
  | 'unknown_mutation';

export type EffectRetrySafety =
  | 'same_idempotency_key'
  | 'reconcile_before_retry'
  | 'never_automatic';

export type EffectApprovalRequirement = 'none' | 'policy' | 'always';

export interface EffectReconciliationData {
  path?: string;
  sourcePath?: string;
  destinationPath?: string;
  expectedContentSha256?: string;
  expectedSize?: number;
  before?: {
    exists: boolean;
    size?: number;
    mtimeMs?: number;
    contentSha256?: string;
  };
  sourceBefore?: { exists: boolean; size?: number; mtimeMs?: number; contentSha256?: string };
  destinationBefore?: { exists: boolean; size?: number; mtimeMs?: number; contentSha256?: string };
}

export interface ToolEffectContract {
  classification: Exclude<EffectClassification, 'read_only'>;
  kind: string;
  retrySafety: EffectRetrySafety;
  idempotencySupported: boolean;
  reconciliationSupported: boolean;
  verificationSupported: boolean;
  approvalRequirement: EffectApprovalRequirement;
  sensitiveFields: readonly string[];
  redactionRules: readonly string[];
  target(args: Readonly<Record<string, unknown>>): string | null;
  reconciliationData?(args: Readonly<Record<string, unknown>>, cwd: string): EffectReconciliationData | null;
}

export interface DurableEffectDescriptor {
  classification: EffectClassification;
  kind: string;
  target: string | null;
  retrySafety: EffectRetrySafety;
  idempotencySupported: boolean;
  reconciliationSupported: boolean;
  verificationSupported: boolean;
  approvalRequirement: EffectApprovalRequirement;
  sensitiveFields: readonly string[];
  redactionRules: readonly string[];
  trusted: boolean;
  reconciliationData: EffectReconciliationData | null;
}

export const UNKNOWN_MUTATION_EFFECT_CONTRACT = Object.freeze({
  classification: 'unknown_mutation' as const,
  kind: 'unknown',
  retrySafety: 'never_automatic' as const,
  idempotencySupported: false,
  reconciliationSupported: false,
  verificationSupported: false,
  approvalRequirement: 'always' as const,
  sensitiveFields: Object.freeze([] as string[]),
  redactionRules: Object.freeze(['digest_arguments', 'omit_values']),
});

interface EffectBearingHandler {
  mutates?: boolean;
  effectContract?: ToolEffectContract;
}

function safeTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n\0]/.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { return null; }
  }
  if (/(?:api[_-]?key|token|secret|password|authorization|credential)\s*=/i.test(trimmed)) return null;
  return trimmed;
}

export function describeToolEffect(
  handler: EffectBearingHandler,
  args: Readonly<Record<string, unknown>>,
  cwd = process.cwd(),
): DurableEffectDescriptor {
  if (handler.mutates === false) {
    return {
      classification: 'read_only',
      kind: 'none',
      target: null,
      retrySafety: 'never_automatic',
      idempotencySupported: false,
      reconciliationSupported: false,
      verificationSupported: false,
      approvalRequirement: 'policy',
      sensitiveFields: [],
      redactionRules: [],
      trusted: true,
      reconciliationData: null,
    };
  }
  const contract = handler.effectContract;
  if (!contract) {
    return {
      ...UNKNOWN_MUTATION_EFFECT_CONTRACT,
      target: null,
      trusted: false,
      reconciliationData: null,
    };
  }
  let target: string | null = null;
  try { target = safeTarget(contract.target(args)); } catch { target = null; }
  let reconciliationData: EffectReconciliationData | null = null;
  try { reconciliationData = contract.reconciliationData?.(args, cwd) ?? null; } catch { reconciliationData = null; }
  return {
    classification: contract.classification,
    kind: contract.kind,
    target,
    retrySafety: contract.retrySafety,
    idempotencySupported: contract.idempotencySupported,
    reconciliationSupported: contract.reconciliationSupported,
    verificationSupported: contract.verificationSupported,
    approvalRequirement: contract.approvalRequirement,
    sensitiveFields: [...contract.sensitiveFields],
    redactionRules: [...contract.redactionRules],
    trusted: true,
    reconciliationData,
  };
}
