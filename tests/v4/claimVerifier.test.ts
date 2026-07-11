import { describe, it, expect } from 'vitest';

import {
  resourcesOf,
  buildEvidenceLedger,
  evaluateClaim,
  evaluateTask,
  buildToolDerivedContract,
  recordsFromTrace,
  runShadowClaimVerifier,
  type ClaimDefinition,
  type TaskContract,
  type Coverage,
  type ForbiddenCondition,
} from '../../core/v4/claimVerifier';
import { buildCommandRecord } from '../../core/v4/executionContract';
import { decideTaskVerdict } from '../../core/v4/taskVerification';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

// ── helpers ──────────────────────────────────────────────────────────────
const V = (ok: boolean, code: string, reason?: string) => ({ ok, confidence: 1, code: code as any, reason });
const entry = (o: Partial<HonestyTraceEntry>): HonestyTraceEntry => ({ name: 'x', result: {}, ...o } as HonestyTraceEntry);
const claim = (resource: string, required = true): ClaimDefinition =>
  ({ id: resource, category: 'contract', resource, predicate: `exists ${resource}`, required });
const contract = (
  requiredClaims: ClaimDefinition[],
  coverage: Coverage,
  forbiddenConditions: ForbiddenCondition[] = [],
): TaskContract => ({ requiredClaims, optionalClaims: [], forbiddenConditions, coverage, source: 'user_explicit', frozenAt: 0 });
const legacy = (trace: HonestyTraceEntry[], pathExists?: (p: string) => boolean) =>
  decideTaskVerdict(trace, pathExists ? { pathExists } : undefined).verdict;

// ── resources + evidence ───────────────────────────────────────────────────

describe('resources + append-only evidence', () => {
  it('resourcesOf returns multiple resources for a move (plural, not singular)', () => {
    const rec = buildCommandRecord({ providerCallId: '', tool: 'file_move', args: {}, mutates: true, result: { from: 'a', to: 'b', bytesWritten: 5 } });
    expect(resourcesOf(rec).map((r) => r.resource)).toEqual(['file://a', 'file://b']);
    expect(resourcesOf(rec).map((r) => r.interaction)).toEqual(['moved_from', 'moved_to']);
  });

  it('a shell command with opaque effects yields no resources (never guesses)', () => {
    const rec = buildCommandRecord({ providerCallId: '', tool: 'shell_exec', args: {}, mutates: true, result: { exitCode: 0 } });
    expect(resourcesOf(rec)).toEqual([]);
  });

  it('exit codes are execution evidence keyed by executionId — never a resource', () => {
    const records = recordsFromTrace([entry({ name: 'shell_exec', result: { exitCode: 1 }, handlerMutates: false })]);
    const ledger = buildEvidenceLedger(records);
    const exits = ledger.all().filter((e) => e.kind === 'exit_code');
    expect(exits).toHaveLength(1);
    expect(exits[0].resource).toBeUndefined();
    expect(exits[0].executionId).toBe(records[0].proposal.id);
  });

  it('evidence is append-only — a later success never erases the earlier failure', () => {
    const trace = [
      entry({ name: 'file_write', result: { path: 'x', bytesWritten: 0 }, error: 'ENOENT', handlerMutates: true, verification: V(false, 'failed') }),
      entry({ name: 'file_write', result: { path: 'x', bytesWritten: 20 }, handlerMutates: true, verification: V(true, 'ok') }),
    ];
    const ledger = buildEvidenceLedger(recordsFromTrace(trace));
    const forX = ledger.forResource('file://x').filter((e) => e.kind === 'resource_touch');
    expect(forX).toHaveLength(2);                       // historical truth retained
    expect(evaluateClaim(claim('file://x'), ledger).state).toBe('verified'); // current state supersedes
  });
});

// ── the three NAMED tests ───────────────────────────────────────────────────

