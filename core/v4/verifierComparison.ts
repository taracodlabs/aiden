/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/verifierComparison.ts — Dual-run Slice 1: the PURE verdict comparator.
 *
 * Computes a divergence classification between the legacy (user-authoritative)
 * verdict and the new claim-verifier evaluation, per turn. Knows NOTHING about
 * files, storage, network, or dashboards — it takes both verdicts plus the exact
 * inputs the claim fold consumed and returns one machine-readable record. The
 * caller appends the record to a local store; a future opt-in exporter is
 * deferred (no network code here).
 *
 * Non-negotiable safety posture:
 *   - The verdict pair only TRIGGERS classification; it never justifies it. The
 *     comparator independently re-checks the new verifier's success invariants
 *     from the INPUTS (coverage, per-claim evidence, forbidden conditions,
 *     temporal/attribution evidence, failure lineage) — it never trusts the new
 *     verdict's own `verdict === 'verified'` claim as proof.
 *   - Safety precedence, in order: DANGEROUS_LENIENCY first, then the
 *     comparability gate, then EXPECTED_FIX / EXPECTED_STRICTNESS.
 *   - Fail-closed: anything not mechanically proven ⇒ UNEXPLAINED (which BLOCKS
 *     rollout; it is not neutral). "Legacy failed → new verified" defaults to
 *     UNEXPLAINED unless the one narrow rule proves EXPECTED_FIX with every
 *     obligation met.
 *
 * Slice 1 ships exactly ONE EXPECTED_FIX rule: `unrelated_failure_contamination`.
 * Everything else is UNEXPLAINED — the many-UNEXPLAINED outcome is CORRECT: the
 * comparator refuses to manufacture confidence before the rule library exists.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { TaskVerdict, TaskVerificationFailure } from './taskVerification';
import {
  isForbiddenConfirmed,
  type ShadowClaimDetail,
  type TaskClaimVerdict,
  type ClaimEvaluation,
  type EvidenceLedger,
  type Coverage,
} from './claimVerifier';
import type { CommandRecord, ResourceId } from './executionContract';
import {
  classifyEnvelope,
  evaluateTransition,
  attributeTransition,
  type SnapshotPair,
  type TransitionTruth,
} from './temporalEvidence';

/** Bumped when the record SHAPE changes; consumers read this before parsing. */
export const COMPARISON_SCHEMA_VERSION = 'dvc1';
/** Bumped when the CLASSIFICATION LOGIC changes (so old records stay attributable
 *  to the logic that produced them). */
export const COMPARATOR_VERSION = 'dvc1';

// ── The verdict spaces + canonical normalization (refinement 2) ──────────────

/** Legacy finalization status (computeTaskFinalization can also yield 'failed'). */
export type LegacyStatus = TaskVerdict | 'failed';

/** A shared, ordered outcome space so the two enums can be compared for
 *  divergence DIRECTION. Both originals are preserved on the record. */
export type CanonicalOutcome = 'success' | 'weak_success' | 'partial' | 'denied' | 'failure';
const CANON_RANK: Record<CanonicalOutcome, number> = {
  failure: 0,
  denied: 0,
  partial: 1,
  weak_success: 2,
  success: 3,
};

function canonicalizeLegacy(v: LegacyStatus): CanonicalOutcome {
  switch (v) {
    case 'completed': return 'success';
    case 'completed_unverified': return 'weak_success';
    case 'verification_failed':
    case 'failed': return 'failure';
  }
}

function canonicalizeNew(v: TaskClaimVerdict): CanonicalOutcome {
  switch (v) {
    case 'verified': return 'success';
    case 'unverified': return 'weak_success';
    case 'partial': return 'partial';
    case 'denied': return 'denied';
    case 'failed': return 'failure';
  }
}

export type DivergenceDirection = 'agree' | 'new_more_lenient' | 'new_stricter';

function divergenceDirection(legacy: CanonicalOutcome, next: CanonicalOutcome): DivergenceDirection {
  const d = CANON_RANK[next] - CANON_RANK[legacy];
  if (d > 0) return 'new_more_lenient';
  if (d < 0) return 'new_stricter';
  return 'agree';
}

// ── Buckets, invariants, the record ──────────────────────────────────────────

export type Bucket = 'DANGEROUS_LENIENCY' | 'EXPECTED_FIX' | 'EXPECTED_STRICTNESS' | 'UNEXPLAINED';

