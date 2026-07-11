/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/expectedOutcome.ts — P1B-3A: the PURE expected-outcome matcher.
 *
 * Given a FROZEN expected-outcome contract and an already-normalized observed
 * outcome, decide whether a diagnostic (expected-failure) claim is satisfied.
 * ZERO real extraction: this module never parses stderr, inspects command names,
 * applies regex, or interprets what an exit code MEANS. It reasons only over
 * structured inputs. Deriving those inputs from real commands is the extractor,
 * P1B-3C — a separate module, deliberately not merged here.
 *
 * The governing rule, enforced structurally (not procedurally): the agent may
 * PREDICT a failure, but it cannot DEFINE success after seeing the result.
 * Three independent gates make that true before the semantic category is ever
 * compared:
 *   - TIME     — the expectation was frozen before execution, proven by a
 *                MONOTONIC sequence (`frozenSequence < startedSequence`), never a
 *                wall-clock timestamp (defeatable by skew, ties, coarse res).
 *   - BINDING  — the same execution plan (opaque digest, equality only) AND the
 *                same attempt (a retry gets a new attempt scope, never reuses a
 *                stale expectation).
 *   - PROVENANCE — each semantic predicate declares which provenance kinds are
 *                authoritative for IT; `agent_assertion` / `weak_text_match` can
 *                never independently satisfy a diagnostic, and `synthetic_test`
 *                is structurally test-only.
 *
 * Fail-closed precedence: invalid_contract → invalid_binding → mismatched →
 * unknown → matched. A stale binding is NEVER a genuine mismatch; an absence of
 * evidence is NEVER a contradiction. Correct output never erases unsafe
 * execution: a forbidden effect yields BOTH a mismatch AND an independently
 * preserved policy observation.
 *
 * Deferred (do NOT add here): real category extraction / stderr parsing / regex
 * / exit-code interpretation (3C), proposal-time freezing at approval (3B), the
 * trusted-semantics registry (3C), user-contract compilation (3D). No live
 * verdict authority, no wiring, no telemetry.
 */

import type { ResourceId } from './executionContract';
import type { ClaimDefinition, ClaimEvaluation, ClaimState } from './claimVerifier';

/** Bumped when the contract SHAPE or the decision logic changes. */
export const EXPECTED_OUTCOME_MATCHER_VERSION = 'eom1';

// ── Closed, versioned vocabularies ───────────────────────────────────────────

/** Observed termination taxonomy — LOCAL to this module (an observation model,
 *  distinct from P1A `ExecutionState`, which we never touch). For this slice the
 *  only expectation kind is `predicate_failure`, which permits exactly
 *  `nonzero_exit`. Future timeout/crash diagnostic kinds get their OWN contract
 *  kinds — we do NOT bake a universal "crashes can never be expected" rule. */
export type TerminationClass =
  | 'nonzero_exit'
  | 'timed_out'
  | 'crashed'
  | 'cancelled'
  | 'signal_terminated';

/** Closed semantic vocabulary. `unclassified` is OBSERVED-only — you cannot
 *  EXPECT unclassified (absence is not a prediction). */
export type SemanticCategory =
  | 'path_not_found'
  | 'access_denied'
  | 'no_match'
  | 'files_differ'
  | 'validation_rejected'
  | 'connection_refused'
  | 'invalid_argument'
  | 'unclassified';

/** Provenance travels with every observed category. `agent_assertion` and
 *  `weak_text_match` are never authoritative for any predicate; `synthetic_test`
 *  is admissible only under an explicit test flag (see `MatchOptions`). */
export type CategoryProvenance =
  | 'trusted_tool_result'
  | 'os_error_code'
  | 'trusted_semantics_profile'
  | 'structured_parser'
  | 'weak_text_match'
  | 'agent_assertion'
  | 'synthetic_test';

/** Where the contract came from. A future slice (3B/3D) may restrict which of
 *  these may freeze at approval; 3A only validates the value is known. */
