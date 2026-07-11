import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compareVerifiers,
  makeResourceDigester,
  UNRELATED_FAILURE_CONTAMINATION,
  type LegacyVerdictInput,
} from '../../core/v4/verifierComparison';
import {
  buildEvidenceLedger,
  evaluateClaim,
  isForbiddenConfirmed,
  runShadowClaimVerifierDetailed,
  type ClaimDefinition,
  type ForbiddenCondition,
  type TaskContract,
  type TaskEvaluation,
  type TaskClaimVerdict,
  type Coverage,
  type ShadowClaimDetail,
} from '../../core/v4/claimVerifier';
import { buildCommandRecord, type CommandRecord, type ResourceId } from '../../core/v4/executionContract';
import { computeTaskFinalization } from '../../core/v4/taskVerification';
import { resolveAidenPaths } from '../../core/v4/paths';
import { recordVerifierDivergence, appendDivergenceRecord } from '../../core/v4/verificationAudit';
import type { SnapshotPair } from '../../core/v4/temporalEvidence';

// ── builders ──────────────────────────────────────────────────────────────

const okWrite = (p: string): CommandRecord =>
  buildCommandRecord({ providerCallId: '', tool: 'file_write', args: {}, mutates: true, result: { path: p, bytesWritten: 12 }, verification: { ok: true, code: 'ok', confidence: 1 } });
const failWrite = (p: string, tool = 'file_write'): CommandRecord =>
  buildCommandRecord({ providerCallId: '', tool, args: {}, mutates: true, result: { path: p }, error: 'disk full' });

const claim = (resource: string, predicate: string): ClaimDefinition =>
  ({ id: `req:${resource}`, category: 'contract', resource, predicate, required: true });

const fakeDigest = (id: ResourceId): string => `D:${id.length}:${id.slice(-4)}`;
const baseOpts = (over: Record<string, unknown> = {}) => ({ now: 1000, turnId: 't1', digest: fakeDigest, ...over });

const legacyFailed = (failures: { tool: string; reason: string }[]): LegacyVerdictInput => ({ status: 'verification_failed', failures });
const legacyDone = (): LegacyVerdictInput => ({ status: 'completed', failures: [] });

/** Build a ShadowClaimDetail with a HAND-SET verdict/coverage but REAL ledger +
 *  claim evaluations — so the comparator's independent recheck reads true
 *  evidence while we can force an inconsistent verdict to prove it isn't trusted. */
function detailOf(o: {
  records: CommandRecord[];
  requiredDefs?: ClaimDefinition[];
  coverage: Coverage;
  verdict: TaskClaimVerdict;
  forbidden?: ForbiddenCondition[];
}): ShadowClaimDetail {
  const requiredDefs = o.requiredDefs ?? [];
  const forbidden = o.forbidden ?? [];
  const ledger = buildEvidenceLedger(o.records);
  const required = requiredDefs.map((d) => evaluateClaim(d, ledger));
  const forbiddenConfirmed = forbidden.filter((fc) => isForbiddenConfirmed(fc, ledger));
  const contract: TaskContract = { requiredClaims: requiredDefs, optionalClaims: [], forbiddenConditions: forbidden, coverage: o.coverage, source: 'user_explicit', frozenAt: 0 };
  const evaluation: TaskEvaluation = { verdict: o.verdict, reason: 'test', required, observed: [], coverage: o.coverage, forbiddenConfirmed };
  return { evaluation, contract, records: o.records, ledger };
}

// ── the classifier teeth ────────────────────────────────────────────────────

