/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/temporalEvidence.ts — P1B-2A: the PURE temporal-proof core.
 *
 * Proves one idea: how before/after observations are interpreted into
 * transition truth. ZERO filesystem I/O, no real capture, no hashing of user
 * files, no process waiting, no locks, no watchers/journals, no live wiring.
 * All of that is P1B-2B (shadow real capture) and P1B-2C (concurrency).
 *
 * Three separate questions, never smushed:
 *   - State truth   — is the artifact currently valid?
 *   - Transition truth — did it change (absent→present = creation; A→B = modification)?
 *   - Attribution   — which command caused it? (isolated / probable / unknown)
 *
 * Load-bearing rules enforced here:
 *   - Capture-failure ≠ absent. A read error / timeout / access-denied is
 *     `unknown`, NEVER `absent` — the stale-artifact-laundering back door.
 *   - Stale-artifact laundering blocked: hash A → A proves no creation and no
 *     modification. A changed mtime with the same hash is NOT a modification.
 *   - Execution result preserved separately: a nonzero exit stays nonzero even
 *     when the artifact's state is `verified` (post-state never overrides it).
 *   - State truth and attribution are independent verdicts.
 *   - Three-dimension evidence lattice, NO promotion: a claim declares minimum
 *     thresholds across transition strength × content validity × attribution;
 *     the evaluator cannot return `verified` unless every minimum is met.
 *     Existence never proves correctness; a changed hash never proves the new
 *     bytes are right.
 */

import type { ResourceId, CommandId } from './executionContract';
import type { EvidenceEntry } from './claimVerifier';

// ── Observations (synthetic in this slice — real capture is P1B-2B) ─────────

export type CaptureError = 'access_denied' | 'timeout' | 'inspection_error';

/** The content signals a fingerprint may carry. Optional — an absent signal is
 *  "unchecked", never "false". Real fingerprints come from P1B-2B. */
export interface Fingerprint {
  size?: number;
  mtimeMs?: number;
  contentHash?: string;
  parses?: boolean;
  schemaValid?: boolean;
  semanticMatch?: boolean;
  independentlyRecomputed?: boolean;
}

/** One observation of a resource. A capture failure is `unknown` with a typed
 *  cause kept SEPARATE — it is never allowed to read as `absent`. */
export type SnapshotObservation =
  | { readonly kind: 'present'; readonly fingerprint: Fingerprint }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly cause: CaptureError };

/** A before/after pair for one resource, one attempt. Each retry gets its own
 *  pair, so retries never smush together. */
export interface SnapshotPair {
  readonly resource: ResourceId;
  readonly attempt: number;
  readonly pre: SnapshotObservation;
  readonly post: SnapshotObservation;
}

// ── Mutation envelope — what a command COULD have mutated (pure, from resources) ─

export type MutationEnvelope =
  | { readonly kind: 'exact'; readonly resources: ResourceId[] }
  // DESIGNED-BUT-INERT: no P1A signal emits a directory/count scope yet, so
  // `classifyEnvelope` never returns this today. The type + attribution path
  // exist for when a real bounded signal arrives (do not invent one now).
  | { readonly kind: 'bounded'; readonly scope: string }
  | { readonly kind: 'unknown' };

/**
 * Classify a command's envelope PURELY from the resources P1A already captured.
 * ≥1 specific resource ⇒ exact; mutating with none ⇒ unknown (opaque shell —
 * never guessed). `bounded` is unreachable until a real bounded signal exists.
 */
export function classifyEnvelope(input: { resources: ResourceId[]; mutates: boolean }): MutationEnvelope {
  if (input.resources.length > 0) return { kind: 'exact', resources: [...input.resources] };
  if (input.mutates) return { kind: 'unknown' };
  return { kind: 'exact', resources: [] }; // non-mutating, touched nothing
}

function envelopeCovers(e: MutationEnvelope, resource: ResourceId): boolean {
  if (e.kind === 'exact') return e.resources.includes(resource);
  if (e.kind === 'bounded') return resource.startsWith(e.scope);
  return true; // an opaque command could have touched anything
}

// ── The three verdicts ──────────────────────────────────────────────────────

export type TransitionTruth = 'created' | 'modified' | 'deleted' | 'no_change' | 'indeterminate';
export type StateTruth = 'valid' | 'exists_invalid' | 'absent' | 'indeterminate';
export type Attribution = 'isolated' | 'probable' | 'unknown';

// ── The three evidence-lattice dimensions (ordered; higher = stronger) ──────

export type TransitionStrength =
  | 'unknown' | 'existence' | 'stat_changed' | 'fingerprint_changed' | 'isolated_window_transition';
