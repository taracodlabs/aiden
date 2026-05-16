/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/sessionId.ts — v4.5 Phase 5a.
 *
 * Per-trigger sessionId derivation. Stable across retries — the
 * same trigger event (same idempotencyKey) always produces the
 * same sessionId, so:
 *
 *   - v4.4 docker session cache reuses one container per trigger
 *     across retry attempts (cold-start cost amortised).
 *   - v4.3 browser observer keeps page state observable for the
 *     same trigger across re-attempts.
 *   - v4.2 TurnState tracks repeated tool calls within a
 *     single retry session (still fresh per turn — TurnState
 *     lives per `runConversation`, not per sessionId).
 *
 * Format: `trigger:<source>:<sourceKey>:<idemHash>` where
 *   - source: TriggerSource literal ('file' / 'webhook' / 'email'
 *     / 'schedule' / 'manual')
 *   - sourceKey: the trigger spec id (FK to triggers.id)
 *   - idemHash: base64url(sha256(idempotencyKey)).slice(0,12)
 *
 * 12-char b64url prefix gives ~72 bits — far more than enough to
 * keep distinct triggers separate without bloating the sessionId
 * the docker cache / runStore have to carry around.
 *
 * `idempotencyKey === null` falls back to the literal `no-idem`
 * sentinel — keeps the sessionId stable for sources that don't
 * dedup (rare; mostly schedule).
 */

import { createHash } from 'node:crypto';
import type { TriggerSource } from '../types';

/** Input shape for `buildTriggerSessionId`. */
export interface BuildSessionIdInput {
  source:         TriggerSource;
  /** Trigger spec id (FK triggers.id) — watcherId / routeId / triggerId / jobId. */
  sourceKey:      string;
  /** Per-fire idempotency key (path / delivery-id / messageId / scheduledFor). */
  idempotencyKey: string | null;
}

const NO_IDEM_SENTINEL = 'no-idem';

/**
 * Build a stable per-trigger sessionId.
 *
 * Deterministic: same input → same output. Tested for stability
 * across retries (the trigger bus reclaims its existing event row;
 * the dispatcher hands the same triple to this function on every
 * attempt → same sessionId → same docker container / browser tab
 * reused).
 */
export function buildTriggerSessionId(input: BuildSessionIdInput): string {
  const idem = input.idempotencyKey ?? NO_IDEM_SENTINEL;
  const hash = sha256B64url(idem).slice(0, 12);
  return `trigger:${input.source}:${input.sourceKey}:${hash}`;
}

/**
 * Inverse-ish parser. Returns the structural pieces of a sessionId
 * built by `buildTriggerSessionId`. Returns `null` for sessionIds
 * not built by this helper (interactive REPL sessions, plain
 * UUIDs, etc.).
 *
 * Used by recoveryReport to detect daemon-triggered runs and
 * surface the `triggerContext` pill.
 */
export function parseTriggerSessionId(
  sessionId: string,
): { source: TriggerSource; sourceKey: string; idemHash: string } | null {
  if (!sessionId.startsWith('trigger:')) return null;
  const parts = sessionId.split(':');
  // ['trigger', source, sourceKey, idemHash]
  if (parts.length !== 4) return null;
  const [, source, sourceKey, idemHash] = parts;
  if (!isTriggerSource(source)) return null;
  if (!sourceKey || sourceKey.length === 0) return null;
  if (!idemHash || idemHash.length === 0) return null;
  return { source, sourceKey, idemHash };
}

/** Type-guard for TriggerSource literals. */
function isTriggerSource(s: string): s is TriggerSource {
  return s === 'file' || s === 'webhook' || s === 'email'
      || s === 'schedule' || s === 'manual';
}

function sha256B64url(input: string): string {
  return createHash('sha256')
    .update(input)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
