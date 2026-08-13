/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ApprovalCallbacks, ApprovalDecision, ApprovalRequest } from '../../../moat/approvalEngine';
import type { ActionAuthority } from '../actionAuthority';

export interface BuildWorkbenchApprovalCallbacksOptions {
  authority: ActionAuthority;
  jobId: string;
  attemptId: string;
  generation: number;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onDecision?: ApprovalCallbacks['onDecision'];
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

function waitForPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    if (typeof timer.unref === 'function') timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Adapts the existing durable exact-action approval record to the daemon
 * approval callback expected by a Workbench-hosted Agent turn. The browser is
 * only a decision surface; ActionAuthority remains the source of truth.
 */
export function buildWorkbenchApprovalCallbacks(
  options: BuildWorkbenchApprovalCallbacksOptions,
): ApprovalCallbacks {
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(pollIntervalMs, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    promptUser: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      const approvalId = request.durableApprovalId;
      if (!approvalId) return 'deny';
      const deadline = Date.now() + timeoutMs;

      while (!options.signal?.aborted && Date.now() < deadline) {
        const record = options.authority.get(approvalId);
        if (!record) return 'deny';
        if (
          record.jobId !== options.jobId ||
          record.attemptId !== options.attemptId ||
          record.generation !== options.generation ||
          record.toolName !== request.toolName
        ) return 'deny';

        if (record.state === 'approved') return 'allow';
        if (record.state === 'denied') return 'deny';
        if (record.state === 'cancelled') return 'interrupted';
        if (!['created', 'displayed'].includes(record.state)) return 'deny';
        if (!await waitForPoll(pollIntervalMs, options.signal)) return 'interrupted';
      }
      return 'interrupted';
    },
    ...(options.onDecision ? { onDecision: options.onDecision } : {}),
  };
}
