import { describe, it, expect } from 'vitest';

import {
  evaluateExpectedOutcome,
  projectDiagnosticClaim,
  validateContract,
  EXPECTED_OUTCOME_MATCHER_VERSION,
  type ExpectedOutcomeContract,
  type ObservedOutcome,
  type AttemptScope,
  type MatchOptions,
} from '../../core/v4/expectedOutcome';

const PLAN = 'plan-digest-abc';
const SCOPE: AttemptScope = { providerCallId: 'call-1', attemptId: 'attempt-1' };
const TEST: MatchOptions = { allowSyntheticTest: true };
const SUBJECT = 'file:///work/report.json';

function contract(over: Partial<ExpectedOutcomeContract> = {}): ExpectedOutcomeContract {
  return {
    matcherVersion: EXPECTED_OUTCOME_MATCHER_VERSION,
    source: 'planner_proposed',
    frozenSequence: 10,
    frozenAt: 1000,
    executionPlanDigest: PLAN,
    attemptScope: SCOPE,
    expectationKind: 'predicate_failure',
    acceptedTerminationClasses: ['nonzero_exit'],
    acceptedExitCodes: { kind: 'set', codes: [1, 2] },
    expectedPredicate: { category: 'path_not_found', subjectResource: SUBJECT },
    requiredEvidence: true,
    allowedEffects: [],
    forbiddenEffects: ['file_delete'],
    ...over,
  };
}

function observed(over: Partial<ObservedOutcome> = {}): ObservedOutcome {
  return {
    executionPlanDigest: PLAN,
    attemptScope: SCOPE,
    startedSequence: 20,
    startedAt: 2000,
    endedAt: 2100,
    terminationClass: 'nonzero_exit',
    exitCode: 1,
    semantic: { category: 'path_not_found', subjectResource: SUBJECT, provenance: 'os_error_code' },
    evidenceIds: ['ev-1'],
    observedEffects: [],
    ...over,
  };
}

