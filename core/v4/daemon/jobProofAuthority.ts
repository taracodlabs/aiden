/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Db } from './db/connection';

export type ClaimCategory = 'contract' | 'observed' | 'courtesy';
export type ClaimState = 'unverified' | 'verified' | 'partial' | 'failed' | 'unknown';
export type FinalVerdict = 'verified' | 'partially_verified' | 'failed' | 'unknown' | 'cancelled';

export interface ClaimSourceReference {
  snapshotId: string;
  path: string;
  lineStart: number;
  lineEnd: number;
}

export interface ClaimValidationRequirement {
  kind: 'test' | 'build';
  scope?: 'focused' | 'full';
}

export interface ClaimRecord {
  claimId: string;
  jobId: string;
  attemptId: string | null;
  generation: number | null;
  category: ClaimCategory;
  statement: string;
  required: boolean;
  state: ClaimState;
  repositorySnapshotId: string | null;
  sourceReferences: ClaimSourceReference[];
  requiredValidation: ClaimValidationRequirement[];
  requiredEvidenceCategories: string[];
}

export interface EvidenceRecord {
  evidenceId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  effectId: string | null;
  repositorySnapshotId: string | null;
  source: string;
  producer: string;
  capturedAt: number;
  observedAt: number;
  freshUntil: number | null;
  integritySha256: string;
  coverage: 'full' | 'partial' | 'unknown';
  verificationResult: ClaimState;
  payload: unknown;
  late: boolean;
}

export interface JobVerdictRecord {
  jobId: string;
  attemptId: string;
  generation: number;
  verdict: FinalVerdict;
  summary: Record<string, unknown>;
  finalizedAt: number;
}

export interface JobProofAuthority {
  createClaim(command: {
    jobId: string; attemptId?: string | null; generation?: number | null;
    category: ClaimCategory; statement: string; required?: boolean; now?: number;
    repositorySnapshotId?: string | null;
    sourceReferences?: ClaimSourceReference[];
    requiredValidation?: ClaimValidationRequirement[];
    requiredEvidenceCategories?: string[];
  }): ClaimRecord;
  recordEvidence(command: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    effectId?: string | null; source: string; producer: string; observedAt: number;
    repositorySnapshotId?: string | null;
    freshUntil?: number | null; coverage: 'full' | 'partial' | 'unknown';
    verificationResult: ClaimState; payload: unknown; now?: number;
  }): EvidenceRecord;
  checkClaim(command: {
    claimId: string; attemptId: string; generation: number; evidenceIds: string[];
    validationRunIds?: string[];
    state: Exclude<ClaimState, 'unverified'>; now?: number;
  }): ClaimRecord;
  listClaims(jobId: string): ClaimRecord[];
  listEvidence(jobId: string): EvidenceRecord[];
  hasRequiredClaims(jobId: string): boolean;
  finalize(command: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    cancelled?: boolean; now?: number;
  }): JobVerdictRecord;
  getVerdict(jobId: string): JobVerdictRecord | null;
  exportJson(jobId: string): Record<string, unknown>;
  exportMarkdown(jobId: string): string;
}

type ClaimRow = {
  claim_id: string; job_id: string; attempt_id: string | null; generation: number | null;
  category: ClaimCategory; statement: string; required: number; state: ClaimState;
  repository_snapshot_id: string | null; source_references_json: string;
  required_validation_json: string; required_evidence_categories_json: string;
};
type EvidenceRow = {
  evidence_id: string; job_id: string; attempt_id: string; generation: number; effect_id: string | null;
  source: string; producer: string; captured_at: number; observed_at: number; fresh_until: number | null;
  integrity_sha256: string; coverage: EvidenceRecord['coverage']; verification_result: ClaimState;
  payload_json: string; late: number;
  repository_snapshot_id: string | null;
};

