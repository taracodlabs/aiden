/**
 * v4.2 Phase 3 — RecoveryReport generator unit tests.
 *
 * Coverage:
 *   1. Goal extraction (4 input shapes: string / ContentBlock[] / missing / over-length)
 *   2. buildRecoveryReport — counts, breakdown, failedTools (latest-wins),
 *      recoveryStages passthrough, guidance dominance + tiebreak
 *   3. Guidance text covers all 12 FailureCategory values (v4.3 Phase 5)
 *   4. enrichCardWithReport — non-mutation, field overlay, whatHappened
 *      formatting, failuresByCategory ordering
 *   5. Edge cases: empty snapshot, no failures, multi-tool, tie counts
 */
import { describe, it, expect } from 'vitest';
import {
  buildRecoveryReport,
  enrichCardWithReport,
  extractGoal,
  guidanceFor,
  type RecoveryReport,
} from '../../../core/v4/recoveryReport';
import type { TurnStateDiagnosticSnapshot } from '../../../core/v4/turnState';
import type { CapabilityCardData, Message } from '../../../providers/v4/types';
import type { FailureCategory } from '../../../core/v4/failureClassifier';

function mkSnapshot(over: Partial<TurnStateDiagnosticSnapshot> = {}): TurnStateDiagnosticSnapshot {
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
    ...over,
  };
}

function v(name: string, ok: boolean, code: 'ok' | 'failed' = ok ? 'ok' : 'failed') {
  return { name, ts: 1000, verification: { ok, confidence: 1.0, code } as const };
}

function c(name: string, category: FailureCategory, reason = '', confidence = 0.9) {
  return {
    name,
    ts: 1000,
    classification: {
      category, confidence, reason, recoverable: true,
    },
  };
}

function r(stage: 'hinted' | 'cooldown' | 'surfaced', toolName: string, count: number) {
  return { stage, toolName, count, ts: 1000 };
}

const BASE_CARD: CapabilityCardData = {
  title:          'Stuck on repeated tool calls',
  canStill:       ['Reuse `file_read`'],
  cannotReliably: ['Call `web_search` again'],
  fix:            'Generic existing fix',
};

// ── extractGoal ─────────────────────────────────────────────────────────────

describe('extractGoal', () => {
  it('returns string content unchanged when short', () => {
    const msgs: Message[] = [{ role: 'user', content: 'find the bug' }];
    expect(extractGoal(msgs)).toBe('find the bug');
  });

  it('truncates over-140-char content with ellipsis', () => {
    const long = 'A'.repeat(200);
    const msgs: Message[] = [{ role: 'user', content: long }];
    const result = extractGoal(msgs);
    expect(result.length).toBe(140);
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles ContentBlock[] content (Anthropic shape)', () => {
    const msgs: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ] as never,
    }];
    expect(extractGoal(msgs)).toBe('hello world');
  });

  it('returns empty string when no user message', () => {
    const msgs: Message[] = [{ role: 'assistant', content: 'hi' }];
    expect(extractGoal(msgs)).toBe('');
  });

  it('returns empty array case as empty string', () => {
    expect(extractGoal([])).toBe('');
  });

  it('trims leading/trailing whitespace', () => {
    const msgs: Message[] = [{ role: 'user', content: '   spaced out   ' }];
    expect(extractGoal(msgs)).toBe('spaced out');
  });
});

// ── guidanceFor (all 16 categories — extended v4.5 Phase 5a) ──────────────

describe('guidanceFor — all 16 categories', () => {
  const cats: FailureCategory[] = [
    'timeout', 'auth', 'hallucination', 'network', 'permission',
    'rate_limit', 'invalid_input', 'dependency_missing', 'not_found',
    'stale_ref', 'manual_blocker',                          // v4.3 Phase 5
    'sandbox_violation',                                    // v4.4 Phase 5
    'trigger_misconfigured', 'trigger_quota',               // v4.5 Phase 5a
    'trigger_dead_lettered',                                // v4.5 Phase 5a
    'other',
  ];
  for (const cat of cats) {
    it(`returns non-empty guidance for ${cat}`, () => {
      const g = guidanceFor(cat);
      expect(g.length).toBeGreaterThan(20);
      expect(typeof g).toBe('string');
    });
  }

  it('returns distinct guidance per category (no shared strings)', () => {
    const all = cats.map(guidanceFor);
    const unique = new Set(all);
    expect(unique.size).toBe(cats.length);
  });
});

