/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { JobBudgetKind } from '../daemon/jobResourceAuthority';
import type { ProviderAttemptRecord } from '../usageLedger';

export interface WorkerProviderUsageFact {
  kind: JobBudgetKind;
  amount: number | null;
  idempotencyKey: string;
}

function knownZero(attempt: ProviderAttemptRecord): boolean {
  return attempt.status === 'failed_before_send'
    || attempt.errorClass === 'rate_limit'
    || attempt.errorClass === 'authentication'
    || attempt.errorClass === 'context_overflow'
    || attempt.errorClass === 'request_size_limit';
}

export function workerProviderUsageValue(
  attempt: ProviderAttemptRecord,
  kind: JobBudgetKind,
): number | null {
  if (knownZero(attempt)) return 0;
  if (kind === 'input_tokens') return attempt.providerInputTokens;
  if (kind === 'output_tokens') return attempt.providerOutputTokens;
  if (kind === 'reasoning_tokens') return attempt.providerReasoningTokens;
  if (kind === 'external_cost') {
    if (attempt.costStatus === 'unknown') return null;
    return attempt.costStatus === 'included' ? 0 : attempt.costAmount;
  }
  if (kind === 'output_bytes') return attempt.responseBytes;
  return null;
}

export function workerProviderUsageFacts(
  logicalCallId: string,
  attempt: ProviderAttemptRecord,
  index: number,
): WorkerProviderUsageFact[] {
  const facts: WorkerProviderUsageFact[] = [{
    kind: 'model_calls',
    amount: 1,
    idempotencyKey: index === 0
      ? `model-call:${logicalCallId}`
      : `provider-attempt:${attempt.callId}:model-call`,
  }];
  if (attempt.purpose === 'retry' || attempt.purpose === 'fallback') {
    facts.push({ kind: 'retries', amount: 1, idempotencyKey: `provider-attempt:${attempt.callId}:retry` });
  }
  for (const kind of ['input_tokens', 'output_tokens', 'reasoning_tokens', 'external_cost', 'output_bytes'] as const) {
    facts.push({
      kind,
      amount: workerProviderUsageValue(attempt, kind),
      idempotencyKey: `provider-attempt:${attempt.callId}:${kind}`,
    });
  }
  return facts;
}