describe('expectedOutcome — the happy path + anti-laundering teeth', () => {
  it('baseline: a well-formed, well-bound, well-provenanced match → matched', () => {
    const e = evaluateExpectedOutcome(contract(), observed(), TEST);
    expect(e.verdict).toBe('matched');
  });

  it('1. expectation frozen AFTER command start (by sequence) → invalid_binding (anti-post-hoc)', () => {
    const e = evaluateExpectedOutcome(contract({ frozenSequence: 10 }), observed({ startedSequence: 5 }), TEST);
    expect(e.verdict).toBe('invalid_binding');
    expect(e.reasons).toContain('frozen_after_execution_start');
  });

  it('2. changed plan (argv/cwd/env → different digest) → invalid_binding', () => {
    const e = evaluateExpectedOutcome(contract(), observed({ executionPlanDigest: 'plan-CHANGED' }), TEST);
    expect(e.verdict).toBe('invalid_binding');
    expect(e.reasons).toContain('plan_digest_mismatch');
  });

  it('3. exit matches but semantic category differs → mismatched (anti-exit-code-laundering)', () => {
    const e = evaluateExpectedOutcome(
      contract(),
      observed({ semantic: { category: 'access_denied', subjectResource: SUBJECT, provenance: 'os_error_code' } }),
      TEST,
    );
    expect(e.verdict).toBe('mismatched');
    expect(e.reasons).toContain('semantic_predicate_contradicted');
  });

  it('4. category matches but exit code differs → mismatched', () => {
    const e = evaluateExpectedOutcome(contract(), observed({ exitCode: 7 }), TEST);
    expect(e.verdict).toBe('mismatched');
    expect(e.reasons).toContain('exit_code_not_accepted');
  });

  it('5. expected nonzero + a forbidden side effect occurred → mismatched + preserved policy observation', () => {
    const e = evaluateExpectedOutcome(
      contract(),
      observed({ observedEffects: [{ kind: 'file_delete', subjectResource: 'file:///work/db' }] }),
      TEST,
    );
    expect(e.verdict).toBe('mismatched');
    expect(e.reasons).toContain('forbidden_effect_observed');
    expect(e.forbiddenObservation).toBeDefined();
    expect(e.forbiddenObservation!.effect).toBe('file_delete');
  });

  it('6. a timeout cannot satisfy an ordinary nonzero expectation → mismatched', () => {
    const e = evaluateExpectedOutcome(contract(), observed({ terminationClass: 'timed_out', exitCode: null }), TEST);
    expect(e.verdict).toBe('mismatched');
    expect(e.reasons).toContain('termination_class_not_accepted');
  });

  it('7. a crash cannot satisfy an ordinary nonzero expectation → mismatched', () => {
    const e = evaluateExpectedOutcome(contract(), observed({ terminationClass: 'crashed', exitCode: null }), TEST);
    expect(e.verdict).toBe('mismatched');
    expect(e.reasons).toContain('termination_class_not_accepted');
  });

  it('8. overbroad / malformed contracts → invalid_contract', () => {
    expect(evaluateExpectedOutcome(contract({ acceptedExitCodes: { kind: 'any_nonzero' } }), observed(), TEST).verdict).toBe('invalid_contract');
    // accepting a crash as an ordinary diagnostic termination is laundering
    expect(evaluateExpectedOutcome(contract({ acceptedTerminationClasses: ['nonzero_exit', 'crashed'] }), observed(), TEST).reasons)
      .toContain('termination_class_not_permitted_for_kind');
    // empty exit set, zero-as-failure, empty termination set
    expect(validateContract(contract({ acceptedExitCodes: { kind: 'set', codes: [] } }))).toContain('exit_codes_empty');
    expect(validateContract(contract({ acceptedExitCodes: { kind: 'set', codes: [0] } }))).toContain('exit_code_zero_not_diagnostic');
    expect(validateContract(contract({ acceptedTerminationClasses: [] }))).toContain('termination_classes_empty');
  });

  it('9. a matched diagnostic preserves ExecutionState (never rewrites nonzero_exit) and emits no ExecutionState', () => {
    const obs = observed();
    const e = evaluateExpectedOutcome(contract(), obs, TEST);
    expect(e.verdict).toBe('matched');
    expect(obs.terminationClass).toBe('nonzero_exit'); // input untouched
    const claim = projectDiagnosticClaim(contract(), e);
    expect(claim.state).toBe('verified');
    expect('executionState' in claim).toBe(false);
    expect(JSON.stringify(claim)).not.toContain('succeeded');
  });

  it('10. a matched diagnostic is resource-scoped — cannot satisfy an unrelated claim', () => {
    const a = projectDiagnosticClaim(contract(), evaluateExpectedOutcome(contract(), observed(), TEST));
    const otherC = contract({ expectedPredicate: { category: 'path_not_found', subjectResource: 'file:///work/other.txt' } });
    const b = projectDiagnosticClaim(otherC, evaluateExpectedOutcome(otherC, observed({ semantic: { category: 'path_not_found', subjectResource: 'file:///work/other.txt', provenance: 'os_error_code' } }), TEST));
    expect(a.definition.resource).toBe(SUBJECT);
    expect(b.definition.resource).toBe('file:///work/other.txt');
    expect(a.definition.resource).not.toBe(b.definition.resource);
    expect(a.definition.category).toBe('diagnostic');
  });

  it('11. post-hoc inference cannot upgrade an unexpected failure (project → unknown, never verified)', () => {
    const e = evaluateExpectedOutcome(contract({ frozenSequence: 99 }), observed({ startedSequence: 20 }), TEST);
    expect(e.verdict).toBe('invalid_binding');
    const claim = projectDiagnosticClaim(contract(), e);
    expect(claim.state).toBe('unknown');
    expect(claim.state).not.toBe('verified');
  });

  it('12. a retry cannot reuse a stale expectation binding → invalid_binding (plan unchanged, new attempt)', () => {
    const e = evaluateExpectedOutcome(contract(), observed({ attemptScope: { providerCallId: 'call-1', attemptId: 'attempt-2' } }), TEST);
    expect(e.verdict).toBe('invalid_binding');
    expect(e.reasons).toContain('stale_attempt_binding');
  });

  it('13. raw output only (weak_text_match) cannot conclusively prove a category → unknown', () => {
    const e = evaluateExpectedOutcome(contract(), observed({ semantic: { category: 'path_not_found', subjectResource: SUBJECT, provenance: 'weak_text_match' } }), TEST);
    expect(e.verdict).toBe('unknown');
    expect(e.reasons).toContain('provenance_insufficient');
  });

  it('14. expected path_not_found + observed unclassified + exit matches → unknown (absence ≠ contradiction)', () => {
    const e = evaluateExpectedOutcome(contract(), observed({ semantic: { category: 'unclassified', provenance: 'os_error_code' } }), TEST);
    expect(e.verdict).toBe('unknown');
    expect(e.reasons).toContain('observed_unclassified');
  });

  it('15. category provenance only agent_assertion where trusted is required → unknown, never matched (self-grading door shut)', () => {
    const e = evaluateExpectedOutcome(contract(), observed({ semantic: { category: 'path_not_found', subjectResource: SUBJECT, provenance: 'agent_assertion' } }), TEST);
    expect(e.verdict).toBe('unknown');
    expect(e.verdict).not.toBe('matched');
    expect(e.reasons).toContain('provenance_insufficient');
  });

  it('16. a matched diagnostic does NOT auto-force completed_with_warning', () => {
    const e = evaluateExpectedOutcome(contract(), observed(), TEST);
    const claim = projectDiagnosticClaim(contract(), e);
    expect(claim.state).toBe('verified');
    expect(JSON.stringify(claim)).not.toContain('completed_with_warning');
    expect(JSON.stringify(claim)).not.toContain('warning');
  });

  it('17. projection mapping — matched→verified, mismatched→failed, invalid_binding→unknown (NEVER failed), reason preserved', () => {
    const matched = evaluateExpectedOutcome(contract(), observed(), TEST);
    const mismatched = evaluateExpectedOutcome(contract(), observed({ exitCode: 7 }), TEST);
    const invalidBind = evaluateExpectedOutcome(contract({ frozenSequence: 99 }), observed({ startedSequence: 1 }), TEST);
    const invalidContract = evaluateExpectedOutcome(contract({ acceptedExitCodes: { kind: 'any_nonzero' } }), observed(), TEST);

    expect(projectDiagnosticClaim(contract(), matched).state).toBe('verified');
    expect(projectDiagnosticClaim(contract(), mismatched).state).toBe('failed');

    const bindClaim = projectDiagnosticClaim(contract(), invalidBind);
    expect(bindClaim.state).toBe('unknown');            // a stale binding is NOT a genuine mismatch
    expect(bindClaim.state).not.toBe('failed');
    expect(bindClaim.reason).toContain('invalid_binding'); // the distinct verdict survives

    expect(projectDiagnosticClaim(contract(), invalidContract).state).toBe('unknown');
  });
});