const id = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mapClaim = (row: ClaimRow): ClaimRecord => ({
  claimId: row.claim_id, jobId: row.job_id, attemptId: row.attempt_id, generation: row.generation,
  category: row.category, statement: row.statement, required: row.required === 1, state: row.state,
  repositorySnapshotId: row.repository_snapshot_id,
  sourceReferences: JSON.parse(row.source_references_json) as ClaimSourceReference[],
  requiredValidation: JSON.parse(row.required_validation_json) as ClaimValidationRequirement[],
  requiredEvidenceCategories: JSON.parse(row.required_evidence_categories_json) as string[],
});
const mapEvidence = (row: EvidenceRow): EvidenceRecord => ({
  evidenceId: row.evidence_id, jobId: row.job_id, attemptId: row.attempt_id,
  generation: row.generation, effectId: row.effect_id, repositorySnapshotId: row.repository_snapshot_id,
  source: row.source, producer: row.producer,
  capturedAt: row.captured_at, observedAt: row.observed_at, freshUntil: row.fresh_until,
  integritySha256: row.integrity_sha256, coverage: row.coverage,
  verificationResult: row.verification_result, payload: JSON.parse(row.payload_json), late: row.late === 1,
});

export function createJobProofAuthority(db: Db): JobProofAuthority {
  const assertAttempt = (jobId: string, attemptId: string, generation: number, fenceToken?: string): void => {
    const row = db.prepare(
      `SELECT r.generation, r.fence_token FROM runs r WHERE r.task_id = ? AND r.attempt_id = ?`,
    ).get(jobId, attemptId) as { generation: number; fence_token: string | null } | undefined;
    if (!row || row.generation !== generation || (fenceToken !== undefined && row.fence_token !== fenceToken)) {
      throw new Error('Evidence authority does not match the producing Attempt');
    }
  };
  const getVerdict = (jobId: string): JobVerdictRecord | null => {
    const row = db.prepare('SELECT * FROM job_verdicts WHERE job_id = ?').get(jobId) as {
      job_id: string; attempt_id: string; generation: number; verdict: FinalVerdict;
      summary_json: string; finalized_at: number;
    } | undefined;
    return row ? {
      jobId: row.job_id, attemptId: row.attempt_id, generation: row.generation,
      verdict: row.verdict, summary: JSON.parse(row.summary_json) as Record<string, unknown>, finalizedAt: row.finalized_at,
    } : null;
  };
  const listClaims = (jobId: string): ClaimRecord[] => (
    db.prepare('SELECT * FROM job_claims WHERE job_id = ? ORDER BY created_at, claim_id').all(jobId) as ClaimRow[]
  ).map(mapClaim);
  const listEvidence = (jobId: string): EvidenceRecord[] => (
    db.prepare('SELECT * FROM job_evidence WHERE job_id = ? ORDER BY captured_at, evidence_id').all(jobId) as EvidenceRow[]
  ).map(mapEvidence);
  const validateSourceReferences = (
    jobId: string,
    repositorySnapshotId: string | null,
    references: readonly ClaimSourceReference[],
  ): ClaimSourceReference[] => {
    if (references.length > 0 && !repositorySnapshotId) throw new Error('Source-bound Claims require a repository snapshot');
    if (repositorySnapshotId) {
      const snapshot = db.prepare('SELECT job_id FROM repository_snapshots WHERE snapshot_id=?')
        .get(repositorySnapshotId) as { job_id: string } | undefined;
      if (!snapshot || snapshot.job_id !== jobId) throw new Error('Claim repository snapshot does not belong to the Job');
    }
    return references.map((reference) => {
      const normalized = {
        snapshotId: reference.snapshotId,
        path: reference.path.replace(/\\/g, '/').replace(/^\.\//, ''),
        lineStart: reference.lineStart,
        lineEnd: reference.lineEnd,
      };
      if (normalized.snapshotId !== repositorySnapshotId || normalized.lineStart < 1 || normalized.lineEnd < normalized.lineStart) {
        throw new Error('Claim source reference does not match the bound repository snapshot');
      }
      const entry = db.prepare(
        'SELECT capture_status FROM repository_snapshot_entries WHERE snapshot_id=? AND relative_path=?',
      ).get(normalized.snapshotId, normalized.path) as { capture_status: string } | undefined;
      if (!entry || entry.capture_status !== 'captured') throw new Error('Claim source reference is not captured by the repository snapshot');
      return normalized;
    });
  };

  const authority: JobProofAuthority = {
    createClaim(command) {
      if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(command.jobId)) throw new Error('Job not found');
      if (command.attemptId && command.generation !== null && command.generation !== undefined) {
        assertAttempt(command.jobId, command.attemptId, command.generation);
      }
      const repositorySnapshotId = command.repositorySnapshotId ?? null;
      const sourceReferences = validateSourceReferences(command.jobId, repositorySnapshotId, command.sourceReferences ?? []);
      const requiredValidation = command.requiredValidation ?? [];
      const requiredEvidenceCategories = [...new Set(command.requiredEvidenceCategories ?? [])].sort();
      const claimId = id('claim');
      db.prepare(
        `INSERT INTO job_claims
           (claim_id, job_id, attempt_id, generation, category, statement, required, state,
            repository_snapshot_id,source_references_json,required_validation_json,
            required_evidence_categories_json,created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?, ?)`,
      ).run(
        claimId, command.jobId, command.attemptId ?? null, command.generation ?? null,
        command.category, command.statement, command.required === true ? 1 : 0,
        repositorySnapshotId, JSON.stringify(sourceReferences), JSON.stringify(requiredValidation),
        JSON.stringify(requiredEvidenceCategories), command.now ?? Date.now(),
      );
      return authority.listClaims(command.jobId).find((claim) => claim.claimId === claimId)!;
    },
    recordEvidence(command) {
      assertAttempt(command.jobId, command.attemptId, command.generation, command.fenceToken);
      const now = command.now ?? Date.now();
      if (command.repositorySnapshotId) {
        const snapshot = db.prepare('SELECT job_id,attempt_id,generation FROM repository_snapshots WHERE snapshot_id=?')
          .get(command.repositorySnapshotId) as { job_id: string; attempt_id: string; generation: number } | undefined;
        const assignedParentSnapshot = snapshot && db.prepare(
          `SELECT 1
             FROM worker_assignments a
             JOIN worker_runs r ON r.assignment_id=a.assignment_id
             JOIN child_job_contracts c ON c.child_job_id=a.child_job_id
            WHERE a.repository_snapshot_id=?
              AND a.parent_job_id=? AND a.parent_attempt_id=? AND a.parent_generation=?
              AND a.child_job_id=? AND r.child_attempt_id=? AND r.child_generation=?
              AND c.parent_job_id=a.parent_job_id
            LIMIT 1`,
        ).get(
          command.repositorySnapshotId,
          snapshot.job_id,
          snapshot.attempt_id,
          snapshot.generation,
          command.jobId,
          command.attemptId,
          command.generation,
        );
        const producingSnapshot = snapshot
          && snapshot.job_id === command.jobId
          && snapshot.attempt_id === command.attemptId
          && snapshot.generation === command.generation;
        if (!producingSnapshot && !assignedParentSnapshot) {
          throw new Error('Evidence repository snapshot does not match the producing Attempt');
        }
      }
      if (command.effectId) {
        const effect = db.prepare(
          `SELECT job_id, attempt_id, generation, attempted_at
             FROM side_effect_ledger WHERE key = ?`,
        ).get(command.effectId) as {
          job_id: string; attempt_id: string; generation: number; attempted_at: number;
        } | undefined;
        if (!effect
          || effect.job_id !== command.jobId
          || effect.attempt_id !== command.attemptId
          || effect.generation !== command.generation) {
          throw new Error('Evidence does not match the linked Effect authority');
        }
        if (command.observedAt < effect.attempted_at) {
          throw new Error('Evidence must be observed after the linked Effect began');
        }
      }
      const payloadJson = JSON.stringify(command.payload ?? null);
      const evidenceId = id('evidence');
      const late = getVerdict(command.jobId) !== null;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO job_evidence (
             evidence_id, job_id, attempt_id, generation, effect_id, repository_snapshot_id, source, producer,
             captured_at, observed_at, fresh_until, integrity_sha256, coverage,
             verification_result, payload_json, late
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          evidenceId, command.jobId, command.attemptId, command.generation, command.effectId ?? null,
          command.repositorySnapshotId ?? null, command.source, command.producer, now, command.observedAt, command.freshUntil ?? null,
          digest(command.payload ?? null), command.coverage, command.verificationResult, payloadJson, late ? 1 : 0,
        );
        if (late) db.prepare(
          `INSERT INTO proof_reviews (job_id, evidence_id, reason, created_at) VALUES (?, ?, 'late evidence', ?)`,
        ).run(command.jobId, evidenceId, now);
      }).immediate();
      return authority.listEvidence(command.jobId).find((evidence) => evidence.evidenceId === evidenceId)!;
    },
    checkClaim(command) {
      const claim = db.prepare('SELECT * FROM job_claims WHERE claim_id = ?').get(command.claimId) as ClaimRow | undefined;
      if (!claim) throw new Error('Claim not found');
      if (getVerdict(claim.job_id)) throw new Error('Final verdict is immutable');
      assertAttempt(claim.job_id, command.attemptId, command.generation);
      const now = command.now ?? Date.now();
      db.transaction(() => {
        const linkedEvidence: EvidenceRow[] = [];
        for (const evidenceId of command.evidenceIds) {
          const evidence = db.prepare('SELECT * FROM job_evidence WHERE evidence_id = ?').get(evidenceId) as EvidenceRow | undefined;
          if (!evidence || evidence.job_id !== claim.job_id || evidence.attempt_id !== command.attemptId || evidence.generation !== command.generation) {
            throw new Error('Stale or unrelated evidence cannot prove this claim');
          }
          if (claim.repository_snapshot_id !== null && evidence.repository_snapshot_id !== claim.repository_snapshot_id) {
            throw new Error('Evidence snapshot does not match the source-bound Claim');
          }
          if (evidence.fresh_until !== null && evidence.fresh_until < now) throw new Error('Stale evidence cannot prove a claim');
          linkedEvidence.push(evidence);
          db.prepare('INSERT OR IGNORE INTO claim_evidence (claim_id, evidence_id, created_at) VALUES (?, ?, ?)')
            .run(command.claimId, evidenceId, now);
        }
        if (command.state === 'verified' && (
          linkedEvidence.length === 0
          || linkedEvidence.some((item) => item.verification_result !== 'verified' || item.coverage !== 'full')
        )) {
          throw new Error('Verified claims require complete verified evidence');
        }
        if (command.state === 'partial' && linkedEvidence.length === 0) {
          throw new Error('Partial claims require supporting evidence');
        }
        if (command.state === 'verified') {
          const requiredCategories = JSON.parse(claim.required_evidence_categories_json) as string[];
          const sources = new Set(linkedEvidence.map((item) => item.source));
          if (requiredCategories.some((category) => !sources.has(category))) {
            throw new Error('Verified Claim is missing a required Evidence category');
          }
          const requirements = JSON.parse(claim.required_validation_json) as ClaimValidationRequirement[];
          const runs = (command.validationRunIds ?? []).map((runId) => {
            const run = db.prepare(
              `SELECT kind,scope,state,parse_state,repository_snapshot_id,job_id,attempt_id,generation,source_mutations_json
                 FROM validation_runs WHERE run_id=?`,
            ).get(runId) as {
              kind: 'test' | 'build'; scope: 'focused' | 'full'; state: string; parse_state: string;
              repository_snapshot_id: string; job_id: string; attempt_id: string; generation: number;
              source_mutations_json: string;
            } | undefined;
            if (!run || run.job_id !== claim.job_id || run.attempt_id !== command.attemptId || run.generation !== command.generation) {
              throw new Error('Stale or unrelated validation cannot prove this Claim');
            }
            if (claim.repository_snapshot_id !== null && run.repository_snapshot_id !== claim.repository_snapshot_id) {
              throw new Error('Validation snapshot does not match the source-bound Claim');
            }
            if (run.state !== 'succeeded' || run.parse_state !== 'parsed' || (JSON.parse(run.source_mutations_json) as unknown[]).length > 0) {
              throw new Error('Incomplete validation cannot prove this Claim');
            }
            return run;
          });
          for (const requirement of requirements) {
            const satisfied = runs.some((run) => run.kind === requirement.kind
              && (!requirement.scope || requirement.scope === 'focused' || run.scope === 'full'));
            if (!satisfied) throw new Error('Verified Claim is missing required validation');
          }
        }
        db.prepare('UPDATE job_claims SET state = ?, attempt_id = ?, generation = ?, checked_at = ? WHERE claim_id = ?')
          .run(command.state, command.attemptId, command.generation, now, command.claimId);
      }).immediate();
      return authority.listClaims(claim.job_id).find((item) => item.claimId === command.claimId)!;
    },
    listClaims,
    listEvidence,
    hasRequiredClaims(jobId) {
      return db.prepare("SELECT 1 FROM job_claims WHERE job_id = ? AND category = 'contract' AND required = 1 LIMIT 1")
        .get(jobId) !== undefined;
    },
    finalize(command) {
      const existing = getVerdict(command.jobId);
      if (existing) return existing;
      assertAttempt(command.jobId, command.attemptId, command.generation, command.fenceToken);
      const claims = listClaims(command.jobId).filter((claim) => claim.category === 'contract' && claim.required);
      const evidence = listEvidence(command.jobId).filter(
        (item) => item.attemptId === command.attemptId && item.generation === command.generation && !item.late,
      );
      const unresolvedEffect = db.prepare(
        `SELECT 1 FROM side_effect_ledger WHERE job_id = ?
          AND effect_state IN ('unknown','partial','started') LIMIT 1`,
      ).get(command.jobId) !== undefined;
      const verifiedCount = claims.filter((claim) => claim.state === 'verified').length;
      const failedCount = claims.filter((claim) => claim.state === 'failed').length;
      const unknownCount = claims.filter((claim) => claim.state === 'unknown' || claim.state === 'unverified' || claim.state === 'partial').length;
      const incompleteCoverage = evidence.some((item) => item.coverage !== 'full' || item.verificationResult === 'unknown');
      let verdict: FinalVerdict;
      if (command.cancelled) verdict = 'cancelled';
      else if (unresolvedEffect || unknownCount > 0 || incompleteCoverage) verdict = verifiedCount > 0 ? 'partially_verified' : 'unknown';
      else if (failedCount > 0) verdict = verifiedCount > 0 ? 'partially_verified' : 'failed';
      else if (claims.length > 0 && verifiedCount === claims.length) verdict = 'verified';
      else verdict = 'unknown';
      const now = command.now ?? Date.now();
      const summary = { requiredClaims: claims.length, verifiedClaims: verifiedCount, failedClaims: failedCount, unknownClaims: unknownCount };
      db.prepare(
        `INSERT INTO job_verdicts (job_id, attempt_id, generation, verdict, summary_json, finalized_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(command.jobId, command.attemptId, command.generation, verdict, JSON.stringify(summary), now);
      return getVerdict(command.jobId)!;
    },
    getVerdict,
    exportJson(jobId) {
      const job = db.prepare('SELECT id, goal, status, terminal_outcome, finish_reason FROM tasks WHERE id = ?').get(jobId);
      if (!job) throw new Error('Job not found');
      const rows = (table: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${table} WHERE job_id = ? ORDER BY ${order}`).all(jobId);
      return {
        job,
        graph: db.prepare('SELECT * FROM execution_graphs WHERE job_id = ?').get(jobId) ?? null,
        attempts: db.prepare('SELECT attempt_id, attempt_number, generation, status, finish_reason FROM runs WHERE task_id = ? ORDER BY attempt_number').all(jobId),
        approvals: rows('approvals', 'rowid'),
        effects: rows('side_effect_ledger', 'attempted_at'),
        claims: listClaims(jobId),
        evidence: listEvidence(jobId),
        claimEvidence: db.prepare(
          `SELECT ce.claim_id AS claimId, ce.evidence_id AS evidenceId, ce.created_at AS createdAt
             FROM claim_evidence ce
             JOIN job_claims c ON c.claim_id = ce.claim_id
            WHERE c.job_id = ? ORDER BY ce.created_at, ce.claim_id, ce.evidence_id`,
        ).all(jobId),
        verdict: getVerdict(jobId),
      };
    },
    exportMarkdown(jobId) {
      const proof = authority.exportJson(jobId) as {
        job: { goal: string }; claims: ClaimRecord[]; evidence: EvidenceRecord[]; verdict: JobVerdictRecord | null;
      };
      const lines = [
        '# Aiden Proof', '', `Goal: ${proof.job.goal}`, '',
        `Verdict: ${proof.verdict?.verdict ?? 'not finalized'}`, '',
        '## Claims',
        ...proof.claims.map((claim) => `- [${claim.state}] ${claim.statement}`),
        '', '## Evidence',
        ...proof.evidence.map((evidence) => `- ${evidence.evidenceId}: ${evidence.source} (${evidence.verificationResult}, ${evidence.coverage})`),
      ];
      return `${lines.join('\n')}\n`;
    },
  };
  return authority;
}
