/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.13 Pillar 1 Gap 1 — verify-before-done verdict policy (pure) +
 * the honesty low_signal surfacing that closes the v1 gap.
 *
 * The model narrates; the runtime keeps score: these tests pin the
 * policy that decides a task's terminal status from the turn's verifier
 * evidence, including the cron-bug regression class ("tool claimed
 * success, produced no evidence → verification_failed, never completed").
 */
import { describe, it, expect } from 'vitest';

import {
  decideTaskVerdict,
  buildEvidenceEnvelope,
  extractEvidenceHandles,
} from '../../core/v4/taskVerification';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';
import { HonestyEnforcement } from '../../moat/honestyEnforcement';

function entry(over: Partial<HonestyTraceEntry>): HonestyTraceEntry {
  return { name: 'tool', result: {}, ...over } as HonestyTraceEntry;
}

const V_OK   = { ok: true,  confidence: 1,   code: 'ok' as const };
const V_LOW  = { ok: true,  confidence: 0.4, code: 'low_signal' as const, reason: 'exit 0, empty stdout' };
const V_FAIL = { ok: false, confidence: 1,   code: 'failed' as const, reason: 'file-write unconfirmed (bytesWritten: 0)' };

describe('decideTaskVerdict — policy', () => {
  it('CRON-BUG REGRESSION: mutating tool claimed success, verifier saw no evidence → verification_failed, never completed', () => {
    const d = decideTaskVerdict([
      entry({
        name: 'file_write',
        result: { success: true, path: 'C:/x/out.txt', bytesWritten: 0 },
        handlerMutates: true,
        verification: V_FAIL,
      }),
    ]);
    expect(d.verdict).toBe('verification_failed');
    expect(d.failures).toEqual([
      { tool: 'file_write', reason: 'file-write unconfirmed (bytesWritten: 0)' },
    ]);
  });

  it('happy path: evidence-backed mutation → completed with concrete handles', () => {
    const d = decideTaskVerdict([
      entry({
        name: 'file_write',
        result: { success: true, path: 'C:/x/out.txt', bytesWritten: 42 },
        handlerMutates: true,
        verification: V_OK,
      }),
    ]);
    expect(d.verdict).toBe('completed');
    const kinds = d.handles.map((h) => `${h.kind}:${h.value}:${h.verified}`);
    expect(kinds).toContain('path:C:/x/out.txt:true');
    expect(kinds).toContain('bytes:42:true');
    expect(d.failures).toEqual([]);
  });

  it('honest downgrade: mutation with only weak evidence → completed_unverified, never silently completed', () => {
    const d = decideTaskVerdict([
      entry({ name: 'shell_exec', result: { exitCode: 0 }, handlerMutates: true, verification: V_LOW }),
    ]);
    expect(d.verdict).toBe('completed_unverified');
  });

  it('mutation with NO verification verdict at all → completed_unverified (unverifiable is not verified)', () => {
    const d = decideTaskVerdict([
      entry({ name: 'custom_mutator', result: { success: true }, handlerMutates: true }),
    ]);
    expect(d.verdict).toBe('completed_unverified');
  });

  it('pure prose turn (no tool calls) → completed — nothing was claimed, nothing gates', () => {
    expect(decideTaskVerdict([]).verdict).toBe('completed');
  });

  it('read-only turn → completed; read evidence still recorded as handles', () => {
    const d = decideTaskVerdict([
      entry({ name: 'file_read', result: { path: 'a.txt' }, handlerMutates: false, verification: V_OK }),
    ]);
    expect(d.verdict).toBe('completed');
    expect(d.handles.some((h) => h.kind === 'path' && h.value === 'a.txt')).toBe(true);
  });

  it('a failed READ never fails the task — the model may have recovered in-turn', () => {
    const d = decideTaskVerdict([
      entry({ name: 'file_read', result: {}, handlerMutates: false, verification: V_FAIL }),
      entry({ name: 'file_write', result: { path: 'b.txt', bytesWritten: 9 }, handlerMutates: true, verification: V_OK }),
    ]);
    expect(d.verdict).toBe('completed');
  });

  it('errored mutation (tool threw) → verification_failed even without a verifier verdict', () => {
    const d = decideTaskVerdict([
      entry({ name: 'file_move', result: null, handlerMutates: true, error: 'EACCES: permission denied' }),
    ]);
    expect(d.verdict).toBe('verification_failed');
    expect(d.failures[0]).toEqual({ tool: 'file_move', reason: 'EACCES: permission denied' });
  });

  it('mixed verified + weak mutations → completed_unverified ("all claims verified" is strict)', () => {
    const d = decideTaskVerdict([
      entry({ name: 'file_write', result: { path: 'a', bytesWritten: 5 }, handlerMutates: true, verification: V_OK }),
      entry({ name: 'shell_exec', result: { exitCode: 0 }, handlerMutates: true, verification: V_LOW }),
    ]);
    expect(d.verdict).toBe('completed_unverified');
  });
});

describe('buildEvidenceEnvelope', () => {
  it('is versioned and carries verdict + handles + failures (+ reportedFailure when given)', () => {
    const d = decideTaskVerdict([
      entry({ name: 'file_write', result: { path: 'x', bytesWritten: 1 }, handlerMutates: true, verification: V_OK }),
    ]);
    const env = buildEvidenceEnvelope(d, { reportedFailure: 'failure', now: 123 });
    expect(env.v).toBe(1);
    expect(env.verdict).toBe('completed');
    expect(env.decidedAt).toBe(123);
    expect(env.handles.length).toBeGreaterThan(0);
    expect(env.reportedFailure).toBe('failure');
  });
});

describe('extractEvidenceHandles', () => {
  it('falls back to a note handle when the result shape carries nothing extractable', () => {
    const hs = extractEvidenceHandles(entry({ name: 't', result: 'raw string', verification: V_LOW }));
    expect(hs).toEqual([
      { tool: 't', kind: 'note', value: 'exit 0, empty stdout', verified: false, code: 'low_signal' },
    ]);
  });
});

// ── Honesty footer — low_signal surfacing (closes the v1 gap) ──────────

describe('HonestyEnforcement — low_signal surfacing (v4.13 Gap 1)', () => {
  const honesty = new HonestyEnforcement('enforce');

  it('surfaces low_signal for MUTATING tools in events + footer', () => {
    const events = honesty.recordOutcomes([
      entry({ name: 'shell_exec', result: { exitCode: 0 }, handlerMutates: true, verification: V_LOW }),
    ]);
    expect(events).toEqual([
      { kind: 'tool_low_signal', tool: 'shell_exec', reason: 'exit 0, empty stdout' },
    ]);
    expect(honesty.buildFooter(events)).toMatch(/shell_exec: weak evidence — exit 0, empty stdout/);
  });

  it('stays quiet for read-only low_signal (no crying wolf on benign reads)', () => {
    const events = honesty.recordOutcomes([
      entry({ name: 'file_read', result: '', handlerMutates: false, verification: V_LOW }),
    ]);
    expect(events).toEqual([]);
  });

  it('hard failures still take precedence (no double event for one entry)', () => {
    const events = honesty.recordOutcomes([
      entry({ name: 'file_write', result: {}, handlerMutates: true, verification: V_FAIL }),
    ]);
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('tool_unverified');
  });
});