// ── buildRecoveryReport ────────────────────────────────────────────────────

describe('buildRecoveryReport', () => {
  it('empty snapshot produces zeroed report with "other" guidance', () => {
    const r = buildRecoveryReport({
      snapshot:   mkSnapshot(),
      goal:       'test',
      exitReason: 'tool_loop',
      durationMs: 1500,
    });
    expect(r.goal).toBe('test');
    expect(r.exitReason).toBe('tool_loop');
    expect(r.durationMs).toBe(1500);
    expect(r.attempts).toEqual({ total: 0, succeeded: 0, failed: 0 });
    expect(r.failureBreakdown).toEqual({});
    expect(r.failedTools).toEqual([]);
    expect(r.successfulTools).toEqual([]);
    expect(r.recoveryStages).toEqual([]);
    expect(r.guidance).toBe(guidanceFor('other'));
  });

  it('counts succeeded/failed correctly from verifications', () => {
    const snapshot = mkSnapshot({
      toolCalls: [
        { name: 'file_read', argsHash: 'a1', ts: 100 },
        { name: 'file_read', argsHash: 'a2', ts: 200 },
        { name: 'web_fetch', argsHash: 'b1', ts: 300 },
      ],
      verifications: [
        v('file_read', true),
        v('file_read', false),
        v('web_fetch', false),
      ],
    });
    const r = buildRecoveryReport({
      snapshot, goal: 'x', exitReason: 'tool_loop', durationMs: 1000,
    });
    expect(r.attempts.total).toBe(3);
    expect(r.attempts.succeeded).toBe(1);
    expect(r.attempts.failed).toBe(2);
  });

  it('aggregates failure breakdown from classifications', () => {
    const snapshot = mkSnapshot({
      classifications: [
        c('shell_exec', 'timeout'),
        c('shell_exec', 'timeout'),
        c('file_read', 'permission'),
      ],
    });
    const r = buildRecoveryReport({
      snapshot, goal: 'x', exitReason: 'tool_loop', durationMs: 1000,
    });
    expect(r.failureBreakdown).toEqual({ timeout: 2, permission: 1 });
  });

  it('failedTools holds LATEST classification per tool name', () => {
    const snapshot = mkSnapshot({
      classifications: [
        c('shell_exec', 'timeout',    'first try'),
        c('shell_exec', 'permission', 'second try'),
        c('shell_exec', 'auth',       'third try'),  // latest wins for shell_exec
        c('file_read',  'not_found',  'missing'),
      ],
    });
    const r = buildRecoveryReport({
      snapshot, goal: 'x', exitReason: 'tool_loop', durationMs: 1000,
    });
    expect(r.failedTools).toHaveLength(2);
    const byName = Object.fromEntries(r.failedTools.map((f) => [f.name, f]));
    expect(byName.shell_exec.category).toBe('auth');
    expect(byName.shell_exec.reason).toBe('third try');
    expect(byName.file_read.category).toBe('not_found');
  });

  it('passes successfulTools through unchanged', () => {
    const snapshot = mkSnapshot({
      successfulTools: ['file_read', 'web_search'],
    });
    const r = buildRecoveryReport({
      snapshot, goal: 'x', exitReason: 'tool_loop', durationMs: 1000,
    });
    expect(r.successfulTools).toEqual(['file_read', 'web_search']);
  });

  it('recoveryStages strips ts but preserves order + counts', () => {
    const snapshot = mkSnapshot({
      recoveryEvents: [
        r('hinted',   'shell_exec', 5),
        r('cooldown', 'shell_exec', 8),
        r('surfaced', 'shell_exec', 11),
      ],
    });
    const result = buildRecoveryReport({
      snapshot, goal: 'x', exitReason: 'tool_loop', durationMs: 1000,
    });
    expect(result.recoveryStages).toEqual([
      { stage: 'hinted',   toolName: 'shell_exec', count: 5  },
      { stage: 'cooldown', toolName: 'shell_exec', count: 8  },
      { stage: 'surfaced', toolName: 'shell_exec', count: 11 },
    ]);
  });

  it('dominant-category guidance fires for clear winner', () => {
    const snapshot = mkSnapshot({
      classifications: [
        c('a', 'timeout'),
        c('b', 'timeout'),
        c('c', 'timeout'),
        c('d', 'permission'),
      ],
    });
    const r = buildRecoveryReport({
      snapshot, goal: 'x', exitReason: 'tool_loop', durationMs: 1000,
    });
    expect(r.guidance).toBe(guidanceFor('timeout'));
  });

  it('ties break by priority rank (timeout beats permission at equal count)', () => {
    const snapshot = mkSnapshot({
      classifications: [
        c('a', 'permission'),
        c('b', 'timeout'),
      ],
    });
    const r = buildRecoveryReport({
      snapshot, goal: 'x', exitReason: 'tool_loop', durationMs: 1000,
    });
    expect(r.guidance).toBe(guidanceFor('timeout'));
  });

  it('cooldown-no-surface snapshot still builds a valid report', () => {
    // Stage didn't reach surfaced — caller still chose to build a report.
    // Counters reflect partial state.
    const snapshot = mkSnapshot({
      stage: 'cooldown',
      toolCalls: [
        { name: 'web_fetch', argsHash: 'h1', ts: 100 },
        { name: 'web_fetch', argsHash: 'h2', ts: 200 },
      ],
      verifications: [
        v('web_fetch', false),
        v('web_fetch', false),
      ],
      classifications: [
        c('web_fetch', 'timeout'),
        c('web_fetch', 'timeout'),
      ],
      recoveryEvents: [r('cooldown', 'web_fetch', 8)],
    });
    const result = buildRecoveryReport({
      snapshot, goal: 'fetch X', exitReason: 'stop', durationMs: 800,
    });
    expect(result.attempts).toEqual({ total: 2, succeeded: 0, failed: 2 });
    expect(result.recoveryStages).toHaveLength(1);
    expect(result.recoveryStages[0].stage).toBe('cooldown');
  });

  it('mixed exit reasons surface correctly', () => {
    for (const reason of ['stop', 'tool_loop', 'budget_exhausted', 'error'] as const) {
      const r = buildRecoveryReport({
        snapshot: mkSnapshot(), goal: 'x', exitReason: reason, durationMs: 100,
      });
      expect(r.exitReason).toBe(reason);
    }
  });

  it('is pure — repeated calls with same inputs produce identical output', () => {
    const snapshot = mkSnapshot({
      classifications: [c('a', 'timeout')],
    });
    const r1 = buildRecoveryReport({ snapshot, goal: 'g', exitReason: 'tool_loop', durationMs: 100 });
    const r2 = buildRecoveryReport({ snapshot, goal: 'g', exitReason: 'tool_loop', durationMs: 100 });
    expect(r1).toEqual(r2);
  });
});

