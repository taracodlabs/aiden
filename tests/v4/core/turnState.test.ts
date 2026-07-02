/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/core/turnState.test.ts — v4.1.6 spike (TCE).
 *
 * Coverage for the per-turn loop-detection + recovery controller:
 *   - Disabled by default (env var unset): all decisions = 'allow',
 *     zero side effects
 *   - Layered streak counters: signature vs name
 *   - Stage 1 HINT: signature-streak threshold (precise — only on
 *     genuine identical-call loops)
 *   - Stage 2 COOLDOWN: name-streak threshold (broader — catches
 *     "fishing through skills" with different args)
 *   - Stage 3 SURFACE: name-streak threshold (strictest, terminal)
 *   - Stage transitions are monotonic (no regression)
 *   - Cooldown decrements via advanceIteration()
 *   - getDiagnosticSnapshot() exposes full internal state for tests
 *     and future debug surfacing
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TurnState } from '../../../core/v4/turnState';

describe('TurnState (v4.1.6 spike)', () => {
  beforeEach(() => {
    delete process.env.AIDEN_TCE;
  });

  afterEach(() => {
    delete process.env.AIDEN_TCE;
  });

  it('opt-out via AIDEN_TCE=0: all calls return allow, no side effects', () => {
    // v4.2 Phase 6 — TCE is ON by default; opt-out is strict
    // `AIDEN_TCE=0`. This test asserts the opt-out path: explicit
    // `=0` disables the tracer entirely, every call returns allow.
    process.env.AIDEN_TCE = '0';
    const ts = new TurnState();
    expect(ts.isEnabled()).toBe(false);
    for (let i = 0; i < 30; i += 1) {
      const d = ts.recordToolCall('skill_view', { name: 'demo' });
      expect(d.kind).toBe('allow');
    }
    expect(ts.getCooledDownTools()).toEqual([]);
    const snap = ts.getDiagnosticSnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.stage).toBe('none');
    expect(snap.recoveryEvents).toHaveLength(0);
  });

  it('v4.2 Phase 6 — default ON: TCE active when env var unset', () => {
    // New default-on sentinel. Constructed with no opts and no env
    // var → isEnabled() must be true. Asserts the Phase 6 flip.
    delete process.env.AIDEN_TCE;
    const ts = new TurnState();
    expect(ts.isEnabled()).toBe(true);
    // Tracer actually fires — record a call, snapshot should reflect it.
    ts.recordToolCall('skill_view', { name: 'demo' });
    const snap = ts.getDiagnosticSnapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.toolCalls).toHaveLength(1);
  });

  it('enabled via env var: hint stage fires at signature-streak 5', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    expect(ts.isEnabled()).toBe(true);
    const args = { name: 'nse-scanner' };
    // Calls 1-4: allow.
    for (let i = 0; i < 4; i += 1) {
      expect(ts.recordToolCall('skill_view', args).kind).toBe('allow');
    }
    // Call 5: hint triggers (signature-streak === 5).
    const d5 = ts.recordToolCall('skill_view', args);
    expect(d5.kind).toBe('hint');
    expect(d5.toolName).toBe('skill_view');
    expect(d5.consecutive).toBe(5);
    expect(d5.hintMessage).toMatch(/skill_view/);
    expect(d5.hintMessage).toMatch(/5 times/);
  });

  it('hint does NOT fire when same TOOL but DIFFERENT args (legitimate exploration)', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    // 5 different skill_view calls — signature changes each time.
    const decisions = [
      ts.recordToolCall('skill_view', { name: 'nse-scanner' }),
      ts.recordToolCall('skill_view', { name: 'nse-options' }),
      ts.recordToolCall('skill_view', { name: 'zerodha-kite' }),
      ts.recordToolCall('skill_view', { name: 'upstox' }),
      ts.recordToolCall('skill_view', { name: 'archon-bridge' }),
    ];
    // None of these are hints — the signature-streak resets each time.
    for (const d of decisions) {
      expect(d.kind).toBe('allow');
    }
    // But the name-streak is still 5 (same tool).
    const snap = ts.getDiagnosticSnapshot();
    expect(snap.consecName).toEqual({ name: 'skill_view', count: 5 });
    expect(snap.consecSignature.count).toBe(1); // last call, fresh signature
  });

  // v4.13 — cooldown/surface gate on LOOP-LIKE counts (identical
  // signature streak, or consecutive FAILURES). Varied-args streaks
  // that keep succeeding are legitimate bulk work (the live-demo false
  // positive: 11 legit file_move calls got the "stuck" banner).
  const V_FAIL = { ok: false, confidence: 1, code: 'failed' as const, reason: 'nope' };
  const V_OK   = { ok: true,  confidence: 1, code: 'ok' as const };

  it('v4.13: 12 varied-args SUCCESSFUL calls → NO cooldown/surface (bulk work is legal)', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    for (let i = 0; i < 12; i += 1) {
      const d = ts.recordToolCall('file_move', { from: `a${i}.txt`, to: `dir/a${i}.txt` }, V_OK);
      expect(d.kind).toBe('allow');
    }
    expect(ts.getCooledDownTools()).toEqual([]);
    expect(ts.getDiagnosticSnapshot().stage).toBe('none');
  });

  it('v4.13: varied SUCCESSFUL streak hits the soft ceiling → ONE informational hint, never cooldown', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState({ variedNameHintThreshold: 6 });
    for (let i = 0; i < 5; i += 1) {
      expect(ts.recordToolCall('file_move', { from: `f${i}`, to: `g${i}` }, V_OK).kind).toBe('allow');
    }
    const d6 = ts.recordToolCall('file_move', { from: 'f5', to: 'g5' }, V_OK);
    expect(d6.kind).toBe('hint');
    expect(d6.hintMessage).toMatch(/intentional bulk work/);
    // Beyond the ceiling: still never cooldown/surface for successes.
    for (let i = 6; i < 15; i += 1) {
      const d = ts.recordToolCall('file_move', { from: `f${i}`, to: `g${i}` }, V_OK);
      expect(d.kind).toBe('allow');
    }
    expect(ts.getCooledDownTools()).toEqual([]);
  });

  it('v4.13: 8 IDENTICAL-args calls (even succeeding) → cooldown — that IS a loop', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    let last: ReturnType<TurnState['recordToolCall']> = { kind: 'allow', consecutive: 0 };
    for (let i = 0; i < 8; i += 1) {
      last = ts.recordToolCall('file_read', { path: 'same.txt' }, V_OK);
    }
    expect(last.kind).toBe('cooldown');
    expect(last.consecutive).toBe(8);
    expect(ts.getCooledDownTools()).toEqual(['file_read']);
  });

  it('cooldown fires at 8 consecutive varied-args FAILURES (fishing while failing)', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    let d: ReturnType<TurnState['recordToolCall']> = { kind: 'allow', consecutive: 0 };
    for (let i = 0; i < 8; i += 1) {
      d = ts.recordToolCall('skill_view', { name: `skill_${i}` }, V_FAIL);
    }
    expect(d.kind).toBe('cooldown');
    expect(d.toolName).toBe('skill_view');
    expect(d.consecutive).toBe(8);
    expect(d.cooldownMessage).toMatch(/skill_view/);
    expect(d.cooldownMessage).toMatch(/disabled/);
    expect(ts.getCooledDownTools()).toEqual(['skill_view']);
  });

  it('surface fires at 11 consecutive varied-args FAILURES', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    for (let i = 0; i < 10; i += 1) {
      ts.recordToolCall('skill_view', { name: `s${i}` }, V_FAIL);
    }
    const d11 = ts.recordToolCall('skill_view', { name: 's10' }, V_FAIL);
    expect(d11.kind).toBe('surface');
    expect(d11.toolName).toBe('skill_view');
    expect(d11.consecutive).toBe(11);
    expect(d11.surfaceCard).toBeDefined();
    expect(d11.surfaceCard!.title).toMatch(/Stuck on repeated tool calls/i);
    expect(d11.surfaceCard!.cannotReliably[0]).toMatch(/skill_view/);
    expect(d11.surfaceCard!.cannotReliably[0]).toMatch(/11/);
    expect(d11.surfaceCard!.fix).toBeTruthy();
  });

  it('stages are monotonic: surface absorbs further calls without re-firing', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    for (let i = 0; i < 11; i += 1) {
      ts.recordToolCall('skill_view', { name: `s${i}` }, V_FAIL);
    }
    // We're now in surfaced stage. Further calls return allow
    // (or at least don't re-emit surface decisions).
    const d12 = ts.recordToolCall('skill_view', { name: 's11' }, V_FAIL);
    expect(d12.kind).not.toBe('hint');
    expect(d12.kind).not.toBe('cooldown');
    // Stays surfaced.
    expect(ts.getDiagnosticSnapshot().stage).toBe('surfaced');
  });

  it('different tool resets BOTH name and signature streaks', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    // Build up a 4-call name-streak.
    for (let i = 0; i < 4; i += 1) {
      ts.recordToolCall('skill_view', { name: `s${i}` });
    }
    // Different tool resets everything.
    ts.recordToolCall('web_search', { query: 'foo' });
    const snap = ts.getDiagnosticSnapshot();
    expect(snap.consecName).toEqual({ name: 'web_search', count: 1 });
    expect(snap.consecSignature.count).toBe(1);
  });

  it('successfulTools captures distinct tools that ran before surface', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    ts.recordToolCall('web_search',   { q: 'foo' });
    ts.recordToolCall('fetch_page',   { url: 'http://x' });
    ts.recordToolCall('execute_code', { code: '1+1' });
    // Then a skill_view loop.
    for (let i = 0; i < 11; i += 1) {
      ts.recordToolCall('skill_view', { name: `s${i}` });
    }
    const snap = ts.getDiagnosticSnapshot();
    // All three pre-loop tools captured.
    expect(snap.successfulTools).toContain('web_search');
    expect(snap.successfulTools).toContain('fetch_page');
    expect(snap.successfulTools).toContain('execute_code');
  });

  it('surfaceCard.canStill lists earlier successful tools', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    ts.recordToolCall('web_search',   { q: 'foo' });
    ts.recordToolCall('execute_code', { code: '1+1' });
    for (let i = 0; i < 10; i += 1) {
      ts.recordToolCall('skill_view', { name: `s${i}` }, V_FAIL);
    }
    const surface = ts.recordToolCall('skill_view', { name: 's10' }, V_FAIL);
    expect(surface.kind).toBe('surface');
    // canStill should mention web_search + execute_code, NOT skill_view.
    const text = surface.surfaceCard!.canStill.join('\n');
    expect(text).toMatch(/web_search/);
    expect(text).toMatch(/execute_code/);
    expect(text).not.toMatch(/`skill_view`/);
  });

  it('cooldown decrements via advanceIteration; tool returns to schemas after N', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState({ cooldownIterations: 3 });
    for (let i = 0; i < 8; i += 1) {
      ts.recordToolCall('skill_view', { name: `s${i}` }, V_FAIL);
    }
    expect(ts.getCooledDownTools()).toEqual(['skill_view']);
    // 3 iterations to expire.
    ts.advanceIteration();
    expect(ts.getCooledDownTools()).toEqual(['skill_view']);
    ts.advanceIteration();
    expect(ts.getCooledDownTools()).toEqual(['skill_view']);
    ts.advanceIteration();
    expect(ts.getCooledDownTools()).toEqual([]);
  });

  it('configurable thresholds', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState({
      hintConsecThreshold:     2,
      cooldownConsecThreshold: 3,
      surfaceConsecThreshold:  4,
    });
    expect(ts.recordToolCall('x', { a: 1 }).kind).toBe('allow');
    expect(ts.recordToolCall('x', { a: 1 }).kind).toBe('hint');
    expect(ts.recordToolCall('x', { a: 1 }).kind).toBe('cooldown');
    expect(ts.recordToolCall('x', { a: 1 }).kind).toBe('surface');
  });

  it('canonical args hash: key-order independent', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    // Same logical args, different key orders → same signature.
    ts.recordToolCall('t', { a: 1, b: 2 });
    ts.recordToolCall('t', { b: 2, a: 1 });
    const snap = ts.getDiagnosticSnapshot();
    expect(snap.consecSignature.count).toBe(2);
  });

  it('explicit enabled:false overrides env var', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState({ enabled: false });
    expect(ts.isEnabled()).toBe(false);
    for (let i = 0; i < 20; i += 1) {
      expect(ts.recordToolCall('x', {}).kind).toBe('allow');
    }
  });

  it('recovery events appended in order (hint → cooldown → surface)', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    const sameArgs = { x: 1 };
    // 5 identical → hint event (signature streak).
    for (let i = 0; i < 5; i += 1) ts.recordToolCall('t', sameArgs);
    // v4.13 — varied args count toward cooldown/surface only when
    // FAILING; 8 consecutive failures → cooldown, 11 → surface.
    for (let i = 0; i < 8; i += 1) ts.recordToolCall('t', { x: i + 2 }, V_FAIL);
    for (let i = 0; i < 3; i += 1) ts.recordToolCall('t', { x: i + 100 }, V_FAIL);

    const events = ts.getDiagnosticSnapshot().recoveryEvents;
    expect(events.map((e) => e.stage)).toEqual(['hinted', 'cooldown', 'surfaced']);
    // Counts should be monotonic.
    expect(events[0]!.count).toBe(5);
    expect(events[1]!.count).toBe(8);
    expect(events[2]!.count).toBe(11);
  });

  it('diagnostic snapshot exposes full internal state', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    ts.recordToolCall('web_search', { q: 'foo' });
    ts.recordToolCall('skill_view', { name: 's1' });
    ts.recordToolCall('skill_view', { name: 's2' });
    const snap = ts.getDiagnosticSnapshot();
    expect(snap).toMatchObject({
      enabled: true,
      stage:   'none',
      toolCalls: expect.arrayContaining([
        expect.objectContaining({ name: 'web_search' }),
        expect.objectContaining({ name: 'skill_view' }),
      ]),
      thresholds: expect.objectContaining({
        hintConsec:     5,
        cooldownConsec: 8,
        surfaceConsec:  11,
        cooldownIters:  3,
      }),
    });
    expect(snap.consecName.name).toBe('skill_view');
    expect(snap.consecName.count).toBe(2);
  });

  it('args hash handles null/undefined gracefully', () => {
    process.env.AIDEN_TCE = '1';
    const ts = new TurnState();
    expect(() => ts.recordToolCall('t', null)).not.toThrow();
    expect(() => ts.recordToolCall('t', undefined)).not.toThrow();
    expect(() => ts.recordToolCall('t', { circular: undefined })).not.toThrow();
  });

  it('disabled tracer: getDiagnosticSnapshot still works (returns disabled state)', () => {
    // v4.2 Phase 6 — default ON requires explicit opt-out for this
    // assertion to hold. Use the constructor `enabled: false` override
    // so the test stays env-var-independent.
    const ts = new TurnState({ enabled: false });
    const snap = ts.getDiagnosticSnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.stage).toBe('none');
    expect(snap.toolCalls).toHaveLength(0);
    expect(snap.cooledDownTools).toHaveLength(0);
  });
});