export type ExpectationSource =
  | 'user_explicit'
  | 'planner_proposed'
  | 'trusted_task_template'
  | 'agent_proposed';

/** Closed effect vocabulary for allowed/forbidden-effect policy. */
export type EffectKind =
  | 'file_write'
  | 'file_delete'
  | 'file_move'
  | 'network_send'
  | 'process_spawn'
  | 'state_mutation';

/** For this slice, the only expectation kind. Each kind fixes which termination
 *  classes it may accept — see `permittedTerminationClasses`. */
export type ExpectationKind = 'predicate_failure';

// ── Subject-bound semantic predicates (refinement 4) ─────────────────────────
//
// A predicate is NOT a bare category — it binds a subject + parameters, so
// `path_not_found(report.json)` can never be satisfied by `path_not_found(other)`.

/** What the contract EXPECTS. No provenance here — the contract declares WHAT to
 *  expect; the observation carries how it was learned. `unclassified` excluded. */
export type ExpectedSemanticPredicate =
  | { readonly category: 'path_not_found'; readonly subjectResource: ResourceId }
  | { readonly category: 'access_denied'; readonly subjectResource: ResourceId }
  | { readonly category: 'no_match'; readonly subjectResource: ResourceId; readonly queryDigest: string }
  | { readonly category: 'files_differ'; readonly subjectResource: ResourceId; readonly otherResource: ResourceId }
  | { readonly category: 'validation_rejected'; readonly subjectResource: ResourceId; readonly schemaDigest?: string }
  | { readonly category: 'connection_refused'; readonly hostDigest: string; readonly port: number }
  | { readonly category: 'invalid_argument'; readonly subjectResource?: ResourceId; readonly argDigest: string };

/** What was OBSERVED — same subject binding + provenance. Includes the
 *  observed-only `unclassified`. */
export type ObservedSemanticResult =
  | { readonly category: 'path_not_found'; readonly subjectResource: ResourceId; readonly provenance: CategoryProvenance }
  | { readonly category: 'access_denied'; readonly subjectResource: ResourceId; readonly provenance: CategoryProvenance }
  | { readonly category: 'no_match'; readonly subjectResource: ResourceId; readonly queryDigest: string; readonly provenance: CategoryProvenance }
  | { readonly category: 'files_differ'; readonly subjectResource: ResourceId; readonly otherResource: ResourceId; readonly provenance: CategoryProvenance }
  | { readonly category: 'validation_rejected'; readonly subjectResource: ResourceId; readonly schemaDigest?: string; readonly provenance: CategoryProvenance }
  | { readonly category: 'connection_refused'; readonly hostDigest: string; readonly port: number; readonly provenance: CategoryProvenance }
  | { readonly category: 'invalid_argument'; readonly subjectResource?: ResourceId; readonly argDigest: string; readonly provenance: CategoryProvenance }
  | { readonly category: 'unclassified'; readonly provenance: CategoryProvenance };

// ── Binding scope (refinement 3): plan digest ≠ attempt scope ────────────────

/** The attempt an expectation is bound to. A retry keeps the SAME plan digest
 *  but a NEW attempt scope — so a stale expectation cannot be reused. */
export interface AttemptScope {
  readonly providerCallId: string;
  readonly attemptId: string;
}

/** Accepted exit codes — a FINITE set, or the overbroad `any_nonzero` sentinel
 *  that the contract validator rejects (laundering-disguised-as-expectation). */
export type AcceptedExitCodes =
  | { readonly kind: 'set'; readonly codes: number[] }
  | { readonly kind: 'any_nonzero' };

// ── The frozen contract + the observed outcome ───────────────────────────────

