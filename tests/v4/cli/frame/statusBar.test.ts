/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 4 Slice 1 — pinned status-bar width-budget.
 */
import { describe, it, expect } from 'vitest';
import { renderStatusBar, statusSegments, fmtTokens, type StatusBarModel } from '../../../../cli/v4/frame/statusBar';

function model(over: Partial<StatusBarModel> = {}): StatusBarModel {
  return {
    busy: true, verb: 'thinking', elapsedS: 3,
    model: 'chatgpt-plus·gpt-5.5', contextTokens: 8_200, contextMax: 200_000,
    activeSubagents: 0, cwd: '/home/u/project/DevOS', pendingApproval: false, nBehind: null,
    ...over,
  };
}

describe('fmtTokens', () => {
  it('compacts counts', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1200)).toBe('1.2k');
    expect(fmtTokens(45_000)).toBe('45k');
    expect(fmtTokens(2_500_000)).toBe('2.5M');
  });
});

describe('renderStatusBar — width budget', () => {
  it('wide terminal shows all applicable segments including context %', () => {
    const bar = renderStatusBar(model({ activeSubagents: 2, nBehind: 'v4.13 ↑' }), 120);
    expect(bar).toContain('chatgpt-plus·gpt-5.5');
    expect(bar).toContain('ctx 8.2k/200k 4%');
    expect(bar).toContain('2 sub');
    expect(bar).toContain('v4.13 ↑');
    expect(bar).toContain('thinking 3s');
  });

  it('NARROW terminal keeps model + context full, drops lower-priority segments first', () => {
    // 44 cols: model(20)+ctx(16)+sep(3)=39 fits; optional segments don't.
    const bar = renderStatusBar(model({ activeSubagents: 2, nBehind: 'v4.13 ↑' }), 44);
    expect(bar).toContain('chatgpt-plus·gpt-5.5');   // model pinned, full
    expect(bar).toContain('ctx 8.2k/200k 4%');        // context pinned, full
    // Right-side, lower-priority segments are dropped first.
    expect(bar).not.toContain('v4.13 ↑');
    expect(bar).not.toContain('2 sub');
    expect(bar.length).toBeLessThanOrEqual(44);
  });

  it('very narrow: model is TRUNCATED but never dropped; context survives whole', () => {
    // 24 cols: ctx(16)+sep(3) leaves 5 for the model → truncated with ellipsis.
    const bar = renderStatusBar(model(), 24);
    expect(bar).toContain('ctx 8.2k/200k 4%');        // context always present, full
    expect(bar).toMatch(/…/);                         // model truncated with ellipsis
    expect(bar.length).toBeLessThanOrEqual(24);
  });

  it('a long busy verb is BOUNDED so it never shoves model/context off screen', () => {
    const bar = renderStatusBar(model({ verb: 'calling a_very_long_tool_name_that_would_dominate_the_whole_bar' }), 80);
    expect(bar).toContain('chatgpt-plus·gpt-5.5');
    expect(bar).toContain('ctx');
    // busy segment capped — the giant verb is truncated, not full-length.
    expect(bar).toContain('…');
  });

  it('pending approval is high-priority — kept over cwd / N-behind', () => {
    // 60 cols: model(20)+ctx(16)+approval(10)+2 seps(6)=52 fits; cwd/behind drop.
    const bar = renderStatusBar(model({ pendingApproval: true, cwd: '/x/y/zzzzzz', nBehind: 'v4.13 ↑' }), 60);
    expect(bar).toContain('⚠ approval');
    expect(bar).toContain('chatgpt-plus·gpt-5.5');
    expect(bar).not.toContain('v4.13 ↑');             // approval outranks N-behind
  });

  it('idle shows "idle" instead of a verb', () => {
    expect(renderStatusBar(model({ busy: false }), 100)).toContain('idle');
  });

  it('no contextMax → shows raw tokens, no %', () => {
    const bar = renderStatusBar(model({ contextMax: null }), 100);
    expect(bar).toContain('ctx 8.2k');
    expect(bar).not.toContain('%');
  });
});

describe('statusSegments — priorities', () => {
  it('model + context are priority 0 (pinned)', () => {
    const segs = statusSegments(model());
    expect(segs.find((s) => s.key === 'model')?.priority).toBe(0);
    expect(segs.find((s) => s.key === 'context')?.priority).toBe(0);
    expect(segs.find((s) => s.key === 'cwd')!.priority).toBeGreaterThan(
      segs.find((s) => s.key === 'context')!.priority,
    );
  });
});
