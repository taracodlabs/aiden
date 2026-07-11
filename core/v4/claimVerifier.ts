/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/claimVerifier.ts — P1B-1: the claim + evidence verifier core.
 *
 * PURE, SHADOW-ONLY, HEADLESS. Consumes the P1A `CommandRecord` shadow model
 * and produces an honest task verdict by folding CLAIMS, not command records.
 * This is the fix for turn-wide failure contamination: a command failing on one
 * resource can never fail a claim that depends on a different resource.
 *
 * Pipeline:  commands → evidence (append-only, resource-linked) → claims → verdict.
 *
 * Non-authoritative: nothing here changes `decideTaskVerdict`,
 * `computeTaskFinalization`, `recordOutcomes`, persistence, or the renderer.
 * The production wiring runs it alongside the legacy verdict and discards the
 * result; tests inspect the structured evaluation directly.
 *
 * Deliberately deferred (do NOT add here): temporal/pre-state capture (P1B-2),
 * expected-failure diagnostic contracts (P1B-3), the NL task-contract compiler
 * (P1B-4), and the claim-matrix UI (P2C).
 */

import {
  buildCommandRecord,
  type CommandRecord,
  type CommandId,
  type ResourceId,
  type ResourceRef,
} from './executionContract';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

// ── Resources ───────────────────────────────────────────────────────────────

/** The resources a command touched. Plural — a command may affect several. */
export function resourcesOf(record: CommandRecord): ResourceRef[] {
  return record.resources;
}

// ── Evidence: append-only, timestamped, resource-linked ─────────────────────
//
// Evidence records OBSERVATIONS, never conclusions. Later evidence supersedes
// earlier only for CURRENT-STATE claim evaluation (the latest observation for a
// resource wins) — it never erases the earlier temporal truth, which the ledger
// retains in append order.

export type EvidenceKind =
  | 'resource_touch' | 'exit_code' | 'error' | 'denied' | 'interrupted'
  // P1B-2A — before/after state observations (temporalEvidence.ts populates them).
  | 'snapshot_pre' | 'snapshot_post';

/**
 * Lifecycle phase of an observation. ADDITIVE: the original five kinds carry no
 * `phase` and default to `'execution'` via `phaseOf` — so nothing the existing
 * `buildEvidenceLedger` appends changed. Only the snapshot kinds set it.
 */
export type EvidencePhase = 'pre_state' | 'execution' | 'post_state' | 'verification';

export interface EvidenceEntry {
  /** Monotonic append order — the temporal axis. */
  readonly at: number;
  /** Which command execution produced this observation. */
  readonly executionId: CommandId;
  readonly kind: EvidenceKind;
  /** Lifecycle phase. Absent on the original five kinds ⇒ `'execution'` (phaseOf). */
  readonly phase?: EvidencePhase;
  /** Absent for execution-only evidence (exit_code / interrupted). */
  readonly resource?: ResourceId;
  readonly interaction?: ResourceRef['interaction'];
  /** Observed verifier verdict for a resource touch (not a conclusion). */
  readonly verifierOk?: boolean;
  readonly verificationCode?: string;
  /** Execution evidence — kept on the EXECUTION, never treated as a resource. */
  readonly exitCode?: number;
  readonly detail?: string;
  /** Opaque snapshot payload for `snapshot_pre`/`snapshot_post` (a
   *  `SnapshotObservation` from temporalEvidence; P1B-1 does not interpret it). */
  readonly snapshot?: unknown;
}

/** The phase of an observation, defaulting the original five kinds to 'execution'. */
export function phaseOf(e: EvidenceEntry): EvidencePhase {
  return e.phase ?? 'execution';
}

/** Append-only ledger. Entries are frozen; nothing is ever removed or rewritten. */
export class EvidenceLedger {
  private readonly entries: EvidenceEntry[] = [];

  append(e: EvidenceEntry): void {
    this.entries.push(Object.freeze(e));
  }
  /** Every observation, in append (temporal) order — including superseded ones. */
  all(): readonly EvidenceEntry[] {
    return this.entries;
  }
  /** Observations for one resource, append order (last = current state). */
  forResource(r: ResourceId): readonly EvidenceEntry[] {
    return this.entries.filter((e) => e.resource === r);
  }
}

