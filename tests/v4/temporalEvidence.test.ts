import { describe, it, expect } from 'vitest';

import {
  evaluateTransition,
  attributeTransition,
  classifyEnvelope,
  meetsThresholds,
  unmetDimensions,
  snapshotPairToEntries,
  type SnapshotObservation,
  type CaptureError,
  type MutationEnvelope,
  type Fingerprint,
  type ClaimThresholds,
} from '../../core/v4/temporalEvidence';
import {
  EvidenceLedger,
  buildEvidenceLedger,
  recordsFromTrace,
  phaseOf,
} from '../../core/v4/claimVerifier';
import type { CommandId } from '../../core/v4/executionContract';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

// ── helpers ──────────────────────────────────────────────────────────────
const present = (fp: Fingerprint = {}): SnapshotObservation => ({ kind: 'present', fingerprint: fp });
const absent: SnapshotObservation = { kind: 'absent' };
const unknown = (cause: CaptureError): SnapshotObservation => ({ kind: 'unknown', cause });
const exact = (...resources: string[]): MutationEnvelope => ({ kind: 'exact', resources });
const R = 'file://r';

// ── the 10 acceptance cases (these ARE the proof) ───────────────────────────

describe('temporal proof — 10 acceptance cases', () => {
  it('1. pre-existing unchanged file cannot prove creation', () => {
    const ev = evaluateTransition(present({ contentHash: 'ABC' }), present({ contentHash: 'ABC' }), exact(R));
    expect(ev.transitionTruth).toBe('no_change');
    expect(ev.ranks.transition).not.toBe('fingerprint_changed');
  });

  it('2. pre-existing changed file proves modification, not creation', () => {
    const ev = evaluateTransition(present({ contentHash: 'ABC' }), present({ contentHash: 'XYZ' }), exact(R));
    expect(ev.transitionTruth).toBe('modified');
  });

  it('3. AccessDenied / timeout / inspection-failure → unknown, never absent', () => {
    for (const cause of ['access_denied', 'timeout', 'inspection_error'] as CaptureError[]) {
      const post = evaluateTransition(present({ contentHash: 'ABC' }), unknown(cause), exact(R));
      expect(post.transitionTruth).toBe('indeterminate');   // cannot prove a transition
      expect(post.transitionTruth).not.toBe('deleted');     // a post read-failure is NOT "gone"
      const pre = evaluateTransition(unknown(cause), present({ contentHash: 'X' }), exact(R));
      expect(pre.transitionTruth).toBe('indeterminate');
      expect(pre.transitionTruth).not.toBe('created');      // a pre read-failure is NOT "was absent"
    }
  });

  it('4. absent→present proves transition only (semantic correctness needs separate evidence)', () => {
    const ev = evaluateTransition(absent, present(), exact(R));
    expect(ev.transitionTruth).toBe('created');
    expect(ev.ranks.validity).toBe('unchecked');            // content was not checked
    expect(meetsThresholds(ev, { transition: 'existence', validity: 'schema_valid', attribution: 'none' })).toBe(false);
  });

  it('5. same hash + changed mtime does NOT prove modification', () => {
    const ev = evaluateTransition(present({ contentHash: 'ABC', mtimeMs: 1 }), present({ contentHash: 'ABC', mtimeMs: 999 }), exact(R));
    expect(ev.transitionTruth).toBe('no_change');
    expect(ev.ranks.transition).toBe('stat_changed');       // a stat moved…
    expect(ev.ranks.transition).not.toBe('fingerprint_changed'); // …but the content did not
  });

  it('6. existing malformed file verifies existence only (not correctness)', () => {
    const ev = evaluateTransition(absent, present({ parses: false }), exact(R));
    expect(ev.stateTruth).toBe('exists_invalid');
    expect(meetsThresholds(ev, { transition: 'existence', validity: 'parses', attribution: 'none' })).toBe(false);
  });

  it('7. non-zero execution stays non-zero even when the artifact state is verified', () => {
    // The temporal core verifies the state postcondition INDEPENDENTLY; it holds
    // no exit code and can never override one (the exit code lives on the
    // execution / the P1B-1 exit_code evidence).
    const ev = evaluateTransition(absent, present({ schemaValid: true }), exact(R));
    expect(ev.stateTruth).toBe('valid');
    expect('exitCode' in ev).toBe(false);
    expect(Object.keys(ev)).not.toContain('exitCode');
  });

  it('8. two candidate writers → verified final state but unknown attribution', () => {
    const attribution = attributeTransition(R, [exact(R), exact(R)]);
    expect(attribution).toBe('unknown');
    const ev = evaluateTransition(absent, present({ schemaValid: true }), exact(R), attribution);
    expect(ev.stateTruth).toBe('valid');                    // the final state IS verified
    expect(ev.attribution).toBe('unknown');                 // but who caused it is not
    expect(attributeTransition(R, [exact(R)])).toBe('isolated'); // a sole exact writer is isolated
  });

  it('9. earlier-missing + later-present observations BOTH remain in the ledger (append-only)', () => {
    const ledger = new EvidenceLedger();
    const entries = snapshotPairToEntries({ resource: R, attempt: 1, pre: absent, post: present({ contentHash: 'X' }) }, 'cmd_1' as CommandId, 0);
    entries.forEach((e) => ledger.append(e));
    const forR = ledger.forResource(R);
    expect(forR).toHaveLength(2);
    expect(forR.map((e) => e.kind)).toEqual(['snapshot_pre', 'snapshot_post']);
    expect((forR[0].snapshot as SnapshotObservation).kind).toBe('absent');
    expect((forR[1].snapshot as SnapshotObservation).kind).toBe('present');
    expect(ledger.all()).toHaveLength(2);                   // neither erased
  });

  it('10. no-promotion: existence-only evidence cannot satisfy a correctness claim', () => {
    const ev = evaluateTransition(absent, present(), exact(R)); // created, content unchecked
    expect(ev.ranks.validity).toBe('unchecked');
    const claim: ClaimThresholds = { transition: 'existence', validity: 'schema_valid', attribution: 'none' };
    expect(meetsThresholds(ev, claim)).toBe(false);
    expect(unmetDimensions(ev, claim)).toContain('validity'); // the shortfall is named
  });
});

