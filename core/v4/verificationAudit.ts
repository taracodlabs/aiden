/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/verificationAudit.ts — Dual-run Slice 1: the LOCAL store + wiring.
 *
 * The impure half of the dual-run comparison. The classifier
 * (`verifierComparison.ts`) is pure and storage-blind; this module owns the two
 * side effects it deliberately doesn't: (1) an installation-local digest key, so
 * resource digests are stable within an install but not correlatable across
 * installs, and (2) an append-only local JSONL log of comparison records.
 *
 * Everything here is FAULT-ISOLATED: `recordVerifierDivergence` never throws and
 * never blocks finalize — a key-read fault, a full disk, or a bad record is
 * swallowed and the turn proceeds unchanged. Local-only: no network, ever. The
 * opt-in exporter that would read this JSONL is explicitly deferred.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import type { AidenPaths } from './paths';
import { computeTaskFinalization, type TaskVerificationFailure } from './taskVerification';
import { runShadowClaimVerifierDetailed, type ShadowClaimDetail } from './claimVerifier';
import type { SnapshotPair } from './temporalEvidence';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';
import {
  compareVerifiers,
  makeResourceDigester,
  type DivergenceComparisonRecord,
  type LegacyStatus,
} from './verifierComparison';

/**
 * The installation-local digest key. Read once from disk; created on first use.
 * If disk is unavailable, falls back to a deterministic key derived from the
 * root path — digests stay STABLE within the install even when the key file
 * cannot be persisted (a shadow audit tolerates a keyless-but-deterministic
 * fallback; it never blocks). Never throws.
 */
export function getOrCreateDigestKey(paths: AidenPaths): string {
  const fallback = createHash('sha256').update('aiden-divergence-digest ').update(paths.root).digest('hex');
  try {
    if (existsSync(paths.verificationDigestKey)) {
      const k = readFileSync(paths.verificationDigestKey, 'utf8').trim();
      if (k.length > 0) return k;
    }
    const fresh = randomBytes(32).toString('hex');
    mkdirSync(paths.verificationAuditDir, { recursive: true });
    writeFileSync(paths.verificationDigestKey, fresh, { encoding: 'utf8', flag: 'wx' });
    return fresh;
  } catch {
    // A concurrent writer may have won the `wx` race, or disk is read-only.
    try {
      if (existsSync(paths.verificationDigestKey)) {
        const k = readFileSync(paths.verificationDigestKey, 'utf8').trim();
        if (k.length > 0) return k;
      }
    } catch { /* fall through to the deterministic fallback */ }
    return fallback;
  }
}

/** Append one record as a JSONL line. Fault-isolated — a write fault is swallowed. */
export function appendDivergenceRecord(paths: AidenPaths, record: DivergenceComparisonRecord): void {
  try {
    mkdirSync(paths.verificationAuditDir, { recursive: true });
    appendFileSync(paths.verificationDivergenceLog, `${JSON.stringify(record)}\n`, 'utf8');
  } catch { /* the divergence log must never break finalize */ }
}

/** The legacy finalization output, projected to the comparator's input. */
export interface LegacyFinalizationView {
  readonly status: LegacyStatus;
  readonly failures: readonly TaskVerificationFailure[];
  readonly handleCodes?: readonly string[];
}

/**
 * The caller entry point. Builds the digester, runs the PURE comparator, and
 * appends the record locally — all fault-isolated. Returns the record for
 * tests/inspection, or `null` if anything faulted. The classifier stays pure;
 * this is the only impurity the seam adds.
 */
export function recordVerifierDivergence(args: {
  paths: AidenPaths;
  cwd: string;
  now: number;
  turnId: string;
  taskId?: string;
  legacy: LegacyFinalizationView;
  detail: ShadowClaimDetail;
  snapshots?: readonly SnapshotPair[];
  verifierVersion?: string;
}): DivergenceComparisonRecord | null {
  try {
    const key = getOrCreateDigestKey(args.paths);
    const digest = makeResourceDigester(key, args.cwd);
    const record = compareVerifiers(args.legacy, args.detail, {
      now: args.now,
      turnId: args.turnId,
      taskId: args.taskId,
      digest,
      snapshots: args.snapshots,
      verifierVersion: args.verifierVersion,
    });
    appendDivergenceRecord(args.paths, record);
    return record;
  } catch {
    return null; // a comparison fault must never break the turn
  }
}

/** The authoritative finalization output shape (from computeTaskFinalization). */
type FinalizationOutput = ReturnType<typeof computeTaskFinalization>;

/**
 * Project the AUTHORITATIVE finalization output to the comparator's legacy view.
 * The single projection both seams use — so the recorded legacy verdict is
 * exactly the finalization the user was shown, never a phantom.
 */
export function projectLegacy(fin: FinalizationOutput): LegacyFinalizationView {
  return {
    status: fin.status,
    failures: fin.evidence.failures,
    handleCodes: fin.evidence.handles.map((h) => h.code).filter((c): c is string => !!c),
  };
}

/** Inputs to compute a legacy verdict fresh from the trace (headless path). */
export interface TurnFinalizeInputs {
  finishReason: string;
  declaredStatus?: string | null;
  approvalMode?: string;
  fileExists?: (p: string) => boolean;
}

/**
 * The ONE shared divergence-recording path both finalize seams call. Given a
 * turn's trace it (1) obtains the legacy verdict — either a precomputed
 * `legacyView` (the interactive seam passes the AUTHORITATIVE fin the user saw)
 * or by computing `computeTaskFinalization` fresh from the trace (the headless
 * one-shot, which surfaces no task verdict, so a fresh computation is the honest
 * legacy verdict, not a phantom) — (2) runs the shadow claim verifier over the
 * same trace, and (3) records the classified divergence locally. ONE
 * implementation, so the two seams cannot drift. Fault-isolated: returns null,
 * never throws, never blocks the turn.
 */
export function recordTurnDivergence(args: {
  paths: AidenPaths;
  cwd: string;
  now: number;
  turnId: string;
  taskId?: string;
  trace: HonestyTraceEntry[];
  /** The interactive seam passes this (projected from its authoritative fin). */
  legacyView?: LegacyFinalizationView;
  /** The headless seam passes these; the helper computes the legacy verdict. */
  finalize?: TurnFinalizeInputs;
}): DivergenceComparisonRecord | null {
  try {
    let legacy: LegacyFinalizationView;
    if (args.legacyView) {
      legacy = args.legacyView;
    } else if (args.finalize) {
      const fin = computeTaskFinalization(
        { finishReason: args.finalize.finishReason, toolCallTrace: args.trace, declaredStatus: args.finalize.declaredStatus ?? null },
        { approvalMode: args.finalize.approvalMode, fileExists: args.finalize.fileExists, now: args.now },
      );
      legacy = projectLegacy(fin);
    } else {
      return null; // neither a view nor inputs — nothing to compare against
    }
    const detail = runShadowClaimVerifierDetailed(args.trace);
    return recordVerifierDivergence({
      paths: args.paths, cwd: args.cwd, now: args.now, turnId: args.turnId, taskId: args.taskId, legacy, detail,
    });
  } catch {
    return null; // a finalize-comparison fault must never break the turn
  }
}

/** Resolve where the divergence log lives (for the deferred exporter / `aiden
 *  doctor`). Pure. */
export function divergenceLogPath(paths: AidenPaths): string {
  return path.normalize(paths.verificationDivergenceLog);
}