export interface ExpectedOutcomeContract {
  readonly matcherVersion: string;
  readonly source: ExpectationSource;
  /** AUTHORITATIVE anti-post-hoc gate — monotonic, not a clock. */
  readonly frozenSequence: number;
  /** Wall-clock, REPORT ONLY — never read by the decision (skew-defeatable). */
  readonly frozenAt: number;
  /** Opaque; the matcher compares for equality only, never decomposes it. */
  readonly executionPlanDigest: string;
  readonly attemptScope: AttemptScope;
  readonly expectationKind: ExpectationKind;
  readonly acceptedTerminationClasses: TerminationClass[];
  readonly acceptedExitCodes: AcceptedExitCodes;
  readonly expectedPredicate: ExpectedSemanticPredicate;
  /** When true, a matched result requires ≥1 evidence id present. */
  readonly requiredEvidence: boolean;
  readonly allowedEffects: EffectKind[];
  readonly forbiddenEffects: EffectKind[];
}

export interface ObservedEffect {
  readonly kind: EffectKind;
  readonly subjectResource?: ResourceId;
}

export interface ObservedOutcome {
  readonly executionPlanDigest: string;
  readonly attemptScope: AttemptScope;
  /** AUTHORITATIVE — monotonic execution-start ordinal. */
  readonly startedSequence: number;
  /** Wall-clock, REPORT ONLY. */
  readonly startedAt: number;
  readonly endedAt: number;
  readonly terminationClass: TerminationClass;
  /** null when a code is not applicable (e.g. crashed / signal-terminated). */
  readonly exitCode: number | null;
  readonly semantic: ObservedSemanticResult;
  /** Ids into an already-controlled local evidence store (opaque here). */
  readonly evidenceIds: string[];
  readonly observedEffects: ObservedEffect[];
}

// ── Evaluation result ────────────────────────────────────────────────────────

export type ExpectedOutcomeVerdict =
  | 'matched'
  | 'mismatched'
  | 'unknown'
  | 'invalid_binding'
  | 'invalid_contract';

/**
 * A forbidden effect that actually occurred — preserved INDEPENDENTLY of the
 * matcher's reason string so the evidence/policy layer can retain it and let it
 * outrank normal claims at fold time (wired in 3B/3C). Never buried in a reason.
 */
export interface ForbiddenEffectObservation {
  readonly effect: EffectKind;
  readonly subjectResource?: ResourceId;
  readonly executionPlanDigest: string;
  /** The matcher OBSERVED this from a structured effect — it did not infer it. */
  readonly source: 'observed_effect';
}

export interface ExpectedOutcomeEvaluation {
  readonly verdict: ExpectedOutcomeVerdict;
  /** Machine-readable codes, most-specific first. */
  readonly reasons: string[];
  /** Present iff a forbidden effect occurred — retained by the policy layer. */
  readonly forbiddenObservation?: ForbiddenEffectObservation;
}

export interface MatchOptions {
  /** Structural test-only door: `synthetic_test` provenance is admissible ONLY
   *  when this is explicitly true. Production callers never set it, so a
   *  production-shaped observation carrying `synthetic_test` is rejected. */
  readonly allowSyntheticTest?: boolean;
}

// ── Policy tables (per-predicate provenance; per-kind termination) ───────────

/** Which termination classes an expectation kind may accept. `predicate_failure`
 *  permits ONLY `nonzero_exit`. */
function permittedTerminationClasses(kind: ExpectationKind): TerminationClass[] {
  switch (kind) {
    case 'predicate_failure':
      return ['nonzero_exit'];
  }
}

/**
 * Per-predicate acceptable provenance (refinement 5) — NOT a global rank.
 * `os_error_code` is authoritative for `path_not_found` but NOT for `no_match`
 * (a semantic judgement needs a trusted semantics profile). `agent_assertion`
 * and `weak_text_match` appear in NO set. `synthetic_test` appears in every set
 * but is gated upstream by `allowSyntheticTest`.
 */
