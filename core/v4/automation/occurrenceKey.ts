/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

export interface OccurrenceIdentity {
  automationId: string;
  revisionId: string;
  triggerKind: string;
  scheduledFor?: string | null;
  sourceIdentity: string;
}

export function computeOccurrenceKey(identity: OccurrenceIdentity): string {
  const canonical = JSON.stringify([
    identity.automationId,
    identity.revisionId,
    identity.triggerKind,
    identity.scheduledFor ?? null,
    identity.sourceIdentity,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