export type InvariantId =
  | 'I1_coverage_complete'
  | 'I2_required_verified_from_evidence'
  | 'I3_required_has_evidence'
  | 'I4_no_forbidden_condition'
  | 'I5_temporal_transition_proven'
  | 'I6_attribution_sufficient'
  | 'I7_failure_lineage_reconciled';

export const UNRELATED_FAILURE_CONTAMINATION = 'unrelated_failure_contamination';

type Status = 'pass' | 'fail' | 'unknown';
interface InvariantOutcome {
  readonly id: InvariantId;
  /** False ⇒ the invariant does not apply to this turn (not counted in checked). */
  readonly applicable: boolean;
  readonly status: Status;
}

/** The legacy verdict, projected to just what the comparator needs. The caller
 *  builds this from `computeTaskFinalization`'s output — raw reason strings are
 *  READ here (to normalize to codes) but NEVER emitted onto the record. */
export interface LegacyVerdictInput {
  readonly status: LegacyStatus;
  readonly failures: readonly TaskVerificationFailure[];
  /** Verifier codes from the legacy evidence handles (already code-shaped). */
  readonly handleCodes?: readonly string[];
}

export interface CompareOptions {
  /** Injected clock — the comparator is pure and never calls Date.now(). */
  readonly now: number;
  readonly turnId: string;
  readonly taskId?: string;
  /** Injected resource digester — the record persists digests, never raw ids. */
  readonly digest: (id: ResourceId) => string;
  /** Temporal pairs for the turn (P1B-2B). Absent in slice-1 production, so I5
   *  is inapplicable there; teeth supply them to exercise the invariant. */
  readonly snapshots?: readonly SnapshotPair[];
  readonly verifierVersion?: string;
  readonly classifierVersion?: string;
}

/** The proof-trail record. Privacy-minimized BY CONSTRUCTION: every resource is
 *  a keyed digest, every reason a normalized code, evidence a count — no raw
 *  prompt, command line, file content, secret, or path is representable here. */
export interface DivergenceComparisonRecord {
  readonly schemaVersion: string;
  readonly turnId: string;
  readonly taskId?: string;
  readonly recordedAt: number;
  readonly verifierVersion: string;
  readonly classifierVersion: string;
  /** Both original enums preserved (refinement 2). */
  readonly legacyVerdict: LegacyStatus;
  readonly newVerdict: TaskClaimVerdict;
  readonly legacyCanonical: CanonicalOutcome;
  readonly newCanonical: CanonicalOutcome;
  readonly divergenceDirection: DivergenceDirection;
  readonly legacyReasonCodes: string[];
  readonly newReasonCodes: string[];
  readonly bucket: Bucket;
  readonly classificationRuleId: string | null;
  readonly invariantsChecked: InvariantId[];
  readonly invariantsPassed: InvariantId[];
  readonly invariantsFailed: InvariantId[];
  readonly invariantsUnknown: InvariantId[];
  readonly contractCoverage: Coverage;
  readonly evidenceCompleteness: 'complete' | 'partial' | 'none';
  readonly authorityEligibility: 'eligible' | 'ineligible';
  readonly executionIds: string[];
  readonly claimDigests: string[];
  readonly evidenceCount: number;
  readonly resourceDigests: string[];
}

// ── Resource digest (refinement 7): deterministic-per-install, keyed,
//    path-minimized, versioned. No raw ResourceId/path ever leaves. ───────────

export const RESOURCE_DIGEST_VERSION = 'rd1';

function schemeAndBody(id: ResourceId, root: string): { scheme: string; body: string } {
  if (id.startsWith('file://')) {
    const p = id.slice('file://'.length);
    let rel = p;
    try {
      const r = path.relative(root, p);
      // inside the workspace → workspace-relative; outside → an opaque marker +
      // basename (still hashed away below; the raw path never persists).
      rel = r && !r.startsWith('..') && !path.isAbsolute(r) ? r : `ext/${path.basename(p)}`;
    } catch {
      rel = path.basename(p);
    }
    return { scheme: 'file', body: rel.replace(/\\/g, '/') };
  }
  const i = id.indexOf('://');
  return i >= 0 ? { scheme: id.slice(0, i), body: id.slice(i + 3) } : { scheme: 'other', body: id };
}

