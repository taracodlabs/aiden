/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type {
  BrowserActionReceipt,
  BrowserSessionAuthority,
  BrowserSessionBinding,
} from './browserSessionAuthority';

export interface BrowserEffectInspection {
  outcome: 'verified' | 'not_applied' | 'unknown';
  verification: unknown;
  evidencePayload: unknown;
}

/** Resolve one unknown browser action from observable state. The API deliberately
 * accepts no mutation callback, so reconciliation cannot accidentally replay the
 * original external effect. */
export async function reconcileBrowserEffect(input: {
  authority: BrowserSessionAuthority;
  binding: BrowserSessionBinding;
  actionId: string;
  inspect: (receipt: BrowserActionReceipt) => Promise<BrowserEffectInspection>;
}): Promise<{ applied: boolean; receipt: BrowserActionReceipt }> {
  const receipt = input.authority.getAction(input.actionId);
  if (!receipt || receipt.jobId !== input.binding.jobId
    || !['unknown', 'reconciling', 'dispatched'].includes(receipt.state)) {
    throw new Error('Browser action is not available for reconciliation');
  }
  let resolution: BrowserEffectInspection;
  try {
    resolution = await input.inspect(receipt);
  } catch (error) {
    resolution = {
      outcome: 'unknown',
      verification: { inspectorError: error instanceof Error ? error.name : 'Error' },
      evidencePayload: null,
    };
  }
  return receipt.generation < input.binding.generation
    ? input.authority.reconcilePriorAction(input.binding, input.actionId, resolution)
    : input.authority.reconcileAction(input.binding, input.actionId, resolution);
}