// ── enrichCardWithReport ───────────────────────────────────────────────────

describe('enrichCardWithReport', () => {
  function baseReport(over: Partial<RecoveryReport> = {}): RecoveryReport {
    return {
      goal:            'do thing',
      exitReason:      'tool_loop',
      durationMs:      4200,
      attempts:        { total: 8, succeeded: 2, failed: 6 },
      failureBreakdown: { timeout: 4, permission: 2 },
      failedTools:     [],
      successfulTools: [],
      recoveryStages:  [],
      guidance:        'do this next',
      ...over,
    };
  }

  it('does not mutate the base card', () => {
    const base = { ...BASE_CARD };
    const snapshot = { ...base };
    enrichCardWithReport(base, baseReport());
    expect(base).toEqual(snapshot);
  });

  it('preserves title / canStill / cannotReliably from base', () => {
    const out = enrichCardWithReport(BASE_CARD, baseReport());
    expect(out.title).toBe(BASE_CARD.title);
    expect(out.canStill).toEqual(BASE_CARD.canStill);
    expect(out.cannotReliably).toEqual(BASE_CARD.cannotReliably);
  });

  it('replaces fix with the report guidance', () => {
    const out = enrichCardWithReport(BASE_CARD, baseReport({ guidance: 'new guidance' }));
    expect(out.fix).toBe('new guidance');
  });

  it('whatHappened formats counts + duration', () => {
    const out = enrichCardWithReport(BASE_CARD, baseReport());
    expect(out.whatHappened).toContain('8 tool calls');
    expect(out.whatHappened).toContain('2 succeeded');
    expect(out.whatHappened).toContain('6 failed');
    expect(out.whatHappened).toContain('4.2s');
  });

  it('whatHappened uses singular "call" for n=1', () => {
    const out = enrichCardWithReport(BASE_CARD, baseReport({
      attempts: { total: 1, succeeded: 0, failed: 1 },
    }));
    expect(out.whatHappened).toContain('1 tool call ·');
  });

  it('failuresByCategory ordered desc count then priority asc', () => {
    const out = enrichCardWithReport(BASE_CARD, baseReport({
      failureBreakdown: { permission: 5, timeout: 5, other: 1, auth: 3 },
    }));
    // permission and timeout both have 5 — timeout wins (priority).
    // Then auth(3), then other(1).
    expect(out.failuresByCategory).toEqual([
      { category: 'timeout',    count: 5 },
      { category: 'permission', count: 5 },
      { category: 'auth',       count: 3 },
      { category: 'other',      count: 1 },
    ]);
  });

  it('failuresByCategory empty when breakdown empty', () => {
    const out = enrichCardWithReport(BASE_CARD, baseReport({
      failureBreakdown: {},
    }));
    expect(out.failuresByCategory).toEqual([]);
  });
});

