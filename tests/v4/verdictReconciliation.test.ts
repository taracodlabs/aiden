import { describe, it, expect } from 'vitest';

import { decideTaskVerdict } from '../../core/v4/taskVerification';
import { HonestyEnforcement } from '../../moat/honestyEnforcement';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

/**
 * A turn that DID the work must not be failed by an earlier, superseded
 * failure. Scenario (the real DEFECT 2 class): the model ran a mutating
 * operation, it failed (output overflow → verifier !ok), it retried the SAME
 * operation which succeeded and produced the artifact, then declared success
 * via ui_task_done. The verdict must be `completed`, and the success claim
 * must NOT be reported as contradicting the evidence.
 */
const V_OK   = { ok: true,  confidence: 1, code: 'ok' as const };
const V_FAIL = { ok: false, confidence: 1, code: 'failed' as const, reason: 'output overflow — result truncated' };
const mk = (o: Partial<HonestyTraceEntry>): HonestyTraceEntry => ({ name: 'x', result: {}, ...o });

describe('verdict reconciliation — a retried mutating call redeems its earlier failure', () => {
  // shell_exec #1 fails, shell_exec #2 succeeds at the SAME target (the claimed
  // artifact), ui_task_done claims success.
  const trace: HonestyTraceEntry[] = [
    mk({ name: 'shell_exec', result: { path: 'temp-files-recursive.txt', exitCode: 1 }, handlerMutates: true, verification: V_FAIL }),
    mk({ name: 'shell_exec', result: { path: 'temp-files-recursive.txt', bytesWritten: 2470915, exitCode: 0 }, handlerMutates: true, verification: V_OK }),
  ];
  const uiClaims = [{ name: 'ui_task_done', args: { status: 'success' } }];

  it('decideTaskVerdict → completed (later success at the same target redeems the earlier failure)', () => {
    expect(decideTaskVerdict(trace).verdict).toBe('completed');
  });

  it('recordOutcomes → no claim_contradicted (a superseded shell_exec failure does not contradict a success claim)', () => {
    const events = new HonestyEnforcement('detect').recordOutcomes(trace, uiClaims);
    expect(events.some((e) => e.kind === 'claim_contradicted')).toBe(false);
  });
});

describe('verdict reconciliation — the check can still say NO (true alarms stay red)', () => {
  it('TRUE alarm: success claimed with NO successful mutating call → verification_failed', () => {
    const trace: HonestyTraceEntry[] = [
      mk({ name: 'shell_exec', result: { path: 'out.txt', exitCode: 1 }, handlerMutates: true, verification: V_FAIL }),
    ];
    expect(decideTaskVerdict(trace).verdict).toBe('verification_failed');
  });

  it('TRUE alarm: success claim + a lone (un-superseded) failed shell_exec → claim_contradicted STILL fires', () => {
    const trace: HonestyTraceEntry[] = [
      mk({ name: 'shell_exec', result: { path: 'out.txt', exitCode: 1 }, handlerMutates: true, verification: V_FAIL }),
    ];
    const events = new HonestyEnforcement('detect')
      .recordOutcomes(trace, [{ name: 'ui_task_done', args: { status: 'success' } }]);
    expect(events.some((e) => e.kind === 'claim_contradicted')).toBe(true);
  });

  it('TRUE alarm: verifier-ok write whose file is MISSING on disk → verification_failed (injected checker says no)', () => {
    const trace: HonestyTraceEntry[] = [
      mk({ name: 'file_write', result: { path: 'ghost.txt', bytesWritten: 10 }, handlerMutates: true, verification: V_OK }),
    ];
    const decision = decideTaskVerdict(trace, { pathExists: () => false });
    expect(decision.verdict).toBe('verification_failed');
    expect(decision.failures[0].reason).toMatch(/no file exists/i);
  });

  it('control: the SAME verifier-ok write with the file PRESENT → completed (the check can also say yes)', () => {
    const trace: HonestyTraceEntry[] = [
      mk({ name: 'file_write', result: { path: 'ghost.txt', bytesWritten: 10 }, handlerMutates: true, verification: V_OK }),
    ];
    expect(decideTaskVerdict(trace, { pathExists: () => true }).verdict).toBe('completed');
  });
});