describe('expectedOutcome — the six refinement teeth', () => {
  it('R4. subject-bound mismatch — path_not_found(A) vs observed path_not_found(B) → mismatched', () => {
    const e = evaluateExpectedOutcome(
      contract(), // expects path_not_found(report.json)
      observed({ semantic: { category: 'path_not_found', subjectResource: 'file:///work/DIFFERENT.txt', provenance: 'os_error_code' } }),
      TEST,
    );
    expect(e.verdict).toBe('mismatched');
    expect(e.reasons).toContain('semantic_predicate_contradicted');
  });

  it('R2. the anti-post-hoc gate is the MONOTONIC sequence, not the wall clock', () => {
    // clock says post-hoc (frozenAt 9999 > startedAt 1) but sequence says fine → matched
    const clockSaysPostHoc = evaluateExpectedOutcome(
      contract({ frozenSequence: 10, frozenAt: 9999 }),
      observed({ startedSequence: 20, startedAt: 1 }),
      TEST,
    );
    expect(clockSaysPostHoc.verdict).toBe('matched');
    // clock says fine (frozenAt 1 < startedAt 9999) but sequence says post-hoc → invalid_binding
    const seqSaysPostHoc = evaluateExpectedOutcome(
      contract({ frozenSequence: 30, frozenAt: 1 }),
      observed({ startedSequence: 20, startedAt: 9999 }),
      TEST,
    );
    expect(seqSaysPostHoc.verdict).toBe('invalid_binding');
    expect(seqSaysPostHoc.reasons).toContain('frozen_after_execution_start');
  });

  it('R5. provenance is per-predicate — os_error_code proves path_not_found but NOT no_match', () => {
    // path_not_found + os_error_code → matched
    expect(evaluateExpectedOutcome(contract(), observed(), TEST).verdict).toBe('matched');
    // no_match + os_error_code → unknown (os_error_code is not authoritative for a semantic no_match)
    const noMatchC = contract({ expectedPredicate: { category: 'no_match', subjectResource: 'file:///work/log.txt', queryDigest: 'q-1' } });
    const osProv = evaluateExpectedOutcome(noMatchC, observed({ semantic: { category: 'no_match', subjectResource: 'file:///work/log.txt', queryDigest: 'q-1', provenance: 'os_error_code' } }), TEST);
    expect(osProv.verdict).toBe('unknown');
    expect(osProv.reasons).toContain('provenance_insufficient');
    // no_match + trusted_semantics_profile → matched
    const semProv = evaluateExpectedOutcome(noMatchC, observed({ semantic: { category: 'no_match', subjectResource: 'file:///work/log.txt', queryDigest: 'q-1', provenance: 'trusted_semantics_profile' } }), TEST);
    expect(semProv.verdict).toBe('matched');
  });

  it('R-synthetic. a production-shaped observation carrying synthetic_test provenance is rejected (never matched)', () => {
    const synthObs = observed({ semantic: { category: 'path_not_found', subjectResource: SUBJECT, provenance: 'synthetic_test' } });
    // production (no allowSyntheticTest) → rejected
    const prod = evaluateExpectedOutcome(contract(), synthObs /* no opts */);
    expect(prod.verdict).toBe('invalid_binding');
    expect(prod.verdict).not.toBe('matched');
    expect(prod.reasons).toContain('synthetic_provenance_in_production');
    // under the explicit test flag → admissible
    expect(evaluateExpectedOutcome(contract(), synthObs, { allowSyntheticTest: true }).verdict).toBe('matched');
  });

  it('R6. a forbidden effect yields BOTH a mismatch AND an independently-preserved policy observation', () => {
    const e = evaluateExpectedOutcome(
      contract({ forbiddenEffects: ['file_delete', 'network_send'] }),
      observed({ observedEffects: [{ kind: 'network_send', subjectResource: 'net://evil.example' }] }),
      TEST,
    );
    expect(e.verdict).toBe('mismatched');
    expect(e.reasons).toContain('forbidden_effect_observed');
    // NOT buried in a string — a structured, retainable observation:
    expect(e.forbiddenObservation).toEqual({
      effect: 'network_send',
      subjectResource: 'net://evil.example',
      executionPlanDigest: PLAN,
      source: 'observed_effect',
    });
  });
});