describe('compareVerifiers — buckets + precedence', () => {
  it('1. unrelated-failure contamination, every invariant passes → EXPECTED_FIX', () => {
    const detail = detailOf({
      records: [okWrite('/work/good.txt'), failWrite('/work/bad.txt')],
      requiredDefs: [claim('file:///work/good.txt', 'good.txt is present and valid')],
      coverage: 'complete',
      verdict: 'verified',
    });
    const rec = compareVerifiers(legacyFailed([{ tool: 'file_write', reason: 'disk full' }]), detail, baseOpts());
    expect(rec.bucket).toBe('EXPECTED_FIX');
    expect(rec.classificationRuleId).toBe(UNRELATED_FAILURE_CONTAMINATION);
  });

  it('2. THE critical one — legacy failed, new SAYS verified, but coverage incomplete → DANGEROUS_LENIENCY, not EXPECTED_FIX', () => {
    // verdict is hand-forced to 'verified' though coverage is only partial; the
    // comparator must re-check I1 and refuse to trust the verdict OR pattern-match the bug.
    const detail = detailOf({
      records: [okWrite('/work/good.txt'), failWrite('/work/bad.txt')],
      requiredDefs: [claim('file:///work/good.txt', 'good.txt present')],
      coverage: 'partial',
      verdict: 'verified',
    });
    const rec = compareVerifiers(legacyFailed([{ tool: 'file_write', reason: 'disk full' }]), detail, baseOpts());
    expect(rec.bucket).toBe('DANGEROUS_LENIENCY');
    expect(rec.classificationRuleId).toBeNull();
    expect(rec.invariantsFailed).toContain('I1_coverage_complete');
  });

  it('3. new verified + a required claim lacks evidence → DANGEROUS_LENIENCY (I3)', () => {
    const detail = detailOf({
      records: [okWrite('/work/good.txt')],
      requiredDefs: [claim('file:///work/good.txt', 'good present'), claim('file:///work/nope.txt', 'nope present')],
      coverage: 'complete',
      verdict: 'verified',
    });
    const rec = compareVerifiers(legacyDone(), detail, baseOpts());
    expect(rec.bucket).toBe('DANGEROUS_LENIENCY');
    expect(rec.invariantsFailed).toContain('I3_required_has_evidence');
  });

  it('4. new verified + capture-failure read as absent (unknown pre) → DANGEROUS_LENIENCY (I5 unknown)', () => {
    const detail = detailOf({
      records: [okWrite('/work/new.txt')],
      requiredDefs: [claim('file:///work/new.txt', 'created file:///work/new.txt')],
      coverage: 'complete',
      verdict: 'verified',
    });
    const snap: SnapshotPair = {
      resource: 'file:///work/new.txt', attempt: 1,
      pre: { kind: 'unknown', cause: 'timeout' },          // capture failure — NEVER absent
      post: { kind: 'present', fingerprint: { size: 5, contentHash: 'h' } },
    };
    const rec = compareVerifiers(legacyDone(), detail, baseOpts({ snapshots: [snap] }));
    expect(rec.bucket).toBe('DANGEROUS_LENIENCY');
    expect(rec.invariantsUnknown).toContain('I5_temporal_transition_proven');
  });

  it('5. legacy completed, new unverified (coverage incomplete, nothing disproven) → EXPECTED_STRICTNESS', () => {
    const detail = detailOf({ records: [okWrite('/work/a.txt')], coverage: 'unknown', verdict: 'unverified' });
    const rec = compareVerifiers(legacyDone(), detail, baseOpts());
    expect(rec.bucket).toBe('EXPECTED_STRICTNESS');
    expect(rec.classificationRuleId).toBeNull();
  });

  it('6. a divergence matching no rule → UNEXPLAINED (fail-closed)', () => {
    // legacy completed, new 'failed' with a genuinely disproven required claim:
    // not dangerous (verdict≠verified), not fix (legacy not failed), not strictness (something disproven).
    const detail = detailOf({
      records: [failWrite('/work/x.txt')],
      requiredDefs: [claim('file:///work/x.txt', 'x present')],
      coverage: 'complete',
      verdict: 'failed',
    });
    const rec = compareVerifiers(legacyDone(), detail, baseOpts());
    expect(rec.bucket).toBe('UNEXPLAINED');
    expect(rec.classificationRuleId).toBeNull();
  });

  it('7. precedence — a case matching the EXPECTED_FIX shape AND a dangerous invariant → DANGEROUS_LENIENCY wins', () => {
    // unrelated-contamination shape (legacy failed, unrelated bad.txt, new verified),
    // but ALSO a second required claim with no evidence (I3 fail). Danger is checked first.
    const detail = detailOf({
      records: [okWrite('/work/good.txt'), failWrite('/work/bad.txt')],
      requiredDefs: [claim('file:///work/good.txt', 'good present'), claim('file:///work/missing.txt', 'missing present')],
      coverage: 'complete',
      verdict: 'verified',
    });
    const rec = compareVerifiers(legacyFailed([{ tool: 'file_write', reason: 'disk full' }]), detail, baseOpts());
    expect(rec.bucket).toBe('DANGEROUS_LENIENCY');
    expect(rec.classificationRuleId).toBeNull();
  });

  it('9. refinement 5 — legacy failure that cannot be reconstructed from records → UNEXPLAINED', () => {
    // legacy claims a shell_exec failure, but no shell_exec record failed (e.g. a
    // disk-check failure the pure comparator cannot reproduce). Fail closed.
    const detail = detailOf({
      records: [okWrite('/work/good.txt'), failWrite('/work/bad.txt')],
      requiredDefs: [claim('file:///work/good.txt', 'good present')],
      coverage: 'complete',
      verdict: 'verified',
    });
    const rec = compareVerifiers(legacyFailed([{ tool: 'shell_exec', reason: 'unreconstructable' }]), detail, baseOpts());
    expect(rec.bucket).toBe('UNEXPLAINED');
    expect(rec.classificationRuleId).toBeNull();
  });

  it('10. refinement 3 — an earlier failure recovered by an INDEPENDENT later command reconciles (I7 passes)', () => {
    const early = failWrite('/work/r.txt');   // execution A: failed
    const late = okWrite('/work/r.txt');       // execution B (distinct id): verified
    const detail = detailOf({
      records: [early, late],
      requiredDefs: [claim('file:///work/r.txt', 'r present')],
      coverage: 'complete',
      verdict: 'verified',
    });
    const rec = compareVerifiers(legacyDone(), detail, baseOpts());
    expect(rec.invariantsPassed).toContain('I7_failure_lineage_reconciled');
    expect(rec.bucket).not.toBe('DANGEROUS_LENIENCY');   // recovery is legitimate
  });

  it('10b. refinement 3 — an unresolved current contradiction (latest obs failing) blocks success (I7 fails → DANGEROUS)', () => {
    const detail = detailOf({
      records: [okWrite('/work/r.txt'), failWrite('/work/r.txt')],  // latest = failing
      requiredDefs: [claim('file:///work/r.txt', 'r present')],
      coverage: 'complete',
      verdict: 'verified',
    });
    const rec = compareVerifiers(legacyDone(), detail, baseOpts());
    expect(rec.bucket).toBe('DANGEROUS_LENIENCY');
    expect(rec.invariantsFailed).toContain('I7_failure_lineage_reconciled');
  });

  it('11. canonical normalization + divergence direction, both original enums preserved', () => {
    const detail = detailOf({ records: [okWrite('/work/a.txt')], coverage: 'unknown', verdict: 'unverified' });
    const rec = compareVerifiers(legacyDone(), detail, baseOpts());
    expect(rec.legacyVerdict).toBe('completed');
    expect(rec.newVerdict).toBe('unverified');
    expect(rec.legacyCanonical).toBe('success');
    expect(rec.newCanonical).toBe('weak_success');
    expect(rec.divergenceDirection).toBe('new_stricter');
  });
});

