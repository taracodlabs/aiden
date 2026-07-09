/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * fix/verification-type — "no handle, no trust", made unrepresentable.
 *
 * The old surface let a zero-output, zero-handle `stop` turn report
 * verified=true. The verification OUTCOME is now a discriminated union whose
 * `verified` variant STRUCTURALLY requires a non-empty tuple of evidence
 * handles, so that lie cannot be constructed. These tests pin the runtime
 * behaviour; the compile-time half ("verified([]) does not compile") is
 * enforced by the type-level guard in taskVerification.ts + `npm run typecheck`
 * (tsc does not compile test files, so it cannot be asserted here).
 */
import { describe, it, expect } from 'vitest';

import {
  computeTaskFinalization,
  deriveVerificationOutcome,
  verified,
  isNonEmpty,
  type EvidenceHandle,
} from '../../../core/v4/taskVerification';
import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';

function entry(over: Partial<HonestyTraceEntry>): HonestyTraceEntry {
  return { name: 'tool', result: {}, ...over } as HonestyTraceEntry;
}
const V_OK  = { ok: true, confidence: 1, code: 'ok' as const };
const HANDLE: EvidenceHandle = { tool: 'file_write', kind: 'path', value: '/x/out.txt', verified: true };

describe('VerificationOutcome — "no handle, no trust" (fix/verification-type)', () => {
  it('★ a zero-output, zero-handle turn produces NoEvidence, never Verified', () => {
    // The exact bug: finish=stop, no tool calls, empty finalContent. The row
    // verdict is still `completed` (nothing side-effecting was claimed), but the
    // evidence-typed OUTCOME must be no_evidence — there was nothing to verify.
    const fin = computeTaskFinalization({ finishReason: 'stop', toolCallTrace: [] });
    expect(fin.status).toBe('completed');
    expect(fin.outcome.kind).toBe('no_evidence');
    expect(fin.outcome.kind).not.toBe('verified');
  });

  it('an evidence-backed completed turn produces Verified with a non-empty handle tuple', () => {
    const fin = computeTaskFinalization({
      finishReason: 'stop',
      toolCallTrace: [
        entry({ name: 'file_write', result: { path: '/x/out.txt', bytesWritten: 42 }, handlerMutates: true, verification: V_OK }),
      ],
    });
    expect(fin.status).toBe('completed');
    expect(fin.outcome.kind).toBe('verified');
    if (fin.outcome.kind === 'verified') {
      expect(fin.outcome.handles.length).toBeGreaterThan(0);   // structurally non-empty
      expect(fin.outcome.handles.every((h) => h.verified)).toBe(true);
    }
  });

  it('deriveVerificationOutcome maps each verdict class to an honest outcome', () => {
    // completed + proven handle → verified
    expect(deriveVerificationOutcome('completed', [HANDLE], []).kind).toBe('verified');
    // completed + zero handles → no_evidence (the fix: not verified)
    expect(deriveVerificationOutcome('completed', [], []).kind).toBe('no_evidence');
    // completed but only unverified handles → no_evidence (no PROVEN evidence)
    expect(deriveVerificationOutcome('completed', [{ ...HANDLE, verified: false }], []).kind).toBe('no_evidence');
    // completed_unverified → unverifiable (mutations ran, verification inconclusive)
    expect(deriveVerificationOutcome('completed_unverified', [HANDLE], []).kind).toBe('unverifiable');
    // verification_failed with a recorded failure → failed
    expect(deriveVerificationOutcome('verification_failed', [], [{ tool: 'file_write', reason: 'no bytes' }]).kind).toBe('failed');
    // failed with no recorded failure → unverifiable (a check could not be attempted)
    expect(deriveVerificationOutcome('failed', [], [], 'error').kind).toBe('unverifiable');
  });

  it('isNonEmpty is the runtime half of the compile-time guarantee', () => {
    expect(isNonEmpty([])).toBe(false);
    expect(isNonEmpty([HANDLE])).toBe(true);
    // The compile-time half — `verified([])` is a TYPE ERROR — is enforced by
    // the never-called type-level guard in taskVerification.ts under
    // `npm run typecheck`. Here we only prove the constructor accepts evidence.
    const ok = verified([HANDLE]);
    expect(ok.kind).toBe('verified');
  });
});
