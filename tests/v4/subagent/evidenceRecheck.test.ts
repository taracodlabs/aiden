/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 3 — evidence-required subagent reports (Phases A + C).
 *
 * The parent no longer trusts a child's prose. It scores the child's OWN tool
 * trace through the shared verify-before-done gate and re-checks each concrete
 * handle against reality ("no handle, no trust"):
 *   • valid handle that re-checks       → verified, ok
 *   • CLAIMED artifact that isn't there → verification_failed, NOT ok
 *   • pure-reasoning (no artifact)      → advisory (reasoningOnly), not verified
 *   • clean loop exit but the mutation
 *     never verified                    → NOT ok (the old clean-exit ok is dead)
 */
import { describe, it, expect } from 'vitest';
import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';
import {
  extractProofHandles,
  recheckHandles,
  deriveSubagentEvidence,
  trustLabelOf,
} from '../../../core/v4/subagent/evidenceRecheck';

/** Build a trace entry. `ok`-verified mutating writes default to a good result. */
function entry(over: Partial<HonestyTraceEntry> & { name: string }): HonestyTraceEntry {
  return {
    result: {},
    handlerMutates: false,
    verification: { ok: true, confidence: 1, code: 'ok' },
    ...over,
  } as HonestyTraceEntry;
}

const wroteFile = (path: string): HonestyTraceEntry =>
  entry({ name: 'file_write', handlerMutates: true, result: { path } });

// ── extractProofHandles ──────────────────────────────────────────────────────

describe('extractProofHandles', () => {
  it('pulls path / exit_code / object_id from MUTATING entries only', () => {
    const trace: HonestyTraceEntry[] = [
      wroteFile('/tmp/a.txt'),
      entry({ name: 'shell_exec', handlerMutates: true, result: { exitCode: 0 } }),
      entry({ name: 'create_thing', handlerMutates: true, result: { id: 'obj_9' } }),
      entry({ name: 'file_read', handlerMutates: false, result: { path: '/tmp/read.txt' } }), // read → ignored
    ];
    const handles = extractProofHandles(trace);
    expect(handles).toEqual([
      { tool: 'file_write', kind: 'path', value: '/tmp/a.txt' },
      { tool: 'shell_exec', kind: 'exit_code', value: 0 },
      { tool: 'create_thing', kind: 'object_id', value: 'obj_9' },
    ]);
  });

  it('ignores errored and skipped mutations, dedups by (kind,value)', () => {
    const trace: HonestyTraceEntry[] = [
      entry({ name: 'file_write', handlerMutates: true, error: 'disk full', result: {} }),
      entry({ name: 'file_move', handlerMutates: true, result: { skipped: true, from: '/x', to: '/y' } }),
      wroteFile('/tmp/dup.txt'),
      wroteFile('/tmp/dup.txt'),  // duplicate
    ];
    expect(extractProofHandles(trace)).toEqual([
      { tool: 'file_write', kind: 'path', value: '/tmp/dup.txt' },
    ]);
  });
});

// ── recheckHandles ───────────────────────────────────────────────────────────

describe('recheckHandles', () => {
  it('path present → survives; path missing → failure', () => {
    const handles = extractProofHandles([wroteFile('/tmp/present.txt'), wroteFile('/tmp/gone.txt')]);
    const r = recheckHandles(handles, { existsSync: (p) => p === '/tmp/present.txt' });
    expect(r.allPass).toBe(false);
    expect(r.handles.map((h) => h.value)).toEqual(['/tmp/present.txt']);
    expect(r.failures[0].reason).toMatch(/does not exist/);
  });

  it('exit_code 0 passes, non-zero fails; object_id is best-effort present', () => {
    const ok = recheckHandles([{ tool: 'shell_exec', kind: 'exit_code', value: 0 }]);
    expect(ok.allPass).toBe(true);
    const bad = recheckHandles([{ tool: 'shell_exec', kind: 'exit_code', value: 3 }]);
    expect(bad.allPass).toBe(false);
    const id = recheckHandles([{ tool: 't', kind: 'object_id', value: 'x' }]);
    expect(id.allPass).toBe(true);            // never a hard local failure
  });

  it('no handles → vacuously allPass (reasoning-only is not a failure)', () => {
    expect(recheckHandles([]).allPass).toBe(true);
  });
});

// ── deriveSubagentEvidence — the composed verdict ────────────────────────────

describe('deriveSubagentEvidence', () => {
  const existsTrue  = () => true;
  const existsFalse = () => false;

  it('valid handle that re-checks → verified + ok (accepted)', () => {
    const ev = deriveSubagentEvidence([wroteFile('/tmp/real.txt')], { existsSync: existsTrue });
    expect(ev.verdict).toBe('completed');
    expect(ev.verified).toBe(true);
    expect(ev.ok).toBe(true);
    expect(ev.reasoningOnly).toBe(false);
    expect(ev.handles).toHaveLength(1);
  });

  it('CLAIMS a file it never wrote (handle missing on re-check) → verification_failed, NOT ok', () => {
    const ev = deriveSubagentEvidence([wroteFile('/tmp/never.txt')], { existsSync: existsFalse });
    expect(ev.verdict).toBe('verification_failed');
    expect(ev.ok).toBe(false);
    expect(ev.verified).toBe(false);
    expect(ev.evidence.failures.some((f) => /does not exist/.test(f.reason))).toBe(true);
  });

  it('pure reasoning (no mutating work) → advisory: completed + ok but NOT verified', () => {
    const trace: HonestyTraceEntry[] = [
      entry({ name: 'file_read', handlerMutates: false, result: { path: '/tmp/in.txt' } }),
    ];
    const ev = deriveSubagentEvidence(trace, { existsSync: existsFalse });
    expect(ev.verdict).toBe('completed');
    expect(ev.reasoningOnly).toBe(true);
    expect(ev.verified).toBe(false);          // advisory, not verified-fact
    expect(ev.ok).toBe(true);
    expect(ev.handles).toHaveLength(0);
  });

  it('clean loop exit but the mutation never verified → NOT ok (old clean-exit ok is dead)', () => {
    // A mutating write the dispatch verifier already marked !ok — no handle
    // re-check even needed: computeTaskFinalization returns verification_failed.
    const trace: HonestyTraceEntry[] = [
      entry({
        name: 'file_write', handlerMutates: true, result: { path: '/tmp/claimed.txt' },
        verification: { ok: false, confidence: 1, code: 'failed', reason: 'write did not persist' },
      }),
    ];
    const ev = deriveSubagentEvidence(trace, { existsSync: existsTrue });
    expect(ev.verdict).toBe('verification_failed');
    expect(ev.ok).toBe(false);
  });
});