// ── privacy: the record is a proof trail, never raw material ─────────────────

describe('compareVerifiers — privacy minimization', () => {
  it('8. persists only digests/codes/ids — no raw path, content, secret, or reason string', () => {
    const secretPath = '/work/secret/credentials.env';
    const detail = detailOf({
      records: [failWrite(secretPath)],
      requiredDefs: [claim(`file://${secretPath}`, `wrote file://${secretPath}`)],
      coverage: 'complete',
      verdict: 'failed',
    });
    const digest = makeResourceDigester('install-key-xyz', '/work');
    const rec = compareVerifiers(
      { status: 'verification_failed', failures: [{ tool: 'file_write', reason: `wrote ${secretPath} but it was absent on disk` }] },
      detail,
      baseOpts({ digest }),
    );
    const serialized = JSON.stringify(rec);
    for (const forbidden of ['credentials', 'secret', '.env', '/work', 'file://', 'absent on disk']) {
      expect(serialized).not.toContain(forbidden);
    }
    // it DID capture the proof trail — just in minimized form
    expect(rec.resourceDigests.every((d) => d.startsWith('rd1:'))).toBe(true);
    expect(rec.legacyReasonCodes).toContain('reason:missing_artifact');
    expect(rec.executionIds.every((id) => id.startsWith('cmd_'))).toBe(true);
    expect(typeof rec.evidenceCount).toBe('number');
  });
});