export type ContentValidity =
  | 'unchecked' | 'non_empty' | 'parses' | 'schema_valid' | 'semantic_match' | 'independently_recomputed';
export type AttributionLevel =
  | 'none' | 'possible' | 'probable' | 'isolated_sole_writer' | 'journal_attributed';

const TRANSITION_ORDER: TransitionStrength[] =
  ['unknown', 'existence', 'stat_changed', 'fingerprint_changed', 'isolated_window_transition'];
const VALIDITY_ORDER: ContentValidity[] =
  ['unchecked', 'non_empty', 'parses', 'schema_valid', 'semantic_match', 'independently_recomputed'];
const ATTRIBUTION_ORDER: AttributionLevel[] =
  ['none', 'possible', 'probable', 'isolated_sole_writer', 'journal_attributed'];

const rank = <T>(v: T, order: T[]): number => order.indexOf(v);

export interface TransitionEvaluation {
  readonly stateTruth: StateTruth;
  readonly transitionTruth: TransitionTruth;
  readonly attribution: Attribution;
  readonly ranks: {
    readonly transition: TransitionStrength;
    readonly validity: ContentValidity;
    readonly attribution: AttributionLevel;
  };
  readonly reasons: string[];
}

/** Minimum thresholds a claim requires across all three dimensions. */
export interface ClaimThresholds {
  readonly transition: TransitionStrength;
  readonly validity: ContentValidity;
  readonly attribution: AttributionLevel;
}

// ── Derivations (pure) ──────────────────────────────────────────────────────

function deriveTransitionTruth(pre: SnapshotObservation, post: SnapshotObservation): TransitionTruth {
  // Capture-failure is never 'absent' — it can't prove any transition.
  if (pre.kind === 'unknown' || post.kind === 'unknown') return 'indeterminate';
  if (pre.kind === 'absent' && post.kind === 'present') return 'created';
  if (pre.kind === 'present' && post.kind === 'absent') return 'deleted';
  if (pre.kind === 'absent' && post.kind === 'absent') return 'no_change';
  // both present — the CONTENT HASH is the only modification signal.
  const a = pre.kind === 'present' ? pre.fingerprint.contentHash : undefined;
  const b = post.kind === 'present' ? post.fingerprint.contentHash : undefined;
  if (a != null && b != null) return a === b ? 'no_change' : 'modified';
  return 'indeterminate'; // present→present with no comparable hash — can't prove same or changed
}

function statChanged(pre: SnapshotObservation, post: SnapshotObservation): boolean {
  if (pre.kind !== 'present' || post.kind !== 'present') return false;
  const p = pre.fingerprint, q = post.fingerprint;
  const sizeMoved = p.size != null && q.size != null && p.size !== q.size;
  const mtimeMoved = p.mtimeMs != null && q.mtimeMs != null && p.mtimeMs !== q.mtimeMs;
  return !!sizeMoved || !!mtimeMoved;
}

function deriveTransitionStrength(
  pre: SnapshotObservation,
  post: SnapshotObservation,
  truth: TransitionTruth,
  attribution: Attribution,
): TransitionStrength {
  if (truth === 'indeterminate') return 'unknown';
  if (truth === 'modified') return attribution === 'isolated' ? 'isolated_window_transition' : 'fingerprint_changed';
  if (truth === 'created') return attribution === 'isolated' ? 'isolated_window_transition' : 'existence';
  if (truth === 'deleted') return 'existence';
  // no_change — a same-hash-but-moved-stat is `stat_changed`, still NOT a modification.
  if (statChanged(pre, post)) return 'stat_changed';
  return post.kind === 'present' ? 'existence' : 'unknown';
}

function deriveStateTruth(post: SnapshotObservation): StateTruth {
  if (post.kind === 'unknown') return 'indeterminate';
  if (post.kind === 'absent') return 'absent';
  const fp = post.fingerprint;
  if (fp.parses === false) return 'exists_invalid';
  if (fp.schemaValid === true || fp.semanticMatch === true || fp.parses === true) return 'valid';
  return 'indeterminate'; // present but validity unchecked
}

function deriveValidity(post: SnapshotObservation): ContentValidity {
  if (post.kind !== 'present') return 'unchecked';
  const fp = post.fingerprint;
  if (fp.independentlyRecomputed === true) return 'independently_recomputed';
  if (fp.semanticMatch === true) return 'semantic_match';
  if (fp.schemaValid === true) return 'schema_valid';
  if (fp.parses === true) return 'parses';
  if (fp.size != null && fp.size > 0) return 'non_empty';
  return 'unchecked';
}