function acceptableProvenanceFor(category: SemanticCategory): CategoryProvenance[] {
  const base: CategoryProvenance[] = ['trusted_tool_result', 'structured_parser', 'synthetic_test'];
  switch (category) {
    case 'path_not_found':
    case 'access_denied':
    case 'invalid_argument':
      return [...base, 'os_error_code'];
    case 'connection_refused':
      return [...base, 'os_error_code'];
    case 'no_match':
    case 'files_differ':
      return [...base, 'trusted_semantics_profile']; // os_error_code is NOT authoritative here
    case 'validation_rejected':
      return [...base, 'trusted_semantics_profile'];
    case 'unclassified':
      return []; // nothing authoritatively proves an unclassified outcome
  }
}

const KNOWN_SOURCES = new Set<ExpectationSource>(['user_explicit', 'planner_proposed', 'trusted_task_template', 'agent_proposed']);
const KNOWN_EFFECTS = new Set<EffectKind>(['file_write', 'file_delete', 'file_move', 'network_send', 'process_spawn', 'state_mutation']);

// ── Contract validation (fail-closed; overbroad = laundering) ────────────────

/** Returns the reason codes that make a contract invalid, or [] when it is well
 *  formed. Overbroad contracts are laundering-tools-disguised-as-expectations. */
export function validateContract(contract: ExpectedOutcomeContract): string[] {
  const reasons: string[] = [];
  if (!contract.matcherVersion) reasons.push('missing_matcher_version');
  if (!KNOWN_SOURCES.has(contract.source)) reasons.push('unknown_source');
  // exit codes: reject the overbroad `any_nonzero`, and a finite set must be
  // non-empty + all genuinely-nonzero integers (0 is not a diagnostic failure).
  if (contract.acceptedExitCodes.kind === 'any_nonzero') {
    reasons.push('exit_codes_any_nonzero_overbroad');
  } else {
    const codes = contract.acceptedExitCodes.codes;
    if (codes.length === 0) reasons.push('exit_codes_empty');
    if (codes.some((c) => !Number.isInteger(c))) reasons.push('exit_codes_non_integer');
    if (codes.some((c) => c === 0)) reasons.push('exit_code_zero_not_diagnostic');
  }
  // termination classes: non-empty AND ⊆ what the kind permits.
  const permitted = new Set(permittedTerminationClasses(contract.expectationKind));
  if (contract.acceptedTerminationClasses.length === 0) reasons.push('termination_classes_empty');
  if (contract.acceptedTerminationClasses.some((t) => !permitted.has(t))) {
    reasons.push('termination_class_not_permitted_for_kind');
  }
  // predicate: must be a well-formed subject-bound predicate (not unclassified,
  // required params present).
  reasons.push(...validatePredicate(contract.expectedPredicate));
  // effects must be known kinds.
  if (contract.allowedEffects.some((e) => !KNOWN_EFFECTS.has(e))) reasons.push('unknown_allowed_effect');
  if (contract.forbiddenEffects.some((e) => !KNOWN_EFFECTS.has(e))) reasons.push('unknown_forbidden_effect');
  return reasons;
}

function validatePredicate(p: ExpectedSemanticPredicate): string[] {
  const bad = (why: string): string[] => [why];
  switch (p.category) {
    case 'path_not_found':
    case 'access_denied':
      return p.subjectResource ? [] : bad('predicate_missing_subject');
    case 'no_match':
      return p.subjectResource && p.queryDigest ? [] : bad('predicate_missing_no_match_params');
    case 'files_differ':
      return p.subjectResource && p.otherResource ? [] : bad('predicate_missing_files_differ_params');
    case 'validation_rejected':
      return p.subjectResource ? [] : bad('predicate_missing_subject');
    case 'connection_refused':
      return p.hostDigest && Number.isInteger(p.port) ? [] : bad('predicate_missing_connection_params');
    case 'invalid_argument':
      return p.argDigest ? [] : bad('predicate_missing_arg_digest');
  }
}

// ── Subject-bound predicate matching (refinement 4) ──────────────────────────

type PredicateMatch = 'match' | 'contradict' | 'inconclusive';

/** Category AND subject/params must agree. A same-category, different-subject
 *  observation CONTRADICTS (it is a different proposition, not the expected
 *  one). `unclassified` is inconclusive — an absence, never a contradiction. */
