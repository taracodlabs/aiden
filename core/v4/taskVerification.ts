/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/taskVerification.ts — v4.13 Pillar 1, Gap 1.
 *
 * The verify-before-done VERDICT POLICY. Design north star: the model
 * narrates; the runtime keeps score. A task may not reach `completed`
 * on prose — completion requires the verifier's verdict, evidence-backed
 * or an explicit honest downgrade.
 *
 * Detector / policy separation: the DETECTORS are the existing per-tool
 * verifiers (core/v4/verifier.ts), which already run at tool dispatch and
 * stamp `HonestyTraceEntry.verification`. This module is pure POLICY —
 * it reads the turn's trace and decides the task's terminal status. It
 * performs no I/O and consults no registry.
 *
 * Verdict policy (side-effect-scoped):
 *
 *   The claims a "done" asserts are SIDE EFFECTS — so the verdict is
 *   decided over MUTATING entries (`handlerMutates === true`). Read-only
 *   detours (a failed file_read the model recovered from, a low-signal
 *   empty read) never fail or downgrade a task; the reply footer already
 *   surfaces them.
 *
 *   - any mutating entry errored or verifier-!ok  → verification_failed
 *     (a side effect was claimed; the evidence says it didn't happen —
 *      the cron-bug class: "printed success, write never persisted")
 *   - no mutating entries at all                  → completed
 *     (pure prose / read-only turn — nothing was claimed, nothing gates)
 *   - every mutating entry verifier-ok (code 'ok') → completed
 *   - otherwise (mutations with low_signal / no_progress / unknown /
 *     missing verification)                        → completed_unverified
 *     — an HONEST downgrade, surfaced, never silently upgraded.
 *
 * Evidence handles are extracted from every entry that carries a
 * verification verdict (reads included — they're provenance, even though
 * they don't gate). The envelope persisted on the task row is versioned
 * (`v: 1`) so Gap 3 (full job-card) can EXTEND it — add fields, never
 * reshape.
 */

import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

// ── Evidence shapes (persisted on tasks.evidence as JSON) ──────────────

/** One per-claim handle: what the tool touched and what proves it. */
export interface EvidenceHandle {
  tool:      string;
  /** What the value is: a path, an exit code, bytes written, an id… */
  kind:      'path' | 'exit_code' | 'bytes' | 'object_id' | 'note';
  value:     string | number;
  /** True when the verifier's verdict for this entry was code 'ok'. */
  verified:  boolean;
  /** Verifier code for the entry ('ok' | 'low_signal' | …) when present. */
  code?:     string;
}

export interface TaskVerificationFailure {
  tool:   string;
  reason: string;
}

/**
 * The envelope persisted on the task row. Versioned so Gap 3 (constraints,
 * side-effects ledger, files-touched) extends this shape rather than
 * reshaping it: new OPTIONAL fields only, `v` bumps on breaking change.
 */
export interface TaskEvidence {
  v:        1;
  /** Mirror of the row status this envelope justified (audit trail). */
  verdict:  string;
  decidedAt: number;
  handles:  EvidenceHandle[];
  failures: TaskVerificationFailure[];
  /** Set when the model itself reported failure via ui_task_done. */
  reportedFailure?: string;
  /**
   * v4.13 Phase D — batch operations the USER DECLINED via
   * plan_approval. A declined op is a decision, not a failure; it is
   * recorded so the audit trail shows what was proposed and refused.
   * Additive v:1 key per the extend-don't-reshape doctrine.
   */
  declined?: Array<{ tool: string; target: string; reason: string }>;
  /**
   * v4.13 — mutations SKIPPED by the batch-staleness guard (source
   * already gone when the op executed, typically handled by an earlier
   * operation in the same approved batch). A skip is a benign
   * decision-record, not a failure. Additive v:1 key.
   */
  skipped?: Array<{ tool: string; target: string; reason: string }>;
}

export type TaskVerdict = 'completed' | 'completed_unverified' | 'verification_failed';

export interface TaskVerdictDecision {
  verdict:  TaskVerdict;
  handles:  EvidenceHandle[];
  failures: TaskVerificationFailure[];
}

// ── Evidence extraction ────────────────────────────────────────────────

/**
 * Pull concrete handles out of a trace entry's result envelope. Purely
 * additive — unknown result shapes yield no handles, never an error.
 */
export function extractEvidenceHandles(entry: HonestyTraceEntry): EvidenceHandle[] {
  const out: EvidenceHandle[] = [];
  const verified = entry.verification?.ok === true && entry.verification.code === 'ok';
  const code     = entry.verification?.code;
  const r = entry.result;
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (typeof o.path === 'string' && o.path.length > 0) {
      out.push({ tool: entry.name, kind: 'path', value: o.path, verified, code });
    }
    if (typeof o.exitCode === 'number') {
      out.push({ tool: entry.name, kind: 'exit_code', value: o.exitCode, verified, code });
    }
    if (typeof o.bytesWritten === 'number') {
      out.push({ tool: entry.name, kind: 'bytes', value: o.bytesWritten, verified, code });
    } else if (typeof o.bytes === 'number') {
      out.push({ tool: entry.name, kind: 'bytes', value: o.bytes, verified, code });
    }
    if (typeof o.id === 'string' && o.id.length > 0) {
      out.push({ tool: entry.name, kind: 'object_id', value: o.id, verified, code });
    }
  }
  // A verified entry with no extractable payload still leaves a note —
  // the verdict trail must show WHICH tools were checked, not just those
  // with friendly result shapes.
  if (out.length === 0 && entry.verification) {
    out.push({
      tool:     entry.name,
      kind:     'note',
      value:    entry.verification.reason ?? entry.verification.code,
      verified,
      code,
    });
  }
  // v4.13 Gap 2 — what-was-tried: runtime retry attempts feed the
  // evidence envelope so a structured give-up shows its work.
  if (entry.retries && entry.retries.length > 0) {
    const cats = [...new Set(entry.retries.map((r) => r.category))].join(', ');
    out.push({
      tool:     entry.name,
      kind:     'note',
      value:    `runtime retried ${entry.retries.length}x (${cats})`,
      verified,
      code,
    });
  }
  return out;
}

