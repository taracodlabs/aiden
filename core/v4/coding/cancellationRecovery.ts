/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';

import { realpathWithFallback } from '../sandboxFs';
import type { JobEngine } from '../daemon/jobEngine';

export interface CancelledExternalCodingRecoveryResult {
  readonly inspected: number;
  readonly recovered: number;
  readonly released: number;
  readonly blocked: readonly Readonly<{ codingSessionId: string; reason: string }>[];
}

function samePath(left: string, right: string): boolean {
  const a = realpathWithFallback(path.resolve(left));
  const b = realpathWithFallback(path.resolve(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function safeSessionHome(parent: string, sessionHome: string, codingSessionId: string): boolean {
  const root = path.resolve(parent);
  const target = path.resolve(sessionHome);
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    && path.basename(target) === codingSessionId;
}

/** Reconciles only exact terminal-cancelled Attempt lineage left by an interrupted older runtime. */
export async function recoverCancelledExternalCodingSessions(input: {
  engine: JobEngine;
  sourcePath?: string;
  sessionHomeParent?: string;
  producer?: string;
  now?: number;
}): Promise<CancelledExternalCodingRecoveryResult> {
  let inspected = 0;
  let recovered = 0;
  let released = 0;
  const blocked: Array<{ codingSessionId: string; reason: string }> = [];
  for (const lease of input.engine.codingWorkspaces.listActive()) {
    if (input.sourcePath && !samePath(lease.sourcePath, input.sourcePath)) continue;
    inspected += 1;
    const session = input.engine.coding.get(lease.codingSessionId);
    const job = input.engine.getJob(lease.childJobId);
    const attempt = input.engine.getAttempt(lease.childAttemptId);
    if (!session || session.workspaceLeaseId !== lease.workspaceLeaseId
      || job?.status !== 'cancelled' || attempt?.status !== 'cancelled'
      || attempt.generation !== lease.generation || !attempt.fenceToken) {
      blocked.push({ codingSessionId: lease.codingSessionId, reason: 'not_exactly_cancelled' });
      continue;
    }
    const authority = {
      childJobId: lease.childJobId,
      childAttemptId: lease.childAttemptId,
      childGeneration: lease.generation,
      childFenceToken: attempt.fenceToken,
    };
    try {
      const settled = input.engine.coding.recoverCancellation({
        ...authority,
        codingSessionId: lease.codingSessionId,
        producer: input.producer ?? 'external-coding-cancellation-recovery',
        idempotencyKey: `external-coding-cancel-recovery:${lease.codingSessionId}`,
        now: input.now,
      });
      if (settled.state !== 'terminal') {
        blocked.push({ codingSessionId: lease.codingSessionId, reason: 'process_tree_not_proven_terminal' });
        continue;
      }
      recovered += 1;
      await input.engine.codingWorkspaces.releaseCancelled({
        ...authority,
        codingSessionId: lease.codingSessionId,
        workspaceLeaseId: lease.workspaceLeaseId,
        now: input.now,
      });
      released += 1;
      if (input.sessionHomeParent
        && safeSessionHome(input.sessionHomeParent, session.sessionHomePath, session.codingSessionId)) {
        await rm(session.sessionHomePath, { recursive: true, force: true });
      }
    } catch (error) {
      blocked.push({
        codingSessionId: lease.codingSessionId,
        reason: error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'recovery_failed',
      });
    }
  }
  return { inspected, recovered, released, blocked };
}
