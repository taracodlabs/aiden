import { describe, it, expect } from 'vitest';

import {
  buildCommandRecord,
  deriveActivityPhase,
  mintCommandId,
  type CommandRecord,
  type BuildCommandRecordInput,
} from '../../core/v4/executionContract';
import { decideTaskVerdict } from '../../core/v4/taskVerification';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

// ── helpers ──────────────────────────────────────────────────────────────
const V = (ok: boolean, code: string, reason?: string) => ({ ok, confidence: 1, code: code as any, reason });

/** Build a shadow record from a trace entry + the extra signals the seam holds. */
function rec(entry: HonestyTraceEntry, extra: Partial<BuildCommandRecordInput> = {}): CommandRecord {
  return buildCommandRecord({
    providerCallId: 'toolu_' + entry.name,
    tool: entry.name,
    args: {},
    mutates: entry.handlerMutates === true,
    result: entry.result,
    error: entry.error,
    verification: entry.verification as any,
    ...extra,
  });
}

/** TEST-LOCAL fold (not a production type): did any command's axes say "failed"? */
const recordFailed = (r: CommandRecord): boolean =>
  r.execution.state === 'errored' || r.verification.state === 'failed';
const turnRecordFailed = (rs: CommandRecord[]): boolean => rs.some(recordFailed);
const legacyVerdict = (trace: HonestyTraceEntry[], pathExists?: (p: string) => boolean) =>
  decideTaskVerdict(trace, pathExists ? { pathExists } : undefined).verdict;

// ── the three axes, in isolation ───────────────────────────────────────────

