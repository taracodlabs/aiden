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
import type { TaskVerificationFailure } from './taskVerification';
import type { ShadowClaimDetail } from './claimVerifier';
import type { SnapshotPair } from './temporalEvidence';
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

/** Resolve where the divergence log lives (for the deferred exporter / `aiden
 *  doctor`). Pure. */
export function divergenceLogPath(paths: AidenPaths): string {
  return path.normalize(paths.verificationDivergenceLog);
}
