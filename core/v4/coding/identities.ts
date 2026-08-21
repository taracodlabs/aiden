/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

export function externalCodingIdentity(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)}`;
}

export function externalCodingSessionIdentity(
  assignmentId: string,
  childAttemptId: string,
  generation: number,
): string {
  return externalCodingIdentity('coding_session', { assignmentId, childAttemptId, generation });
}

export function externalCodingWorkerRunIdentity(codingSessionId: string, assignmentId: string): string {
  return externalCodingIdentity('worker_run', { codingSessionId, assignmentId });
}