/**
 * Build a resource digester keyed by an installation-local secret. Same resource
 * → same digest within an install (so records group), but not correlatable
 * across installs (the key differs). Path-minimized + versioned. PURE.
 */
export function makeResourceDigester(installKey: string, cwd: string): (id: ResourceId) => string {
  const root = cwd || '';
  return (id: ResourceId): string => {
    const { scheme, body } = schemeAndBody(id, root);
    const h = createHash('sha256')
      .update(installKey).update(' ')
      .update(scheme).update(' ')
      .update(body)
      .digest('hex')
      .slice(0, 20);
    return `${RESOURCE_DIGEST_VERSION}:${scheme}:${h}`;
  };
}

// ── Predicate policy (refinement 4): which evidence a claim's predicate needs ─

/** The transition a claim's predicate asserts, or null for a current-state claim.
 *  Only transition claims require temporal proof (I5). */
function transitionKindAsserted(predicate: string): Extract<TransitionTruth, 'created' | 'modified' | 'deleted'> | null {
  const p = predicate.toLowerCase();
  if (/\b(delete|deleted|remove|removed|moved_from)\b/.test(p)) return 'deleted';
  if (/\b(modify|modified|update|updated|change|changed|append|appended)\b/.test(p)) return 'modified';
  if (/\b(create|created|wrote|write|written|generate|generated|produce|produced|moved_to)\b/.test(p)) return 'created';
  return null;
}

/** Does the claim assert a PRODUCER IDENTITY (who caused it)? Only these require
 *  attribution proof (I6). */
function assertsProducerIdentity(predicate: string): boolean {
  return /\b(producer|produced by|authored by|author|attributed|by command|caused by)\b/.test(predicate.toLowerCase());
}

// ── Independent invariant recheck (reads inputs, never the new verdict) ───────

/** I2 — re-derive "verified" straight from the ledger's latest observation for
 *  the claim's resource. Reads the ledger, not `claim.state`. */
function claimVerifiedFromEvidence(claim: ClaimEvaluation, ledger: EvidenceLedger): boolean {
  const entries = ledger.forResource(claim.definition.resource);
  const last = entries[entries.length - 1];
  return !!last && last.kind === 'resource_touch' && last.verifierOk === true && last.verificationCode === 'ok';
}

/**
 * I7 — failure-lineage reconciliation (refinement 3). Earlier failures stay
 * visible in the append-only ledger and can never SUPPORT a verified claim; but
 * a later INDEPENDENT observation (a different execution) may legitimately verify
 * a recovered resource, and one earlier failure does not permanently poison it.
 * An unresolved current contradiction (the latest observation is not a clean
 * verify) blocks success.
 */
function lineageReconciled(claim: ClaimEvaluation, ledger: EvidenceLedger): boolean {
  const entries = ledger.forResource(claim.definition.resource);
  const last = entries[entries.length - 1];
  const lastClean = !!last && last.kind === 'resource_touch' && last.verifierOk === true && last.verificationCode === 'ok';
  if (!lastClean) return false; // unresolved / current contradiction blocks success
  const failing = entries.find(
    (e) => (e.kind === 'resource_touch' && e.verifierOk === false) || e.kind === 'error' || e.kind === 'denied',
  );
  if (!failing) return true; // no earlier failure — clean lineage
  // recovery is legitimate ONLY when the verifying observation is independent of
  // the failing one (a different command actually fixed it).
  return last!.executionId !== failing.executionId;
}

/** I5 — a transition claim needs a proven transition; unknown pre/post can never
 *  prove one (that is the stale-artifact-laundering boundary). */
function temporalStatus(claim: ClaimEvaluation, snapshots: readonly SnapshotPair[]): Status {
  const kind = transitionKindAsserted(claim.definition.predicate);
  if (!kind) return 'pass'; // not a transition claim — inapplicable, treated as pass
  const pairs = snapshots.filter((s) => s.resource === claim.definition.resource);
  if (pairs.length === 0) return 'fail'; // asserts a transition with zero temporal proof
  let sawIndeterminate = false;
  for (const pair of pairs) {
    const env = classifyEnvelope({ resources: [pair.resource], mutates: true });
    const ev = evaluateTransition(pair.pre, pair.post, env);
    if (ev.transitionTruth === kind) return 'pass';
    if (ev.transitionTruth === 'indeterminate') sawIndeterminate = true;
  }
  return sawIndeterminate ? 'unknown' : 'fail';
}