// ── Verdict policy ─────────────────────────────────────────────────────

export function decideTaskVerdict(trace: HonestyTraceEntry[]): TaskVerdictDecision {
  const handles: EvidenceHandle[] = [];
  const failures: TaskVerificationFailure[] = [];

  const mutating = trace.filter((t) => t.handlerMutates === true);

  for (const t of trace) {
    if (t.verification || t.error) handles.push(...extractEvidenceHandles(t));
  }

  for (const m of mutating) {
    if (m.error) {
      failures.push({ tool: m.name, reason: m.error });
    } else if (m.verification && m.verification.ok === false) {
      failures.push({
        tool:   m.name,
        reason: m.verification.reason ?? m.verification.code,
      });
    }
  }

  if (failures.length > 0) {
    return { verdict: 'verification_failed', handles, failures };
  }
  if (mutating.length === 0) {
    // Nothing side-effecting was claimed — a prose/read-only turn is
    // complete on its own terms. (Read evidence still recorded above.)
    return { verdict: 'completed', handles, failures };
  }
  const allHardVerified = mutating.every(
    (m) => m.verification?.ok === true && m.verification.code === 'ok',
  );
  if (allHardVerified) {
    return { verdict: 'completed', handles, failures };
  }
  return { verdict: 'completed_unverified', handles, failures };
}

// ── v4.13 Gap 3 — job-card material (durable record of what a task DID) ─
//
// The ledger owns the truth: everything below is derived from the turn's
// trace (the same entries Gap 1 walks), never from prose, so a future
// resume (Gap 4) can reconstruct the task's footprint after a crash.

/** One non-file-specific mutating execution on the job card. */
export interface SideEffectRecord {
  tool:     string;
  /** What was acted on — a path, an id, or the verifier's note. */
  target:   string;
  verified: boolean;
  /** Compact evidence detail when available (bytes=…, exit_code=…). */
  evidence?: string;
}