function matchPredicate(exp: ExpectedSemanticPredicate, obs: ObservedSemanticResult): PredicateMatch {
  if (obs.category === 'unclassified') return 'inconclusive';
  if (obs.category !== exp.category) return 'contradict';
  // same category — compare the subject binding.
  switch (exp.category) {
    case 'path_not_found':
    case 'access_denied':
    case 'validation_rejected': {
      const o = obs as { subjectResource: ResourceId };
      return o.subjectResource === exp.subjectResource ? 'match' : 'contradict';
    }
    case 'no_match': {
      const o = obs as { subjectResource: ResourceId; queryDigest: string };
      return o.subjectResource === exp.subjectResource && o.queryDigest === exp.queryDigest ? 'match' : 'contradict';
    }
    case 'files_differ': {
      const o = obs as { subjectResource: ResourceId; otherResource: ResourceId };
      return o.subjectResource === exp.subjectResource && o.otherResource === exp.otherResource ? 'match' : 'contradict';
    }
    case 'connection_refused': {
      const o = obs as { hostDigest: string; port: number };
      return o.hostDigest === exp.hostDigest && o.port === exp.port ? 'match' : 'contradict';
    }
    case 'invalid_argument': {
      const o = obs as { subjectResource?: ResourceId; argDigest: string };
      return o.argDigest === exp.argDigest && o.subjectResource === exp.subjectResource ? 'match' : 'contradict';
    }
  }
}

function attemptScopeEqual(a: AttemptScope, b: AttemptScope): boolean {
  return a.providerCallId === b.providerCallId && a.attemptId === b.attemptId;
}

// ── The matcher ──────────────────────────────────────────────────────────────

/**
 * Decide whether the observed outcome satisfies the frozen contract. PURE.
 * Fail-closed precedence: invalid_contract → invalid_binding → mismatched →
 * unknown → matched. Timestamps are ignored — the anti-post-hoc gate is the
 * monotonic sequence.
 */
export function evaluateExpectedOutcome(
  contract: ExpectedOutcomeContract,
  observed: ObservedOutcome,
  opts: MatchOptions = {},
): ExpectedOutcomeEvaluation {
  // 1 — invalid_contract (a malformed/overbroad contract binds nothing).
  const contractErrors = validateContract(contract);
  if (contractErrors.length > 0) {
    return { verdict: 'invalid_contract', reasons: contractErrors };
  }

  // 2 — invalid_binding (observation admissibility + time + plan + attempt).
  // 2a — structural test-only door: a production-shaped observation carrying
  //      `synthetic_test` provenance is inadmissible.
  if (!opts.allowSyntheticTest && observed.semantic.provenance === 'synthetic_test') {
    return { verdict: 'invalid_binding', reasons: ['synthetic_provenance_in_production'] };
  }
  // 2b — anti-post-hoc: proven by MONOTONIC sequence, never the clock.
  if (contract.frozenSequence >= observed.startedSequence) {
    return { verdict: 'invalid_binding', reasons: ['frozen_after_execution_start'] };
  }
  // 2c — same plan?
  if (contract.executionPlanDigest !== observed.executionPlanDigest) {
    return { verdict: 'invalid_binding', reasons: ['plan_digest_mismatch'] };
  }
  // 2d — same attempt? (plan already matched → a mismatch here is a stale retry.)
  if (!attemptScopeEqual(contract.attemptScope, observed.attemptScope)) {
    return { verdict: 'invalid_binding', reasons: ['stale_attempt_binding'] };
  }

  // 3 — forbidden effect: BOTH a mismatch AND a preserved policy observation.
  //     Checked before any "matched" path — correct output never erases unsafe
  //     execution.
  const forbidden = observed.observedEffects.find((e) => contract.forbiddenEffects.includes(e.kind));
  if (forbidden) {
    return {
      verdict: 'mismatched',
      reasons: ['forbidden_effect_observed'],
      forbiddenObservation: {
        effect: forbidden.kind,
        subjectResource: forbidden.subjectResource,
        executionPlanDigest: observed.executionPlanDigest,
        source: 'observed_effect',
      },
    };
  }

  // 4 — mismatched (positive contradictions).
  if (!contract.acceptedTerminationClasses.includes(observed.terminationClass)) {
    return { verdict: 'mismatched', reasons: ['termination_class_not_accepted'] };
  }
  const exitAccepted =
    contract.acceptedExitCodes.kind === 'set' &&
    observed.exitCode !== null &&
    contract.acceptedExitCodes.codes.includes(observed.exitCode);
  if (!exitAccepted) {
    return { verdict: 'mismatched', reasons: ['exit_code_not_accepted'] };
  }
  const pm = matchPredicate(contract.expectedPredicate, observed.semantic);
  if (pm === 'contradict') {
    return { verdict: 'mismatched', reasons: ['semantic_predicate_contradicted'] };
  }
  if (contract.allowedEffects.length > 0 && observed.observedEffects.some((e) => !contract.allowedEffects.includes(e.kind))) {
    return { verdict: 'mismatched', reasons: ['effect_outside_allowed_policy'] };
  }

  // 5 — unknown (insufficient proof; absence ≠ contradiction).
  if (pm === 'inconclusive') {
    return { verdict: 'unknown', reasons: ['observed_unclassified'] };
  }
  if (!acceptableProvenanceFor(observed.semantic.category).includes(observed.semantic.provenance)) {
    return { verdict: 'unknown', reasons: ['provenance_insufficient'] };
  }
  if (contract.requiredEvidence && observed.evidenceIds.length === 0) {
    return { verdict: 'unknown', reasons: ['required_evidence_missing'] };
  }

  // 6 — matched: every condition held.
  return { verdict: 'matched', reasons: ['all_conditions_satisfied'] };
}