/** Build the ledger from command records. Exit codes land as EXECUTION evidence. */
export function buildEvidenceLedger(records: CommandRecord[]): EvidenceLedger {
  const ledger = new EvidenceLedger();
  records.forEach((rec, at) => {
    const executionId = rec.proposal.id;
    // Exit code → execution evidence, keyed by executionId, NOT a resource.
    if (typeof rec.execution.exitCode === 'number') {
      ledger.append({ at, executionId, kind: 'exit_code', exitCode: rec.execution.exitCode });
    }
    if (rec.execution.denied) {
      const refs = resourcesOf(rec);
      if (refs.length === 0) ledger.append({ at, executionId, kind: 'denied' });
      for (const ref of refs) {
        ledger.append({ at, executionId, kind: 'denied', resource: ref.resource, interaction: ref.interaction });
      }
      return;
    }
    if (rec.execution.interrupted) {
      ledger.append({ at, executionId, kind: 'interrupted' });
      return;
    }
    const failed = rec.execution.state === 'errored' || rec.verification.state === 'failed';
    const verifiedOk = rec.verification.state === 'verified';
    const refs = resourcesOf(rec);
    for (const ref of refs) {
      ledger.append({
        at,
        executionId,
        kind: 'resource_touch',
        resource: ref.resource,
        interaction: ref.interaction,
        verifierOk: failed ? false : verifiedOk ? true : undefined,
        verificationCode: rec.verification.code,
        detail: rec.execution.error,
      });
    }
    // A failure with no identifiable resource is still observed (execution-level).
    if (failed && refs.length === 0) {
      ledger.append({ at, executionId, kind: 'error', detail: rec.execution.error ?? 'failed' });
    }
  });
  return ledger;
}

// ── Claims: frozen definition vs recomputed evaluation ──────────────────────

export type ClaimCategory =
  | 'contract'    // what the user asked for (part of completion)
  | 'observed'    // things Aiden noticed — evidence, NOT completion
  | 'diagnostic'; // expected-failure probe (P1B-3 wires these; not gating here)

/** FROZEN — what must be true. Never recomputed. */
export interface ClaimDefinition {
  readonly id: string;
  readonly category: ClaimCategory;
  readonly resource: ResourceId;
  readonly predicate: string;
  readonly required: boolean;
}

export type ClaimState = 'verified' | 'unverified' | 'failed' | 'denied' | 'unknown';

/** RECOMPUTED from evidence each fold. Distinct type from the frozen definition. */
export interface ClaimEvaluation {
  readonly definition: ClaimDefinition;
  readonly state: ClaimState;
  readonly reason?: string;
  /** The (append-only) evidence considered — including superseded observations. */
  readonly evidence: readonly EvidenceEntry[];
}

/** Recompute one claim's state from the ledger. The LATEST resource observation
 *  decides current state (supersession); the ledger keeps the earlier truth. */
export function evaluateClaim(def: ClaimDefinition, ledger: EvidenceLedger): ClaimEvaluation {
  const forRes = ledger.forResource(def.resource);
  if (forRes.length === 0) {
    return { definition: def, state: 'unknown', reason: 'no evidence for resource', evidence: forRes };
  }
  const last = forRes[forRes.length - 1];
  let state: ClaimState;
  let reason: string | undefined;
  if (last.kind === 'denied') {
    state = 'denied';
    reason = 'the command for this claim was denied';
  } else if (last.kind === 'resource_touch') {
    if (last.verifierOk === true) {
      state = last.verificationCode === 'ok' ? 'verified' : 'unverified';
      if (state === 'unverified') reason = 'weak verifier signal';
    } else if (last.verifierOk === false) {
      state = 'failed';
      reason = last.detail ?? 'verification failed';
    } else {
      state = 'unknown';
    }
  } else {
    state = 'unknown';
  }
  return { definition: def, state, reason, evidence: forRes };
}

// ── Forbidden conditions (authoritative sources only) ───────────────────────

export interface ForbiddenCondition {
  readonly id: string;
  readonly resource?: ResourceId;
  readonly predicate: string;
  /** AUTHORITATIVE only. Never derived from the absence of tool metadata. */
  readonly source: 'policy' | 'monitor';
}