/** Last structured failure — Gap 2's give-up ledger + the failure class. */
export interface TaskFailureState {
  class:        string;
  reason?:      string;
  /** Gap 2's observable retry ledger — what the runtime already tried. */
  whatWasTried: Array<{ attempt: number; category: string; reason?: string; backoffMs: number }>;
  whenAt:       number;
}

export interface JobCardUpdate {
  filesTouched: string[];
  sideEffects:  SideEffectRecord[];
  failureState: TaskFailureState | null;
}

/**
 * Derive the turn's job-card material from the trace. Pure. Scoped to
 * MUTATING entries (the task's footprint is its side effects); the last
 * verifier-failed entry — read-only included — feeds failureState so an
 * exhausted transient give-up on a fetch is recorded too.
 */
export function buildJobCardUpdate(
  trace: HonestyTraceEntry[],
  opts?: { now?: number },
): JobCardUpdate {
  const filesTouched: string[] = [];
  const sideEffects:  SideEffectRecord[] = [];
  for (const t of trace) {
    if (t.handlerMutates !== true) continue;
    const verified = t.verification?.ok === true && t.verification.code === 'ok';
    const r = (t.result && typeof t.result === 'object') ? t.result as Record<string, unknown> : {};
    // v4.13 — a SKIPPED mutation (batch-staleness guard: source already
    // gone) touched nothing: no footprint. It lands on the evidence
    // envelope as a decision-record instead (computeTaskFinalization).
    if (r.skipped === true) continue;
    const p = typeof r.path === 'string' && r.path.length > 0 ? r.path : null;
    if (p && !filesTouched.includes(p)) filesTouched.push(p);
    // v4.13 Phase D — move/copy results carry from/to (not path); the
    // DESTINATION is the touched file.
    const dest = typeof r.to === 'string' && r.to.length > 0 ? r.to : null;
    if (dest && !filesTouched.includes(dest)) filesTouched.push(dest);
    const detailBits: string[] = [];
    if (typeof r.bytesWritten === 'number') detailBits.push(`bytes=${r.bytesWritten}`);
    else if (typeof r.bytes === 'number')   detailBits.push(`bytes=${r.bytes}`);
    if (typeof r.exitCode === 'number')     detailBits.push(`exit_code=${r.exitCode}`);
    const moveTarget =
      typeof r.from === 'string' && dest ? `${r.from} -> ${dest}` : dest;
    sideEffects.push({
      tool:     t.name,
      target:   p
        ?? moveTarget
        ?? (typeof r.id === 'string' && r.id.length > 0 ? r.id : null)
        ?? t.verification?.reason
        ?? '(unspecified)',
      verified,
      ...(detailBits.length > 0 ? { evidence: detailBits.join(' ') } : {}),
    });
  }
  let failureState: TaskFailureState | null = null;
  for (const t of trace) {
    if ((t.verification && t.verification.ok === false) || t.error) {
      failureState = {
        class:        t.classification?.category ?? 'unclassified',
        reason:       t.classification?.reason ?? t.verification?.reason ?? t.error,
        whatWasTried: t.retries ?? [],
        whenAt:       opts?.now ?? Date.now(),
      };
      // Keep walking — the LAST structured failure wins (most recent).
    }
  }
  return { filesTouched, sideEffects, failureState };
}

/**
 * v4.13 Gap 4 — the complete turn-end finalization, computed purely so
 * the REPL gate (chatSession) and the daemon runner share ONE policy:
 * given the turn's outcome, what status/evidence/job-card should land on
 * the task row. Callers do their own store write + surfaces.
 */