// ── Projection to a P1B-1-shaped diagnostic claim ────────────────────────────

/** The resource a predicate is about (for claim-scoping). */
function subjectResourceOf(p: ExpectedSemanticPredicate): ResourceId | undefined {
  switch (p.category) {
    case 'connection_refused':
      return `net://${p.hostDigest}:${p.port}`;
    case 'invalid_argument':
      return p.subjectResource;
    default:
      return p.subjectResource;
  }
}

/** A stable, sensitive-data-free label for the predicate. */
function predicateLabel(p: ExpectedSemanticPredicate): string {
  return `${p.category}(${subjectResourceOf(p) ?? 'unbound'})`;
}

/**
 * Map an evaluation to a P1B-1 `ClaimEvaluation` (category `diagnostic`),
 * claim-scoped to the predicate's subject. RESULT SEPARATION: this returns a
 * claim only — no `ExecutionState` (a matched diagnostic leaves `nonzero_exit`
 * intact) and no `completed_with_warning` (a normal matched diagnostic is just
 * `verified`). A stale binding maps to `unknown`, NEVER `failed` — the distinct
 * verdict is preserved in the reason.
 */
export function projectDiagnosticClaim(
  contract: ExpectedOutcomeContract,
  evaluation: ExpectedOutcomeEvaluation,
): ClaimEvaluation {
  const resource: ResourceId = subjectResourceOf(contract.expectedPredicate) ?? `expectation://${contract.executionPlanDigest}`;
  const definition: ClaimDefinition = {
    id: `diagnostic:${contract.executionPlanDigest}:${contract.expectedPredicate.category}`,
    category: 'diagnostic',
    resource,
    predicate: predicateLabel(contract.expectedPredicate),
    required: true,
  };
  const state: ClaimState =
    evaluation.verdict === 'matched' ? 'verified'
      : evaluation.verdict === 'mismatched' ? 'failed'
        : 'unknown'; // unknown | invalid_binding | invalid_contract — distinction kept in reason
  return {
    definition,
    state,
    reason: `${evaluation.verdict}:${evaluation.reasons.join(',')}`,
    evidence: [],
  };
}