// ── the caller wiring + fault isolation + no-flip ───────────────────────────

describe('verificationAudit — wiring, no-flip, fault isolation', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'aiden-dv-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('12. production reality + no-flip — real trace → EXPECTED_STRICTNESS, and finalization output is behaviourally identical with vs without the comparison', () => {
    const paths = resolveAidenPaths({ rootOverride: dir });
    const trace = [{ name: 'file_write', handlerMutates: true, result: { path: path.join(dir, 'a.txt'), bytesWritten: 3 }, verification: { ok: true, code: 'ok', confidence: 1 } }] as never;
    const turn = { finishReason: 'stop', toolCallTrace: trace, declaredStatus: null };

    // Pin the finalization clock so `decidedAt` is deterministic — what we are
    // proving is that the comparison layer does not alter the authoritative
    // output, NOT that computeTaskFinalization is clock-free.
    const finBefore = computeTaskFinalization(turn, { now: 42 });
    const detail = runShadowClaimVerifierDetailed(trace);
    const rec = recordVerifierDivergence({
      paths, cwd: dir, now: 1, turnId: 't',
      legacy: { status: finBefore.status, failures: finBefore.evidence.failures, handleCodes: finBefore.evidence.handles.map((h) => h.code).filter((c): c is string => !!c) },
      detail,
    });
    const finAfter = computeTaskFinalization(turn, { now: 42 });

    expect(finAfter).toEqual(finBefore);                         // behavioural identity (refinement 6)
    expect(rec).not.toBeNull();
    expect(rec!.bucket).toBe('EXPECTED_STRICTNESS');             // production shadow: coverage unknown → strictness
    expect(rec!.classificationRuleId).toBeNull();
    expect(existsSync(paths.verificationDivergenceLog)).toBe(true);  // it wrote locally
  });

  it('13. fault-isolated — a comparison that throws returns null and never throws', () => {
    const paths = resolveAidenPaths({ rootOverride: dir });
    const detail = detailOf({
      records: [okWrite('/work/x.txt')],
      requiredDefs: [claim('file:///work/x.txt', 'created x')],  // transition claim → temporal path runs
      coverage: 'complete',
      verdict: 'verified',
    });
    const badSnap = { resource: 'file:///work/x.txt', attempt: 1, pre: undefined, post: undefined } as unknown as SnapshotPair;
    let out: unknown;
    expect(() => {
      out = recordVerifierDivergence({ paths, cwd: dir, now: 1, turnId: 't', legacy: legacyFailed([{ tool: 'file_write', reason: 'x' }]), detail, snapshots: [badSnap] });
    }).not.toThrow();
    expect(out).toBeNull();
  });

  it('14. append is fault-isolated — an unwritable target does not throw', () => {
    const notADir = path.join(dir, 'blocker');
    writeFileSync(notADir, 'x');                                  // a FILE where the audit dir should be
    const paths = { ...resolveAidenPaths({ rootOverride: dir }), verificationAuditDir: notADir, verificationDivergenceLog: path.join(notADir, 'divergence.jsonl') };
    expect(() => appendDivergenceRecord(paths, { schemaVersion: 'dvc1' } as never)).not.toThrow();
  });
});
