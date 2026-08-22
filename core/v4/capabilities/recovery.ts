/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { getProcessCreationTime } from '../util/spawnCommand';
import type { CapabilityStore } from './store';

export interface CapabilityHostIdentity {
  instanceId: string;
  pid: number;
  startTime: number | null;
}

export function isExactCapabilityHostAlive(identity: Pick<CapabilityHostIdentity, 'pid' | 'startTime'>): boolean {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0) return false;
  if (identity.startTime !== null) {
    const actual = getProcessCreationTime(identity.pid);
    if (actual === null || Math.abs(actual - identity.startTime) >= 2_000) return false;
  }
  try {
    process.kill(identity.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconciles only invocations whose exact host process identity is gone.
 * Container cleanup happens before the receipt becomes terminal, so a failed
 * cleanup can never be presented as a safely recovered invocation.
 */
export class CapabilityRecoveryAuthority {
  constructor(private readonly options: {
    store: CapabilityStore;
    processHost: { removeInvocation(invocationId: string): number };
    currentHost: CapabilityHostIdentity;
    isProcessAlive?: (identity: Pick<CapabilityHostIdentity, 'pid' | 'startTime'>) => boolean;
    now?: () => number;
  }) {}

  reconcile(): { recovered: number; live: number; failedCleanup: number } {
    let recovered = 0;
    let live = 0;
    let failedCleanup = 0;
    const isAlive = this.options.isProcessAlive ?? isExactCapabilityHostAlive;
    for (const receipt of this.options.store.listNonterminalInvocations()) {
      if (receipt.hostInstanceId === this.options.currentHost.instanceId
        || isAlive({ pid: receipt.hostPid, startTime: receipt.hostStartTime })) {
        live += 1;
        continue;
      }
      try {
        this.options.processHost.removeInvocation(receipt.invocationId);
      } catch {
        failedCleanup += 1;
        continue;
      }
      const now = (this.options.now ?? Date.now)();
      this.options.store.transitionInvocation({
        invocationId: receipt.invocationId,
        expectedStateVersion: receipt.stateVersion,
        state: 'unknown',
        terminalAt: now,
        runtimeMs: Math.max(0, now - receipt.startedAt),
        detail: 'Previous capability host ended before a terminal protocol result; outcome requires reconciliation',
      });
      recovered += 1;
    }
    return { recovered, live, failedCleanup };
  }
}