/** A forbidden condition is confirmed only by explicit evidence naming its
 *  resource as failed/violated — never inferred. Tool-derived contracts carry
 *  no forbidden conditions, so this is inert in the production shadow. */
export function isForbiddenConfirmed(fc: ForbiddenCondition, ledger: EvidenceLedger): boolean {
  if (!fc.resource) return false;
  const forRes = ledger.forResource(fc.resource);
  const last = forRes[forRes.length - 1];
  return !!last && last.kind === 'resource_touch' && last.verifierOk === false;
}

// ── The frozen task contract ────────────────────────────────────────────────

export type Coverage = 'complete' | 'partial' | 'unknown';
export type ContractSource =
  | 'user_explicit'
  | 'existing_job_card'
  | 'trusted_task_template'
  | 'planner_proposed'
  | 'tool_derived';

export interface TaskContract {
  readonly requiredClaims: ClaimDefinition[];
  readonly optionalClaims: ClaimDefinition[];
  readonly forbiddenConditions: ForbiddenCondition[];
  readonly coverage: Coverage;
  readonly source: ContractSource;
  readonly frozenAt: number;
}

/**
 * The only production contract source in P1B-1. Tool metadata generates evidence
 * and OBSERVED claims — never a required set, never `coverage: 'complete'`, never
 * a forbidden condition. So a tool-derived contract is honestly `unknown`
 * coverage with an empty required set: the leniency gap made visible.
 */
export function buildToolDerivedContract(_records: CommandRecord[], frozenAt = 0): TaskContract {
  return {
    requiredClaims: [],
    optionalClaims: [],
    forbiddenConditions: [],
    coverage: 'unknown',
    source: 'tool_derived',
    frozenAt,
  };
}

// ── The task fold ───────────────────────────────────────────────────────────

export type TaskClaimVerdict = 'verified' | 'unverified' | 'partial' | 'denied' | 'failed';

export interface TaskEvaluation {
  readonly verdict: TaskClaimVerdict;
  readonly reason: string;
  readonly required: ClaimEvaluation[];
  /** Derived, NON-gating. Observed claims are evidence, never completion. */
  readonly observed: ClaimEvaluation[];
  readonly coverage: Coverage;
  readonly forbiddenConfirmed: ForbiddenCondition[];
}

/** Observed claims — one per verified resource touch. Category 'observed',
 *  `required: false`; they never enter the required set or lift the verdict. */
function deriveObservedClaims(records: CommandRecord[], ledger: EvidenceLedger): ClaimEvaluation[] {
  const seen = new Set<ResourceId>();
  const out: ClaimEvaluation[] = [];
  for (const rec of records) {
    if (rec.verification.state !== 'verified') continue;
    for (const ref of resourcesOf(rec)) {
      if (seen.has(ref.resource)) continue;
      seen.add(ref.resource);
      const def: ClaimDefinition = {
        id: `observed:${ref.resource}`,
        category: 'observed',
        resource: ref.resource,
        predicate: `${ref.interaction} ${ref.resource}`,
        required: false,
      };
      out.push(evaluateClaim(def, ledger));
    }
  }
  return out;
}

/**
 * Deterministic verdict precedence, TOP WINS:
 *   1. a forbidden condition confirmed          → failed
 *   2. a required claim disproven               → failed
 *   3. a required claim denied (principal)      → denied
 *   4. a required claim denied, other work done → partial
 *   5. some required claim unresolved           → partial
 *   6. all required verified + coverage complete→ verified
 *   7. all required verified + coverage partial/unknown → unverified
 */