describe('named cases', () => {
  it('requiredClaims=[] + coverage unknown → unverified', () => {
    expect(evaluateTask([], contract([], 'unknown')).verdict).toBe('unverified');
  });

  it('verified observed claims do not become required claims', () => {
    const records = recordsFromTrace([entry({ name: 'file_write', result: { path: 'a.txt', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') })]);
    const ev = evaluateTask(records, buildToolDerivedContract(records)); // tool-derived ⇒ requiredClaims=[]
    expect(ev.observed.some((o) => o.state === 'verified' && o.definition.category === 'observed' && o.definition.required === false)).toBe(true);
    expect(ev.required).toHaveLength(0);               // observed never enters the required set
    expect(ev.verdict).toBe('unverified');             // and never lifts the verdict
  });

  it('a known failed required claim is not hidden by unknown coverage', () => {
    const records = recordsFromTrace([entry({ name: 'file_write', result: { path: 'a.txt', bytesWritten: 0 }, error: 'EACCES', handlerMutates: true, verification: V(false, 'failed') })]);
    expect(evaluateTask(records, contract([claim('file://a.txt')], 'unknown')).verdict).toBe('failed');
  });
});

// ── verdict precedence (top wins) ───────────────────────────────────────────

describe('verdict precedence', () => {
  it('1. forbidden confirmed outranks everything → failed', () => {
    const records = recordsFromTrace([entry({ name: 'file_write', result: { path: 'secret', bytesWritten: 0 }, error: 'blocked', handlerMutates: true, verification: V(false, 'failed') })]);
    const forbidden: ForbiddenCondition = { id: 'no-secret', resource: 'file://secret', predicate: 'must not touch secret', source: 'policy' };
    const ev = evaluateTask(records, contract([], 'complete', [forbidden]));
    expect(ev.verdict).toBe('failed');
    expect(ev.forbiddenConfirmed).toHaveLength(1);
  });

  it('3. a denied required claim, nothing else done → denied', () => {
    const records = recordsFromTrace([entry({ name: 'file_write', result: { path: 'b', bytesWritten: 0 }, error: 'Tool execution denied by approval engine — x', handlerMutates: true })]);
    expect(evaluateTask(records, contract([claim('file://b')], 'complete')).verdict).toBe('denied');
  });

  it('4. a denied required claim but other required work done → partial', () => {
    const records = recordsFromTrace([
      entry({ name: 'file_write', result: { path: 'a', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') }),
      entry({ name: 'file_write', result: { path: 'b', bytesWritten: 0 }, error: 'Tool execution denied by approval engine — x', handlerMutates: true }),
    ]);
    expect(evaluateTask(records, contract([claim('file://a'), claim('file://b')], 'complete')).verdict).toBe('partial');
  });

  it('5. an unresolved required claim → partial', () => {
    expect(evaluateTask([], contract([claim('file://missing')], 'complete')).verdict).toBe('partial');
  });
});

// ── COMPATIBILITY (synthetic coverage='complete'; assert equality with legacy) ─

describe('compatibility with the legacy verdict (assert equality)', () => {
  it('verified mutation → verified ≈ legacy completed', () => {
    const trace = [entry({ name: 'file_write', result: { path: 'out.txt', bytesWritten: 512 }, handlerMutates: true, verification: V(true, 'ok') })];
    expect(evaluateTask(recordsFromTrace(trace), contract([claim('file://out.txt')], 'complete')).verdict).toBe('verified');
    expect(legacy(trace)).toBe('completed');
  });

  it('genuine crash → failed ≈ legacy verification_failed', () => {
    const trace = [entry({ name: 'file_write', result: { path: 'out.txt', bytesWritten: 0 }, error: 'EACCES', handlerMutates: true, verification: V(false, 'failed') })];
    expect(evaluateTask(recordsFromTrace(trace), contract([claim('file://out.txt')], 'complete')).verdict).toBe('failed');
    expect(legacy(trace)).toBe('verification_failed');
  });

  it('missing required artifact → failed ≈ legacy verification_failed', () => {
    const trace = [entry({ name: 'file_write', result: { path: 'ghost.txt', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') })];
    // The record is told the artifact is absent — the disk signal a later slice
    // supplies at the finalize seam; the pure core simply honours it.
    const records = [buildCommandRecord({ providerCallId: '', tool: 'file_write', args: {}, mutates: true, result: { path: 'ghost.txt', bytesWritten: 10 }, verification: V(true, 'ok') as never, artifactMissing: true })];
    expect(evaluateTask(records, contract([claim('file://ghost.txt')], 'complete')).verdict).toBe('failed');
    expect(legacy(trace, () => false)).toBe('verification_failed');
  });
});

// ── DIVERGENCE (assert the NEW verdict; pin legacy as telemetry only) ────────

describe('intentional divergence (legacy pinned, equality NOT asserted)', () => {
  it('an unrelated failure does not contaminate a satisfied required claim', () => {
    const trace = [
      entry({ name: 'file_write', result: { path: 'wanted.txt', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') }),
      entry({ name: 'file_write', result: { path: 'unrelated.txt', bytesWritten: 0 }, error: 'disk full', handlerMutates: true, verification: V(false, 'failed') }),
    ];
    // The user asked only for wanted.txt.
    expect(evaluateTask(recordsFromTrace(trace), contract([claim('file://wanted.txt')], 'complete')).verdict).toBe('verified');
    expect(legacy(trace)).toBe('verification_failed'); // telemetry: turn-wide contamination
  });

  it('a denied required claim → denied, not a crash', () => {
    const trace = [entry({ name: 'file_write', result: { path: 'guarded.txt', bytesWritten: 0 }, error: 'Tool execution denied by approval engine — dangerous', handlerMutates: true })];
    expect(evaluateTask(recordsFromTrace(trace), contract([claim('file://guarded.txt')], 'complete')).verdict).toBe('denied');
    expect(legacy(trace)).toBe('verification_failed'); // telemetry: denial metered as failure
  });

  it('all required verified but coverage partial → unverified, not verified', () => {
    const trace = [entry({ name: 'file_write', result: { path: 'done.txt', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') })];
    expect(evaluateTask(recordsFromTrace(trace), contract([claim('file://done.txt')], 'partial')).verdict).toBe('unverified');
    expect(legacy(trace)).toBe('completed');           // telemetry: legacy leniency on incomplete coverage
  });
});

// ── production shadow entry ──────────────────────────────────────────────────

describe('runShadowClaimVerifier (tool-derived production shadow)', () => {
  it('a normal successful turn shadows as unverified (coverage unknown, no required set)', () => {
    const trace = [entry({ name: 'file_write', result: { path: 'a.txt', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') })];
    const ev = runShadowClaimVerifier(trace);
    expect(ev.coverage).toBe('unknown');
    expect(ev.required).toHaveLength(0);
    expect(ev.verdict).toBe('unverified');
    expect(ev.observed.length).toBeGreaterThan(0);     // the work is observed, just not contract-required
  });

  it('an empty turn shadows as unverified without throwing', () => {
    expect(runShadowClaimVerifier([]).verdict).toBe('unverified');
  });
});
