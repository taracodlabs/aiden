/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

const AUTHORITY_CHANGED = 'Execution authority changed before verification. Review or reconcile the retained work before continuing.';
const VERIFICATION_INCOMPLETE = 'Verification did not complete. Review the retained result before continuing.';

/** Preserve durable truth while translating internal control-plane codes into
 * bounded operator-facing language shared by conversation and Workbench views. */
export function operatorStatusMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const firstLine = value.split(/\r?\n/u)[0]!.trim();
  if (/DurableToolCallConflictError|stale[_ -]?fence/iu.test(firstLine)) return AUTHORITY_CHANGED;
  if (/verification[_ -]?incomplete/iu.test(firstLine)) return VERIFICATION_INCOMPLETE;
  return firstLine
    .replace(/\b(bearer|api[_-]?key|token|authorization)\s*[:=]\s*\S+/igu, '$1: [redacted]')
    .replace(/\s+/gu, ' ')
    .slice(0, 320);
}