function foldVerdict(
  required: ClaimEvaluation[],
  forbiddenConfirmed: ForbiddenCondition[],
  coverage: Coverage,
): { verdict: TaskClaimVerdict; reason: string } {
  if (forbiddenConfirmed.length > 0) {
    return { verdict: 'failed', reason: 'a forbidden condition was confirmed' };
  }
  if (required.some((e) => e.state === 'failed')) {
    return { verdict: 'failed', reason: 'a required claim was disproven' };
  }
  const denied = required.filter((e) => e.state === 'denied');
  const verified = required.filter((e) => e.state === 'verified');
  const unresolved = required.filter((e) => e.state === 'unknown' || e.state === 'unverified');
  if (denied.length > 0) {
    return verified.length > 0
      ? { verdict: 'partial', reason: 'a required claim was denied; other required work completed' }
      : { verdict: 'denied', reason: 'the principal required claim was denied' };
  }
  if (unresolved.length > 0) {
    return { verdict: 'partial', reason: 'some required claims are unresolved' };
  }
  return coverage === 'complete'
    ? { verdict: 'verified', reason: 'all required claims verified; coverage complete' }
    : { verdict: 'unverified', reason: 'observed work verified; request coverage incomplete' };
}

/** The evaluation PLUS the exact ledger it was folded from. A consumer that must
 *  independently re-check the fold (the dual-run comparator) reads THIS ledger —
 *  never a rebuilt one — so its recheck sees identical inputs, not a copy that
 *  could drift. */
export interface TaskEvaluationDetail {
  readonly evaluation: TaskEvaluation;
  readonly ledger: EvidenceLedger;
}

/** Fold the records + contract into a verdict AND surface the ledger used. Pure. */
export function evaluateTaskDetailed(records: CommandRecord[], contract: TaskContract): TaskEvaluationDetail {
  const ledger = buildEvidenceLedger(records);
  const required = contract.requiredClaims.map((d) => evaluateClaim(d, ledger));
  const observed = deriveObservedClaims(records, ledger);
  const forbiddenConfirmed = contract.forbiddenConditions.filter((fc) => isForbiddenConfirmed(fc, ledger));
  const { verdict, reason } = foldVerdict(required, forbiddenConfirmed, contract.coverage);
  return {
    evaluation: { verdict, reason, required, observed, coverage: contract.coverage, forbiddenConfirmed },
    ledger,
  };
}

/** Fold the records + contract into an honest task verdict. Pure. Thin wrapper
 *  over `evaluateTaskDetailed` — behaviour-identical, ledger discarded. */
export function evaluateTask(records: CommandRecord[], contract: TaskContract): TaskEvaluation {
  return evaluateTaskDetailed(records, contract).evaluation;
}

// ── Production shadow entry (headless, non-authoritative) ────────────────────

/** Build P1A command records from a turn's trace (the finalize seam has the
 *  trace but not the injected shadow map). Resources are extracted from each
 *  entry's result inside buildCommandRecord. */
export function recordsFromTrace(trace: HonestyTraceEntry[]): CommandRecord[] {
  return trace.map((e) =>
    buildCommandRecord({
      providerCallId: '',
      tool: e.name,
      args: {},
      mutates: e.handlerMutates === true,
      result: e.result,
      error: e.error,
      verification: e.verification as never,
    }),
  );
}

/** The shadow fold plus every input it consumed — evaluation, the frozen
 *  contract, the command records, and the exact ledger. The dual-run comparator
 *  takes THIS so its independent recheck reads the same inputs the fold used. */
export interface ShadowClaimDetail {
  readonly evaluation: TaskEvaluation;
  readonly contract: TaskContract;
  readonly records: CommandRecord[];
  readonly ledger: EvidenceLedger;
}

/**
 * The production shadow, DETAILED: fold a turn's trace through a tool-derived
 * contract and return the evaluation alongside the exact records/ledger/contract
 * it was folded from. Called alongside the legacy verdict; the result is
 * inspected by tests + the comparator and discarded in production. Never throws
 * on well-formed input; callers still wrap it so a bug can never break finalize.
 */
export function runShadowClaimVerifierDetailed(trace: HonestyTraceEntry[]): ShadowClaimDetail {
  const records = recordsFromTrace(trace);
  const contract = buildToolDerivedContract(records);
  const { evaluation, ledger } = evaluateTaskDetailed(records, contract);
  return { evaluation, contract, records, ledger };
}

/** Compatibility wrapper — the evaluation only. Behaviour-identical to before. */
export function runShadowClaimVerifier(trace: HonestyTraceEntry[]): TaskEvaluation {
  return runShadowClaimVerifierDetailed(trace).evaluation;
}