describe('buildCommandRecord — three independent axes, denial/interrupt/exit un-collapsed', () => {
  it('clean mutating success → allowed / succeeded / verified', () => {
    const r = rec({ name: 'file_write', result: { path: 'a', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') } as HonestyTraceEntry);
    expect(r.approval.state).toBe('allowed');
    expect(r.execution.state).toBe('succeeded');
    expect(r.verification.state).toBe('verified');
  });

  it('a user DENIAL is not_started, not an error', () => {
    const r = rec({ name: 'shell_exec', result: null, error: 'Tool execution denied by approval engine — dangerous', handlerMutates: true } as HonestyTraceEntry);
    expect(r.approval.state).toBe('denied');
    expect(r.execution.state).toBe('not_started');
    expect(r.execution.denied).toBe(true);
    expect(r.execution.error).toBeUndefined();       // NOT a crash
    expect(r.execution.interrupted).toBeUndefined();
  });

  it('an interrupt is interrupted, not an error', () => {
    const r = rec({ name: 'shell_exec', result: null, error: 'interrupted', handlerMutates: true } as HonestyTraceEntry, { aborted: true });
    expect(r.execution.state).toBe('interrupted');
    expect(r.execution.interrupted).toBe(true);
    expect(r.execution.error).toBeUndefined();
  });

  it('a non-zero exit is distinct from a crash', () => {
    const nonzero = rec({ name: 'shell_exec', result: { exitCode: 1 }, handlerMutates: false } as HonestyTraceEntry);
    expect(nonzero.execution.state).toBe('nonzero_exit');
    expect(nonzero.execution.exitCode).toBe(1);
    expect(nonzero.execution.error).toBeUndefined();  // ran; did not crash

    const crash = rec({ name: 'file_write', result: null, error: 'EACCES: permission denied', handlerMutates: true } as HonestyTraceEntry);
    expect(crash.execution.state).toBe('errored');
    expect(crash.execution.error).toMatch(/EACCES/);
  });

  it('verifier-ok but claimed artifact absent → verification failed', () => {
    const r = rec({ name: 'file_write', result: { path: 'ghost', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') } as HonestyTraceEntry, { artifactMissing: true });
    expect(r.execution.state).toBe('succeeded');       // the write call returned ok
    expect(r.verification.state).toBe('failed');        // but the artifact isn't there
  });

  it('read-only tools need no approval; weak verifier codes read as weak', () => {
    expect(rec({ name: 'file_read', result: 'x', handlerMutates: false } as HonestyTraceEntry).approval.state).toBe('not_required');
    expect(rec({ name: 'file_write', result: {}, handlerMutates: true, verification: V(true, 'low_signal') } as HonestyTraceEntry).verification.state).toBe('weak');
  });

  it('CommandId is Aiden-minted and distinct from the provider id', () => {
    const r = rec({ name: 'file_read', result: 'x', handlerMutates: false } as HonestyTraceEntry);
    expect(r.proposal.id).toMatch(/^cmd_/);
    expect(r.proposal.id).not.toBe(r.proposal.providerCallId);
    expect(mintCommandId()).not.toBe(mintCommandId());
  });
});

describe('deriveActivityPhase — rendering-only projection of the three axes', () => {
  it('a settled record is terminal', () => {
    const r = rec({ name: 'file_write', result: { path: 'a' }, handlerMutates: true, verification: V(true, 'ok') } as HonestyTraceEntry);
    expect(deriveActivityPhase(r)).toBe('terminal');
  });
  it('projects the most-active axis', () => {
    const base = rec({ name: 'file_write', result: {}, handlerMutates: true, verification: V(true, 'ok') } as HonestyTraceEntry);
    expect(deriveActivityPhase({ ...base, approval: { state: 'awaiting_user' } })).toBe('awaiting_approval');
    expect(deriveActivityPhase({ ...base, execution: { ...base.execution, state: 'running' } })).toBe('running');
    expect(deriveActivityPhase({ ...base, verification: { state: 'pending' } })).toBe('verifying');
  });
});

// ── COMPATIBILITY: the record and the legacy verdict agree (assert equality) ──
// These are the cases where decideTaskVerdict is already correct, so the shadow
// model must not contradict it.

describe('compatibility with the legacy verdict (assert equality)', () => {
  it('clean read-only success', () => {
    const trace: HonestyTraceEntry[] = [
      { name: 'file_read', result: 'contents', handlerMutates: false, verification: V(true, 'ok') } as HonestyTraceEntry,
    ];
    const records = trace.map((e) => rec(e));
    expect(legacyVerdict(trace)).toBe('completed');
    expect(turnRecordFailed(records)).toBe(false);            // both say: not failed
  });

  it('verified mutating action', () => {
    const trace: HonestyTraceEntry[] = [
      { name: 'file_write', result: { path: 'out.txt', bytesWritten: 512 }, handlerMutates: true, verification: V(true, 'ok') } as HonestyTraceEntry,
    ];
    const records = trace.map((e) => rec(e));
    expect(legacyVerdict(trace)).toBe('completed');
    expect(turnRecordFailed(records)).toBe(false);
    expect(records[0].verification.state).toBe('verified');
  });

  it('genuine execution crash on a mutating tool', () => {
    const trace: HonestyTraceEntry[] = [
      { name: 'file_write', result: null, error: 'EACCES: permission denied', handlerMutates: true, verification: V(false, 'failed') } as HonestyTraceEntry,
    ];
    const records = trace.map((e) => rec(e));
    expect(legacyVerdict(trace)).toBe('verification_failed');
    expect(turnRecordFailed(records)).toBe(true);             // both say: failed
    expect(records[0].execution.state).toBe('errored');
  });

  it('genuinely-missing required artifact (verifier-ok, not on disk)', () => {
    const trace: HonestyTraceEntry[] = [
      { name: 'file_write', result: { path: 'ghost.txt', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') } as HonestyTraceEntry,
    ];
    // legacy fails it via the disk-postcondition check…
    expect(legacyVerdict(trace, () => false)).toBe('verification_failed');
    // …and the record agrees when told the artifact is missing.
    const records = trace.map((e) => rec(e, { artifactMissing: true }));
    expect(turnRecordFailed(records)).toBe(true);
    expect(records[0].verification.state).toBe('failed');
  });
});

// ── DIVERGENCE: the legacy verdict is wrong here; pin it as telemetry, assert
// the record's NEW truth, and do NOT assert record-conclusion == legacy. ──────

describe('intentional divergence (legacy pinned as telemetry, equality NOT asserted)', () => {
  it('user denied → record: declined+not_started; legacy WRONGLY reads it as a failure', () => {
    const trace: HonestyTraceEntry[] = [
      { name: 'shell_exec', result: null, error: 'Tool execution denied by approval engine — dangerous', handlerMutates: true } as HonestyTraceEntry,
    ];
    const r = rec(trace[0]);
    // NEW truth: a decision, not a failure.
    expect(r.approval.state).toBe('denied');
    expect(r.execution.state).toBe('not_started');
    expect(r.execution.error).toBeUndefined();
    // Legacy telemetry (the bug P1B fixes): a decline is metered as a failure.
    const legacy = legacyVerdict(trace);
    expect(legacy).toBe('verification_failed');
    // Deliberately NO expect(turnRecordFailed) === (legacy==='verification_failed').
    expect(recordFailed(r)).toBe(false);   // the record does NOT call a decline a failure
  });

  it('expected diagnostic exit 1 → record: nonzero_exit (not a crash); legacy fails the turn', () => {
    const trace: HonestyTraceEntry[] = [
      { name: 'shell_exec', result: { exitCode: 1 }, handlerMutates: true, verification: V(false, 'failed') } as HonestyTraceEntry,
    ];
    const r = rec(trace[0]);
    expect(r.execution.state).toBe('nonzero_exit');   // ran, exit 1 — NOT 'errored'
    expect(r.execution.exitCode).toBe(1);
    const legacy = legacyVerdict(trace);              // telemetry: legacy conflates exit≠0 with crash
    expect(legacy).toBe('verification_failed');
  });

  it('unrelated passed tests stay valid despite another command failing', () => {
    const trace: HonestyTraceEntry[] = [
      { name: 'shell_exec', result: { exitCode: 0 }, handlerMutates: false, verification: V(true, 'ok') } as HonestyTraceEntry,   // a passing test run
      { name: 'file_write', result: null, error: 'disk full', handlerMutates: true, verification: V(false, 'failed') } as HonestyTraceEntry, // an unrelated failed write
    ];
    const [passed, failed] = trace.map((e) => rec(e));
    // NEW truth: the passing test's record survives the turn's overall failure.
    expect(passed.execution.state).toBe('succeeded');
    expect(passed.verification.state).toBe('verified');
    expect(failed.execution.state).toBe('errored');
    // Legacy telemetry: the whole turn is failed, erasing the passing command's status.
    expect(legacyVerdict(trace)).toBe('verification_failed');
  });

  it('early ENOENT + later artifact creation are temporally compatible', () => {
    const trace: HonestyTraceEntry[] = [
      { name: 'file_write', result: { path: 'build/out', bytesWritten: 0 }, error: 'ENOENT: no such directory', handlerMutates: true, verification: V(false, 'failed') } as HonestyTraceEntry, // fails first
      { name: 'file_write', result: { path: 'build/out', bytesWritten: 200 }, handlerMutates: true, verification: V(true, 'ok') } as HonestyTraceEntry, // succeeds after mkdir
    ];
    const [early, later] = trace.map((e) => rec(e));
    // NEW truth: both per-command outcomes are preserved in sequence.
    expect(early.execution.state).toBe('errored');
    expect(later.execution.state).toBe('succeeded');
    expect(later.verification.state).toBe('verified');
    // Legacy telemetry: same-target reconciliation may or may not redeem it — we
    // pin whatever it concludes without treating it as the record's oracle.
    const legacy = legacyVerdict(trace);
    expect(['completed', 'verification_failed']).toContain(legacy);
  });
});