function attributionLevelOf(a: Attribution): AttributionLevel {
  return a === 'isolated' ? 'isolated_sole_writer' : a === 'probable' ? 'probable' : 'possible';
}

/**
 * Which command caused the transition, from ENVELOPE OVERLAP ONLY (no watcher,
 * no journal, no process tree — those are P1B-2C). Exactly one exact writer →
 * isolated; one bounded → probable; zero, two+, or an opaque candidate → unknown.
 */
export function attributeTransition(resource: ResourceId, candidates: MutationEnvelope[]): Attribution {
  const covering = candidates.filter((e) => envelopeCovers(e, resource));
  if (covering.length !== 1) return 'unknown';
  const only = covering[0];
  if (only.kind === 'exact') return 'isolated';
  if (only.kind === 'bounded') return 'probable';
  return 'unknown';
}

/**
 * Interpret one before/after pair into three independent verdicts. Pure. When
 * `attributionOverride` is supplied (from `attributeTransition` over the full
 * candidate set) it wins; otherwise attribution is the single-command view of
 * `envelope`.
 */
export function evaluateTransition(
  pre: SnapshotObservation,
  post: SnapshotObservation,
  envelope: MutationEnvelope,
  attributionOverride?: Attribution,
): TransitionEvaluation {
  const transitionTruth = deriveTransitionTruth(pre, post);
  const attribution: Attribution =
    attributionOverride ??
    (envelope.kind === 'exact' && envelope.resources.length > 0
      ? 'isolated'
      : envelope.kind === 'bounded'
        ? 'probable'
        : 'unknown');
  const transition = deriveTransitionStrength(pre, post, transitionTruth, attribution);
  const validity = deriveValidity(post);
  const stateTruth = deriveStateTruth(post);
  const reasons: string[] = [];
  if (pre.kind === 'unknown' || post.kind === 'unknown') {
    reasons.push('capture failure observed as unknown — never absent');
  }
  if (transitionTruth === 'no_change' && statChanged(pre, post)) {
    reasons.push('same content hash with a moved stat — not a modification');
  }
  return {
    stateTruth,
    transitionTruth,
    attribution,
    ranks: { transition, validity, attribution: attributionLevelOf(attribution) },
    reasons,
  };
}

/**
 * The NO-PROMOTION gate. A claim is `verified` ONLY when the observed evidence
 * meets the claim's minimum across ALL THREE dimensions. Existence-only can
 * never satisfy a correctness (validity) minimum; a changed hash can never
 * satisfy a semantic minimum.
 */
export function meetsThresholds(ev: TransitionEvaluation, min: ClaimThresholds): boolean {
  return (
    rank(ev.ranks.transition, TRANSITION_ORDER) >= rank(min.transition, TRANSITION_ORDER) &&
    rank(ev.ranks.validity, VALIDITY_ORDER) >= rank(min.validity, VALIDITY_ORDER) &&
    rank(ev.ranks.attribution, ATTRIBUTION_ORDER) >= rank(min.attribution, ATTRIBUTION_ORDER)
  );
}

/** The single dimension(s) that fall short of a claim's minimums (empty ⇒ met). */
export function unmetDimensions(ev: TransitionEvaluation, min: ClaimThresholds): string[] {
  const out: string[] = [];
  if (rank(ev.ranks.transition, TRANSITION_ORDER) < rank(min.transition, TRANSITION_ORDER)) out.push('transition');
  if (rank(ev.ranks.validity, VALIDITY_ORDER) < rank(min.validity, VALIDITY_ORDER)) out.push('validity');
  if (rank(ev.ranks.attribution, ATTRIBUTION_ORDER) < rank(min.attribution, ATTRIBUTION_ORDER)) out.push('attribution');
  return out;
}

// ── Ledger integration (slots into the P1B-1 append-only ledger; no second store) ─

/**
 * The two observations of a pair as P1B-1 `EvidenceEntry`s — a `snapshot_pre`
 * (phase `pre_state`) and a `snapshot_post` (phase `post_state`), both keyed by
 * the resource. Appended to the SAME append-only `EvidenceLedger` (both remain;
 * neither erases the other). The `TransitionEvaluation` stays DERIVED, not
 * stored — a caller recomputes it from these entries on demand.
 */
export function snapshotPairToEntries(
  pair: SnapshotPair,
  executionId: CommandId,
  at: number,
): EvidenceEntry[] {
  return [
    { at, executionId, kind: 'snapshot_pre', phase: 'pre_state', resource: pair.resource, snapshot: pair.pre },
    { at: at + 1, executionId, kind: 'snapshot_post', phase: 'post_state', resource: pair.resource, snapshot: pair.post },
  ];
}