// ── G2 — existence is not proof: empty / placeholder files are failed claims ──
describe('recheckHandles — G2 stub / empty file downgrade', () => {
  const present = () => true;
  it('a file that exists but is EMPTY → failure (existence alone is not verified)', () => {
    const h = extractProofHandles([wroteFile('/tmp/empty.txt')]);
    const r = recheckHandles(h, { existsSync: present, readFile: () => '   \n\t ' });
    expect(r.allPass).toBe(false);
    expect(r.failures[0].reason).toMatch(/empty/);
  });

  it('a file whose whole body is a stub marker (TODO) → failure', () => {
    const h = extractProofHandles([wroteFile('/tmp/stub.ts')]);
    const r = recheckHandles(h, { existsSync: present, readFile: () => '// TODO: implement later' });
    expect(r.allPass).toBe(false);
    expect(r.failures[0].reason).toMatch(/placeholder stub/);
  });

  it('a real file with substantial content → survives', () => {
    const h = extractProofHandles([wroteFile('/tmp/real.ts')]);
    const r = recheckHandles(h, { existsSync: present, readFile: () => 'export const answer = 42;\nfunction real() { return answer; }\n' });
    expect(r.allPass).toBe(true);
    expect(r.handles).toHaveLength(1);
  });

  it('a LONG file that merely contains "TODO" is NOT a stub (low false-positive)', () => {
    const big = 'function real() {\n  // TODO: refine later\n  return doWork();\n}\n'.repeat(4);
    const h = extractProofHandles([wroteFile('/tmp/big.ts')]);
    expect(recheckHandles(h, { existsSync: present, readFile: () => big }).allPass).toBe(true);
  });

  it('deriveSubagentEvidence: a claimed EMPTY file downgrades verified → verification_failed', () => {
    const ev = deriveSubagentEvidence([wroteFile('/tmp/empty.txt')], { existsSync: present, readFile: () => '' });
    expect(ev.verdict).toBe('verification_failed');
    expect(ev.verified).toBe(false);
    expect(ev.ok).toBe(false);
  });
});

// ── G1 — remote object_id/URL: honest "unconfirmed", never silently "verified" ──
describe('recheckHandles / deriveSubagentEvidence — G1 remote handle honesty', () => {
  it('object_id with NO probe → unconfirmed (not a verified handle, not a failure)', () => {
    const r = recheckHandles([{ tool: 'create_pr', kind: 'object_id', value: 'PR#42' }]);
    expect(r.allPass).toBe(true);              // never a hard local failure
    expect(r.handles).toHaveLength(0);         // does NOT count as verified evidence
    expect(r.unconfirmed).toHaveLength(1);
  });

  it('a remote-only child is unconfirmedRemote, NOT verified — "PR created" is not confirmed', () => {
    const trace: HonestyTraceEntry[] = [
      entry({ name: 'create_pr', handlerMutates: true, result: { id: 'PR#42' } }),
    ];
    const ev = deriveSubagentEvidence(trace);
    expect(ev.verdict).toBe('completed');
    expect(ev.verified).toBe(false);
    expect(ev.unconfirmedRemote).toBe(true);
  });

  it('probeRemote=false → the claimed remote object is a hallucination (failure)', () => {
    const r = recheckHandles([{ tool: 'create_pr', kind: 'object_id', value: 'PR#nope' }], { probeRemote: () => false });
    expect(r.allPass).toBe(false);
    expect(r.failures[0].reason).toMatch(/not found/);
  });

  it('probeRemote=true → confirmed; counts as a verified handle', () => {
    const r = recheckHandles([{ tool: 'create_pr', kind: 'object_id', value: 'PR#42' }], { probeRemote: () => true });
    expect(r.allPass).toBe(true);
    expect(r.handles).toHaveLength(1);
    expect(r.unconfirmed).toHaveLength(0);
  });
});

// ── the shared trust taxonomy ────────────────────────────────────────────────
describe('trustLabelOf — one honest taxonomy', () => {
  it('maps each state to its label (verification_failed dominates)', () => {
    expect(trustLabelOf({ verdict: 'verification_failed', verified: true })).toBe('verification_failed');
    expect(trustLabelOf({ verified: true })).toBe('verified');
    expect(trustLabelOf({ verified: true, unconfirmedRemote: true })).toBe('partial');
    expect(trustLabelOf({ unconfirmedRemote: true })).toBe('unconfirmed_remote');
    expect(trustLabelOf({ reasoningOnly: true })).toBe('advisory');
    expect(trustLabelOf({})).toBe('unverified');
  });
});