export function computeTaskFinalization(
  turn: {
    finishReason:   string;
    toolCallTrace?: HonestyTraceEntry[];
    /** Model-declared ui_task_done status ('success'/'failure'/…), when seen. */
    declaredStatus?: string | null;
  },
  opts?: {
    approvalMode?: string;
    now?: number;
    /**
     * v4.12.1 — EXTERNAL sends the side-effect idempotency ledger skipped on
     * a resume (already delivered on a prior run). They are not in the tool
     * trace — delivery happens at the channel seam, not via a tool — so the
     * daemon runner supplies them here to land on evidence.skipped[] and
     * render the ↷ line on /tasks, reusing the batch-staleness skip shape.
     */
    externalSkips?: Array<{ tool: string; target: string; reason: string }>;
  },
): {
  status:   'completed' | 'completed_unverified' | 'verification_failed' | 'failed';
  evidence: TaskEvidence;
  jobCard:  JobCardUpdate & { permissions?: Record<string, unknown> };
} {
  const trace = turn.toolCallTrace ?? [];
  const jobCard = {
    ...buildJobCardUpdate(trace, { now: opts?.now }),
    ...(opts?.approvalMode ? { permissions: { approvalMode: opts.approvalMode } } : {}),
  };
  const decision = decideTaskVerdict(trace);
  // v4.13 Phase D — user-declined batch ops (plan_approval results) land
  // on the evidence envelope: decisions, not failures.
  const declined: Array<{ tool: string; target: string; reason: string }> = [];
  for (const t of trace) {
    if (t.name !== 'plan_approval') continue;
    const r = (t.result && typeof t.result === 'object') ? t.result as Record<string, unknown> : {};
    if (!Array.isArray(r.declined)) continue;
    for (const d of r.declined as Array<{ tool?: unknown; args?: unknown; reason?: unknown }>) {
      if (!d || typeof d.tool !== 'string') continue;
      const a = (d.args && typeof d.args === 'object') ? d.args as Record<string, unknown> : {};
      const target =
        typeof a.path === 'string' ? a.path :
        typeof a.from === 'string' && typeof a.to === 'string' ? `${a.from} -> ${a.to}` :
        JSON.stringify(a).slice(0, 120);
      declined.push({ tool: d.tool, target, reason: typeof d.reason === 'string' ? d.reason : '' });
    }
  }
  // v4.13 — skipped mutations (batch-staleness guard) are envelope
  // decision-records, mirrored from the typed tool results.
  const skipped: Array<{ tool: string; target: string; reason: string }> = [];
  for (const t of trace) {
    if (t.handlerMutates !== true) continue;
    const r = (t.result && typeof t.result === 'object') ? t.result as Record<string, unknown> : {};
    if (r.skipped !== true) continue;
    const target =
      typeof r.path === 'string' ? r.path :
      typeof r.from === 'string' && typeof r.to === 'string' ? `${r.from} -> ${r.to}` :
      '(unspecified)';
    skipped.push({
      tool:   t.name,
      target,
      reason: typeof r.reason === 'string' ? r.reason : 'skipped',
    });
  }
  // v4.12.1 — external idempotent-replay skips merge into the SAME skipped[]
  // channel as the batch-staleness skips (both are benign decision-records).
  const allSkips = [...skipped, ...(opts?.externalSkips ?? [])];
  const declinedExtra = {
    ...(declined.length > 0 ? { declined } : {}),
    ...(allSkips.length > 0 ? { skipped: allSkips } : {}),
  };
  if (turn.finishReason !== 'stop') {
    return {
      status:   'failed',
      evidence: { ...buildEvidenceEnvelope(decision, { now: opts?.now }), verdict: 'failed', ...declinedExtra },
      jobCard,
    };
  }
  if (turn.declaredStatus && turn.declaredStatus !== 'success') {
    return {
      status:   'failed',
      evidence: { ...buildEvidenceEnvelope(decision, { reportedFailure: turn.declaredStatus, now: opts?.now }), ...declinedExtra },
      jobCard,
    };
  }
  return {
    status:   decision.verdict,
    evidence: { ...buildEvidenceEnvelope(decision, { now: opts?.now }), ...declinedExtra },
    jobCard,
  };
}

/** Build the persistable envelope for a decided verdict. */
export function buildEvidenceEnvelope(
  decision: TaskVerdictDecision,
  opts?: { reportedFailure?: string; now?: number },
): TaskEvidence {
  return {
    v:         1,
    verdict:   decision.verdict,
    decidedAt: opts?.now ?? Date.now(),
    handles:   decision.handles,
    failures:  decision.failures,
    ...(opts?.reportedFailure ? { reportedFailure: opts.reportedFailure } : {}),
  };
}
