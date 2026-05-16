/**
 * v4.5 Phase 5a — RecoveryReport.triggerContext tests.
 *
 * Covers:
 *   1. buildRecoveryReport with input.triggerContext attaches the field
 *   2. enrichCardWithReport renders a "Trigger:" line via triggerContext
 */
import { describe, it, expect } from 'vitest';
import {
  buildRecoveryReport,
  enrichCardWithReport,
} from '../../../../core/v4/recoveryReport';
import type { TurnStateDiagnosticSnapshot } from '../../../../core/v4/turnState';
import type { CapabilityCardData } from '../../../../providers/v4/types';

function mkSnapshot(): TurnStateDiagnosticSnapshot {
  return {
    enabled:         true,
    stage:           'surfaced',
    consecName:      { name: null, count: 0 },
    consecSignature: { signature: null, count: 0 },
    consecFailed:    { name: null, count: 0 },
    cooledDownTools: [],
    toolCalls:       [],
    successfulTools: [],
    recoveryEvents:  [],
    verifications:   [],
    classifications: [],
    thresholds: { hintConsec: 5, cooldownConsec: 8, surfaceConsec: 11, cooldownIters: 3, failedConsec: 3 },
  };
}

const TRIGGER_CTX = {
  triggerId:          'wat-1',
  source:             'file',
  sourceKey:          'wat-1',
  fireReason:         'fs.modified',
  eventId:            42,
  attempt:            2,
  maxAttempts:        3,
  promptTemplateUsed: true,
} as const;

describe('buildRecoveryReport — triggerContext attachment', () => {
  it('attaches the triggerContext input verbatim to the report', () => {
    const r = buildRecoveryReport({
      snapshot:  mkSnapshot(),
      goal:      'do thing',
      exitReason: 'stop',
      durationMs: 1000,
      triggerContext: { ...TRIGGER_CTX },
    });
    expect(r.triggerContext).toBeTruthy();
    expect(r.triggerContext?.triggerId).toBe('wat-1');
    expect(r.triggerContext?.attempt).toBe(2);
    expect(r.triggerContext?.promptTemplateUsed).toBe(true);
  });

  it('omits triggerContext when not supplied (interactive run)', () => {
    const r = buildRecoveryReport({
      snapshot:  mkSnapshot(),
      goal:      'do thing',
      exitReason: 'stop',
      durationMs: 1000,
    });
    expect(r.triggerContext).toBeUndefined();
  });
});

describe('enrichCardWithReport — triggerContext render', () => {
  it('renders Trigger: line with source/triggerId · attempt · templated · reason', () => {
    const base: CapabilityCardData = {
      title:          'Test',
      canStill:       [],
      cannotReliably: [],
      fix:            '',
    };
    const r = buildRecoveryReport({
      snapshot:   mkSnapshot(),
      goal:       'g',
      exitReason: 'stop',
      durationMs: 1000,
      triggerContext: { ...TRIGGER_CTX },
    });
    const enriched = enrichCardWithReport(base, r);
    expect(enriched.triggerContext).toBeTruthy();
    expect(enriched.triggerContext).toContain('Trigger:');
    expect(enriched.triggerContext).toContain('file/wat-1');
    expect(enriched.triggerContext).toContain('attempt 2/3');
    expect(enriched.triggerContext).toContain('templated');
    expect(enriched.triggerContext).toContain('fs.modified');
  });

  it('omits trigger line when triggerContext absent', () => {
    const base: CapabilityCardData = {
      title:          'Test',
      canStill:       [],
      cannotReliably: [],
      fix:            '',
    };
    const r = buildRecoveryReport({
      snapshot:   mkSnapshot(),
      goal:       'g',
      exitReason: 'stop',
      durationMs: 1000,
    });
    const enriched = enrichCardWithReport(base, r);
    expect(enriched.triggerContext).toBeUndefined();
  });
});