// ── envelope classification (pure, from existing resources) ──────────────────

describe('classifyEnvelope — pure logic over P1A resources', () => {
  it('specific resources → exact; mutating opaque → unknown; touched-nothing → exact []', () => {
    expect(classifyEnvelope({ resources: ['file://a'], mutates: true }).kind).toBe('exact');
    expect(classifyEnvelope({ resources: [], mutates: true }).kind).toBe('unknown');   // opaque shell — never guessed
    expect(classifyEnvelope({ resources: [], mutates: false }).kind).toBe('exact');    // non-mutating, nothing touched
  });

  it('bounded stays designed-but-inert — classifyEnvelope never yields it today', () => {
    const kinds = [
      classifyEnvelope({ resources: ['file://a', 'file://b'], mutates: true }).kind,
      classifyEnvelope({ resources: [], mutates: true }).kind,
      classifyEnvelope({ resources: [], mutates: false }).kind,
    ];
    expect(kinds).not.toContain('bounded');
  });
});

// ── backward-compat: the phase extension changed nothing on existing entries ─

describe('backward-compat: phase is additive, default changed nothing', () => {
  const V = (ok: boolean, code: string) => ({ ok, confidence: 1, code: code as any });
  const traceEntry = (o: Partial<HonestyTraceEntry>): HonestyTraceEntry => ({ name: 'x', result: {}, ...o } as HonestyTraceEntry);

  it('existing P1B-1 ledger entries carry no phase and default to execution', () => {
    const records = recordsFromTrace([
      traceEntry({ name: 'file_write', result: { path: 'a', bytesWritten: 10 }, handlerMutates: true, verification: V(true, 'ok') }),
      traceEntry({ name: 'shell_exec', result: { exitCode: 1 }, handlerMutates: false }),
    ]);
    const ledger = buildEvidenceLedger(records);
    expect(ledger.all().length).toBeGreaterThan(0);
    for (const e of ledger.all()) {
      expect(e.phase).toBeUndefined();          // the original appends set no phase…
      expect(phaseOf(e)).toBe('execution');     // …and default to 'execution'
      expect('snapshot' in e).toBe(false);
    }
  });
});