/** I6 — a producer-identity claim needs isolated attribution (a single exact
 *  writer). Envelope overlap only; no watcher/journal here. */
function attributionStatus(claim: ClaimEvaluation, records: readonly CommandRecord[]): Status {
  const envelopes = records.map((r) =>
    classifyEnvelope({ resources: r.resources.map((x) => x.resource), mutates: r.proposal.mutates }),
  );
  return attributeTransition(claim.definition.resource, envelopes) === 'isolated' ? 'pass' : 'fail';
}

/** fail dominates unknown dominates pass. */
function worst(statuses: Status[]): Status {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('unknown')) return 'unknown';
  return 'pass';
}

function recheckInvariants(detail: ShadowClaimDetail, snapshots: readonly SnapshotPair[]): InvariantOutcome[] {
  const { evaluation, contract, records, ledger } = detail;
  const req = evaluation.required;
  const perClaim = req.length > 0;
  const out: InvariantOutcome[] = [];

  out.push({ id: 'I1_coverage_complete', applicable: true, status: contract.coverage === 'complete' ? 'pass' : 'fail' });

  const forbidden = contract.forbiddenConditions.filter((fc) => isForbiddenConfirmed(fc, ledger));
  out.push({ id: 'I4_no_forbidden_condition', applicable: true, status: forbidden.length === 0 ? 'pass' : 'fail' });

  out.push({
    id: 'I3_required_has_evidence',
    applicable: perClaim,
    status: !perClaim ? 'pass' : req.every((c) => c.evidence.length > 0) ? 'pass' : 'fail',
  });
  out.push({
    id: 'I2_required_verified_from_evidence',
    applicable: perClaim,
    status: !perClaim ? 'pass' : req.every((c) => claimVerifiedFromEvidence(c, ledger)) ? 'pass' : 'fail',
  });
  out.push({
    id: 'I7_failure_lineage_reconciled',
    applicable: perClaim,
    status: !perClaim ? 'pass' : req.every((c) => lineageReconciled(c, ledger)) ? 'pass' : 'fail',
  });

  const transitionClaims = req.filter((c) => transitionKindAsserted(c.definition.predicate) !== null);
  out.push({
    id: 'I5_temporal_transition_proven',
    applicable: transitionClaims.length > 0,
    status: transitionClaims.length === 0 ? 'pass' : worst(transitionClaims.map((c) => temporalStatus(c, snapshots))),
  });

  const producerClaims = req.filter((c) => assertsProducerIdentity(c.definition.predicate));
  out.push({
    id: 'I6_attribution_sufficient',
    applicable: producerClaims.length > 0,
    status: producerClaims.length === 0 ? 'pass' : worst(producerClaims.map((c) => attributionStatus(c, records))),
  });

  return out;
}

// ── The causal legacy failure set (refinement 5) ─────────────────────────────

function isRecordFailure(r: CommandRecord): boolean {
  return r.execution.state === 'errored' || r.execution.state === 'nonzero_exit' || r.verification.state === 'failed';
}

/** Is the resource STILL failing at the end (its latest observation is a failure)? */
function resourceUnresolved(res: ResourceId, ledger: EvidenceLedger): boolean {
  const entries = ledger.forResource(res);
  const last = entries[entries.length - 1];
  return !!last && ((last.kind === 'resource_touch' && last.verifierOk === false) || last.kind === 'error' || last.kind === 'denied');
}

/**
 * Reconstruct the EXACT unresolved mutating failures that caused the legacy
 * verdict — not every nonzero/error record. Returns their resource set, or
 * `null` when the causal set cannot be reconstructed purely (e.g. legacy failed
 * a record via its injected on-disk check that looks clean in the records). A
 * null result forces UNEXPLAINED at the call site.
 */
function reconstructCausalFailureResources(legacy: LegacyVerdictInput, detail: ShadowClaimDetail): Set<ResourceId> | null {
  const { records, ledger } = detail;
  const failingMutating = records.filter((r) => r.proposal.mutates && isRecordFailure(r));
  const failingTools = new Set(failingMutating.map((r) => r.proposal.tool));
  // every legacy-reported failure must be reproducible from the records; if one
  // is not, we cannot claim to know the causal set → fail closed.
  for (const f of legacy.failures) {
    if (!failingTools.has(f.tool)) return null;
  }
  const resources = new Set<ResourceId>();
  for (const r of failingMutating) {
    for (const ref of r.resources) {
      if (resourceUnresolved(ref.resource, ledger)) resources.add(ref.resource);
    }
  }
  // legacy reported failures but none map to an unresolved resource → cannot tie.
  if (legacy.failures.length > 0 && resources.size === 0) return null;
  return resources;
}