// ── v4.4 Phase 5 — sandboxContext ──────────────────────────────────────────

describe('buildRecoveryReport — sandboxContext (Phase 5)', () => {
  function mkSandboxClassification(opts: {
    name?: string;
    code: string;
    matchedPolicy?: string;
    requestedPath?: string;
    resolvedPath?: string;
  }) {
    return {
      name: opts.name ?? 'file_write',
      classification: {
        category:    'sandbox_violation' as const,
        confidence:  0.95,
        reason:      `${opts.code} matched`,
        recoverable: false,
        recoveryHint: {
          action: 'request_user_action' as const,
          detail: `Add to allowlist: AIDEN_SANDBOX_ALLOW=/some/path`,
        },
        matchedPattern: opts.code,
        sandboxViolation: {
          code:          opts.code,
          matchedPolicy: opts.matchedPolicy ?? '',
          requestedPath: opts.requestedPath ?? '',
          resolvedPath:  opts.resolvedPath  ?? '',
        },
      },
    };
  }

  it('absent when no sandbox_violation in classifications', () => {
    const snap = mkSnapshot({
      classifications: [{
        name: 'shell_exec',
        classification: {
          category: 'timeout', confidence: 1.0, recoverable: true,
          recoveryHint: { action: 'retry_with_backoff' },
        },
      }],
    });
    const r = buildRecoveryReport({ snapshot: snap, goal: 'g', exitReason: 'verifier_signal', durationMs: 0 });
    expect(r.sandboxContext).toBeUndefined();
  });

  it('present when at least one sandbox_violation fired', () => {
    const snap = mkSnapshot({
      classifications: [mkSandboxClassification({
        code: 'fs.write_outside_allowlist',
        requestedPath: '/opt/foo.txt',
        resolvedPath:  '/opt/foo.txt',
      })],
    });
    const r = buildRecoveryReport({ snapshot: snap, goal: 'g', exitReason: 'verifier_signal', durationMs: 0 });
    expect(r.sandboxContext).toBeDefined();
    expect(r.sandboxContext!.violationCount).toBe(1);
    expect(r.sandboxContext!.fsViolations).toBe(1);
    expect(r.sandboxContext!.shellViolations).toBe(0);
    expect(r.sandboxContext!.lastCode).toBe('fs.write_outside_allowlist');
  });

  it('FS vs shell breakdown', () => {
    const snap = mkSnapshot({
      classifications: [
        mkSandboxClassification({ code: 'fs.write_outside_allowlist' }),
        mkSandboxClassification({ code: 'fs.sensitive_path' }),
        mkSandboxClassification({ name: 'shell_exec', code: 'docker_unavailable' }),
      ],
    });
    const r = buildRecoveryReport({ snapshot: snap, goal: 'g', exitReason: 'verifier_signal', durationMs: 0 });
    expect(r.sandboxContext!.fsViolations).toBe(2);
    expect(r.sandboxContext!.shellViolations).toBe(1);
    expect(r.sandboxContext!.violationCount).toBe(3);
  });

  it('lastCode + lastMatched + lastRequested come from the most recent entry', () => {
    const snap = mkSnapshot({
      classifications: [
        mkSandboxClassification({ code: 'fs.write_outside_allowlist', resolvedPath: '/a' }),
        mkSandboxClassification({
          code: 'fs.sensitive_path',
          matchedPolicy: '/etc',
          requestedPath: '/etc/passwd',
        }),
      ],
    });
    const r = buildRecoveryReport({ snapshot: snap, goal: 'g', exitReason: 'verifier_signal', durationMs: 0 });
    expect(r.sandboxContext!.lastCode).toBe('fs.sensitive_path');
    expect(r.sandboxContext!.lastMatched).toBe('/etc');
    expect(r.sandboxContext!.lastRequested).toBe('/etc/passwd');
  });

  it('suggestedEnv comes from the last recoveryHint.detail', () => {
    const snap = mkSnapshot({
      classifications: [mkSandboxClassification({ code: 'fs.write_outside_allowlist' })],
    });
    const r = buildRecoveryReport({ snapshot: snap, goal: 'g', exitReason: 'verifier_signal', durationMs: 0 });
    expect(r.sandboxContext!.suggestedEnv).toMatch(/AIDEN_SANDBOX_ALLOW/);
  });

  it('synthesizeGuidance picks sandbox_violation when it dominates', () => {
    const snap = mkSnapshot({
      classifications: [
        mkSandboxClassification({ code: 'fs.write_outside_allowlist' }),
        mkSandboxClassification({ code: 'fs.sensitive_path' }),
      ],
    });
    const r = buildRecoveryReport({ snapshot: snap, goal: 'g', exitReason: 'verifier_signal', durationMs: 0 });
    expect(r.guidance).toMatch(/sandbox/i);
  });

  it('enrichCardWithReport surfaces sandboxContext string', () => {
    const snap = mkSnapshot({
      classifications: [mkSandboxClassification({
        code: 'fs.write_outside_allowlist',
        resolvedPath: '/opt/foo.txt',
      })],
    });
    const report = buildRecoveryReport({ snapshot: snap, goal: 'g', exitReason: 'verifier_signal', durationMs: 0 });
    const card = enrichCardWithReport({
      title: 't', canStill: [], cannotReliably: [], fix: '',
    }, report);
    expect(card.sandboxContext).toBeDefined();
    expect(card.sandboxContext).toMatch(/Sandbox:/);
    expect(card.sandboxContext).toMatch(/1 blocked/);
    expect(card.sandboxContext).toMatch(/fs\.write_outside_allowlist/);
    expect(card.sandboxContext).toMatch(/AIDEN_SANDBOX_ALLOW/);
  });
});
