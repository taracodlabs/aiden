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