// ── The 5-step decision procedure with safety precedence ─────────────────────

const KNOWN_LEGACY = new Set<LegacyStatus>(['completed', 'completed_unverified', 'verification_failed', 'failed']);
const KNOWN_NEW = new Set<TaskClaimVerdict>(['verified', 'unverified', 'partial', 'denied', 'failed']);

function comparable(legacy: LegacyVerdictInput, detail: ShadowClaimDetail): boolean {
  return KNOWN_LEGACY.has(legacy.status) && KNOWN_NEW.has(detail.evaluation.verdict);
}

function tryUnrelatedFailureContamination(
  legacy: LegacyVerdictInput,
  detail: ShadowClaimDetail,
  outcomes: InvariantOutcome[],
): 'fix' | 'unexplained' | 'no_match' {
  // P0 (trigger only): legacy failed AND new asserts success.
  if (!(legacy.status === 'verification_failed' || legacy.status === 'failed')) return 'no_match';
  if (detail.evaluation.verdict !== 'verified') return 'no_match';
  // P1–P4: every applicable success invariant holds (guaranteed post step-2;
  // re-asserted here so the rule stands on its own).
  if (outcomes.some((o) => o.applicable && o.status !== 'pass')) return 'no_match';
  // P5: the EXACT causal legacy failure set, disjoint from the required claims.
  const causal = reconstructCausalFailureResources(legacy, detail);
  if (causal === null) return 'unexplained'; // refinement 5 — fail closed
  const required = new Set(detail.evaluation.required.map((c) => c.definition.resource));
  const disjoint = causal.size > 0 && [...causal].every((r) => !required.has(r));
  return disjoint ? 'fix' : 'no_match';
}

function isExpectedStrictness(legacy: LegacyVerdictInput, detail: ShadowClaimDetail): boolean {
  const dir = divergenceDirection(canonicalizeLegacy(legacy.status), canonicalizeNew(detail.evaluation.verdict));
  if (dir !== 'new_stricter') return false; // strictness = the NEW verifier withholds
  const ev = detail.evaluation;
  const nothingDisproven = ev.required.every((c) => c.state !== 'failed') && ev.forbiddenConfirmed.length === 0;
  const withheldWeak = ev.verdict === 'unverified' || ev.verdict === 'partial';
  const incomplete = detail.contract.coverage !== 'complete' || ev.required.some((c) => c.state === 'unknown' || c.state === 'unverified');
  return withheldWeak && nothingDisproven && incomplete;
}

function classify(
  legacy: LegacyVerdictInput,
  detail: ShadowClaimDetail,
  outcomes: InvariantOutcome[],
): { bucket: Bucket; ruleId: string | null } {
  // Step 1 — comparable & complete?
  if (!comparable(legacy, detail)) return { bucket: 'UNEXPLAINED', ruleId: null };
  // Step 2 — DANGEROUS first: new asserts success while an invariant is false/unknown.
  if (detail.evaluation.verdict === 'verified' && outcomes.some((o) => o.applicable && o.status !== 'pass')) {
    return { bucket: 'DANGEROUS_LENIENCY', ruleId: null };
  }
  // Step 3 — the one EXPECTED_FIX rule.
  const rule = tryUnrelatedFailureContamination(legacy, detail, outcomes);
  if (rule === 'fix') return { bucket: 'EXPECTED_FIX', ruleId: UNRELATED_FAILURE_CONTAMINATION };
  if (rule === 'unexplained') return { bucket: 'UNEXPLAINED', ruleId: null };
  // Step 4 — EXPECTED_STRICTNESS (new withholds on coverage/evidence, nothing disproven).
  if (isExpectedStrictness(legacy, detail)) return { bucket: 'EXPECTED_STRICTNESS', ruleId: null };
  // Step 5 — fail closed.
  return { bucket: 'UNEXPLAINED', ruleId: null };
}

// ── Privacy-minimized projection ─────────────────────────────────────────────

function normalizeFailureReason(reason: string): string {
  const r = (reason || '').toLowerCase();
  if (r.includes('absent on disk') || r.includes('missing') || r.includes('not found')) return 'reason:missing_artifact';
  if (r.includes('exit')) return 'reason:nonzero_exit';
  if (r.includes('denied')) return 'reason:denied';
  if (r.includes('low_signal') || r.includes('weak') || r.includes('no_progress')) return 'reason:weak_signal';
  if (r.includes('error') || r.includes('threw') || r.includes('crash') || r.includes('fail')) return 'reason:errored';
  return 'reason:other';
}

function legacyReasonCodes(legacy: LegacyVerdictInput): string[] {
  const codes = new Set<string>([`status:${legacy.status}`]);
  for (const f of legacy.failures) codes.add(normalizeFailureReason(f.reason));
  for (const c of legacy.handleCodes ?? []) if (c) codes.add(`handle:${c}`);
  return [...codes].sort();
}

function newReasonCodes(detail: ShadowClaimDetail): string[] {
  const ev = detail.evaluation;
  const codes = new Set<string>([`verdict:${ev.verdict}`, `coverage:${detail.contract.coverage}`]);
  if (ev.forbiddenConfirmed.length > 0) codes.add('new:forbidden_confirmed');
  if (ev.required.length === 0) codes.add('new:no_required_claims');
  const states = new Set(ev.required.map((c) => c.state));
  for (const s of ['failed', 'denied', 'unknown', 'unverified'] as const) {
    if (states.has(s)) codes.add(`new:required_${s}`);
  }
  return [...codes].sort();
}

function evidenceCompleteness(detail: ShadowClaimDetail): 'complete' | 'partial' | 'none' {
  const req = detail.evaluation.required;
  if (req.length === 0) return 'none';
  const withEv = req.filter((c) => c.evidence.length > 0).length;
  if (withEv === 0) return 'none';
  return withEv === req.length ? 'complete' : 'partial';
}

/**
 * The pure comparator. Computes both canonical verdicts, independently re-checks
 * the success invariants, classifies the divergence, and returns a privacy-
 * minimized record. Never throws on well-formed input; the caller still wraps it
 * so a bug can never break finalize.
 */
export function compareVerifiers(
  legacy: LegacyVerdictInput,
  detail: ShadowClaimDetail,
  opts: CompareOptions,
): DivergenceComparisonRecord {
  const snapshots = opts.snapshots ?? [];
  const outcomes = recheckInvariants(detail, snapshots);
  const { bucket, ruleId } = classify(legacy, detail, outcomes);

  const applicable = outcomes.filter((o) => o.applicable);
  const legacyCanonical = canonicalizeLegacy(legacy.status);
  const newCanonical = canonicalizeNew(detail.evaluation.verdict);

  const allResources = new Set<ResourceId>();
  for (const r of detail.records) for (const ref of r.resources) allResources.add(ref.resource);
  for (const c of detail.evaluation.required) allResources.add(c.definition.resource);

  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    turnId: opts.turnId,
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    recordedAt: opts.now,
    verifierVersion: opts.verifierVersion ?? 'p1b',
    classifierVersion: opts.classifierVersion ?? COMPARATOR_VERSION,
    legacyVerdict: legacy.status,
    newVerdict: detail.evaluation.verdict,
    legacyCanonical,
    newCanonical,
    divergenceDirection: divergenceDirection(legacyCanonical, newCanonical),
    legacyReasonCodes: legacyReasonCodes(legacy),
    newReasonCodes: newReasonCodes(detail),
    bucket,
    classificationRuleId: ruleId,
    invariantsChecked: applicable.map((o) => o.id),
    invariantsPassed: applicable.filter((o) => o.status === 'pass').map((o) => o.id),
    invariantsFailed: applicable.filter((o) => o.status === 'fail').map((o) => o.id),
    invariantsUnknown: applicable.filter((o) => o.status === 'unknown').map((o) => o.id),
    contractCoverage: detail.contract.coverage,
    evidenceCompleteness: evidenceCompleteness(detail),
    authorityEligibility: applicable.every((o) => o.status === 'pass') ? 'eligible' : 'ineligible',
    executionIds: [...new Set(detail.records.map((r) => String(r.proposal.id)))],
    claimDigests: detail.evaluation.required.map((c) => `${opts.digest(c.definition.resource)}#${c.state}`).sort(),
    evidenceCount: detail.ledger.all().length,
    resourceDigests: [...allResources].map(opts.digest).sort(),
  };
}
