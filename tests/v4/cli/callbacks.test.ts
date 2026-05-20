import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { CliCallbacks, type PromptApi } from '../../../cli/v4/callbacks';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeDisplay() {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  return {
    display: new Display({
      skin: new SkinEngine({ forceMono: true }),
      stdout: out,
    }),
    output: () => stripAnsi(chunks.join('')),
  };
}

function mockPrompts(answers: { kind: 'select' | 'confirm'; value: any }[]): PromptApi {
  let i = 0;
  return {
    async select() {
      const a = answers[i];
      i += 1;
      if (a.kind !== 'select') throw new Error(`expected select, got ${a.kind}`);
      return a.value;
    },
    async confirm() {
      const a = answers[i];
      i += 1;
      if (a.kind !== 'confirm') throw new Error(`expected confirm, got ${a.kind}`);
      return a.value;
    },
  };
}

describe('CliCallbacks.promptApproval', () => {
  it('renders the approval card with risk tier and reason', async () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({
      display,
      promptModule: mockPrompts([{ kind: 'select', value: 'allow' }]),
    });
    const decision = await cb.promptApproval({
      toolName: 'shell_exec',
      category: 'execute',
      args: { command: 'rm -rf /' },
      riskTier: 'dangerous',
      reason: 'destructive command',
    });
    expect(decision).toBe('allow');
    const out = output();
    // Phase 22 Task 5B: rendered as a yellow-bordered rounded box.
    expect(out).toMatch(/┌── Approval required /);
    expect(out).toMatch(/Tool: shell_exec/);
    expect(out).toMatch(/dangerous/);
    expect(out).toMatch(/Reason: destructive command/);
  });

  it('returns the chosen decision verbatim', async () => {
    const { display } = makeDisplay();
    const cb = new CliCallbacks({
      display,
      promptModule: mockPrompts([{ kind: 'select', value: 'allow_session' }]),
    });
    const d = await cb.promptApproval({
      toolName: 'write_file',
      category: 'write',
      args: { path: '/tmp/x' },
    });
    expect(d).toBe('allow_session');
  });

  it('fail-closes when prompt throws (Ctrl+C)', async () => {
    const { display } = makeDisplay();
    const throwing: PromptApi = {
      async select() {
        throw new Error('cancel');
      },
      async confirm() {
        throw new Error('cancel');
      },
    };
    const cb = new CliCallbacks({ display, promptModule: throwing });
    const d = await cb.promptApproval({
      toolName: 'x',
      category: 'execute',
      args: {},
    });
    expect(d).toBe('deny');
  });
});

describe('CliCallbacks.riskAssess', () => {
  it('delegates to auxiliary client and parses tier', async () => {
    const { display } = makeDisplay();
    const aux: any = {
      call: vi.fn(async () => ({
        content: 'safe',
        usage: { inputTokens: 10, outputTokens: 1 },
      })),
    };
    const cb = new CliCallbacks({ display, auxiliaryClient: aux });
    const r = await cb.riskAssess({
      toolName: 'read_file',
      category: 'read',
      args: { path: '/tmp/x' },
    });
    expect(aux.call).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'risk_assess' }),
    );
    expect(r.tier).toBe('safe');
    expect(r.rationale).toContain('safe');
  });

  it('parses tier even when content has trailing punctuation', async () => {
    const { display } = makeDisplay();
    const aux: any = {
      call: async () => ({ content: 'dangerous.', usage: { inputTokens: 0, outputTokens: 0 } }),
    };
    const cb = new CliCallbacks({ display, auxiliaryClient: aux });
    const r = await cb.riskAssess({
      toolName: 't',
      category: 'execute',
      args: {},
    });
    expect(r.tier).toBe('dangerous');
  });

  it('defaults to caution when content is empty', async () => {
    const { display } = makeDisplay();
    const aux: any = {
      call: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0 } }),
    };
    const cb = new CliCallbacks({ display, auxiliaryClient: aux });
    const r = await cb.riskAssess({
      toolName: 't',
      category: 'execute',
      args: {},
    });
    expect(r.tier).toBe('caution');
  });

  it('defaults to caution when no auxiliary client wired', async () => {
    const { display } = makeDisplay();
    const cb = new CliCallbacks({ display });
    const r = await cb.riskAssess({
      toolName: 't',
      category: 'execute',
      args: {},
    });
    expect(r.tier).toBe('caution');
  });
});

describe('CliCallbacks.promptSkillProposal', () => {
  it('renders proposal and returns the user confirmation', async () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({
      display,
      promptModule: mockPrompts([{ kind: 'confirm', value: true }]),
    });
    const accepted = await cb.promptSkillProposal({
      proposedName: 'fetch-and-summarise',
      description: 'Fetch a URL, summarise it.',
      toolsUsed: ['web_fetch', 'read_file'],
      exampleSteps: [],
      trace: [],
      confidence: 0.78,
    });
    expect(accepted).toBe(true);
    const out = output();
    expect(out).toMatch(/fetch-and-summarise/);
    expect(out).toMatch(/web_fetch, read_file/);
    expect(out).toMatch(/0\.78/);
  });
});

describe('CliCallbacks.onPlannerGuardDecision', () => {
  it('compact mode emits nothing', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'compact' });
    cb.onPlannerGuardDecision({
      selectedTools: ['a', 'b'],
      excludedTools: ['c'],
      reason: 'rule_match',
    });
    expect(output()).toBe('');
  });

  it('verbose mode prints details', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'verbose' });
    cb.onPlannerGuardDecision({
      selectedTools: ['a'],
      excludedTools: ['b', 'c'],
      reason: 'llm_classification',
      confidence: 0.9,
    });
    const out = output();
    expect(out).toMatch(/planner.*llm_classification/);
    expect(out).toMatch(/conf 0\.90/);
  });

  it('skips when reason is no_filter regardless of mode', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'verbose' });
    cb.onPlannerGuardDecision({
      selectedTools: ['a'],
      excludedTools: [],
      reason: 'no_filter',
    });
    expect(output()).toBe('');
  });

  // v4.1.4 Phase 3b' Q-Planner — planner decisions are now
  // verbose-only. The prior `normal` mode emitted
  // `[planner] kept N tools (reason)` mid-execution which collided
  // with the activity-indicator line. Sentinel asserts the default
  // verbose level (`normal`) stays silent now.
  it('normal mode is SILENT (Phase 3b\' Q-Planner)', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'normal' });
    cb.onPlannerGuardDecision({
      selectedTools: ['a', 'b'],
      excludedTools: ['c', 'd', 'e'],
      reason: 'rule_match',
    });
    expect(output()).toBe('');
  });

  it('default mode (no verboseMode given) is SILENT for planner', () => {
    const { display, output } = makeDisplay();
    // CliCallbacks defaults verboseMode to 'normal' when not supplied.
    const cb = new CliCallbacks({ display });
    cb.onPlannerGuardDecision({
      selectedTools: ['a'],
      excludedTools: ['b'],
      reason: 'llm_classification',
      confidence: 0.82,
    });
    expect(output()).toBe('');
  });
});

describe('CliCallbacks.onCompression', () => {
  // v4.8.0 Slice 5 — successful auto-compress is now gated behind
  // AIDEN_VERBOSE=1 (refused / failed variants remain visible because
  // they explain user-actionable outcomes). The test asserts both
  // behaviours: silent by default, visible under verbose.
  it('successful compress is silent by default; visible under AIDEN_VERBOSE=1', () => {
    const orig = process.env.AIDEN_VERBOSE;
    try {
      delete process.env.AIDEN_VERBOSE;
      const d1 = makeDisplay();
      new CliCallbacks({ display: d1.display, verboseMode: 'compact' }).onCompression({
        compressedMessages: [], removedMessageCount: 5,
        summaryTokens: 200, preservedRecentCount: 6,
      });
      expect(d1.output()).not.toMatch(/removed 5/);

      process.env.AIDEN_VERBOSE = '1';
      const d2 = makeDisplay();
      new CliCallbacks({ display: d2.display, verboseMode: 'compact' }).onCompression({
        compressedMessages: [], removedMessageCount: 5,
        summaryTokens: 200, preservedRecentCount: 6,
      });
      expect(d2.output()).toMatch(/removed 5/);
    } finally {
      if (orig === undefined) delete process.env.AIDEN_VERBOSE;
      else process.env.AIDEN_VERBOSE = orig;
    }
  });

  it('reports refusal cleanly', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onCompression({
      compressedMessages: [],
      removedMessageCount: 0,
      summaryTokens: 0,
      preservedRecentCount: 0,
      refused: true,
    });
    expect(output()).toMatch(/refused/);
  });
});

describe('CliCallbacks.onBudgetWarning', () => {
  // v4.8.0 Slice 5 — caution-level per-turn dim line is verbose-only;
  // the actionable warning-level fires unchanged regardless of env.
  it('caution is silent by default; emits dim line under AIDEN_VERBOSE=1', () => {
    const orig = process.env.AIDEN_VERBOSE;
    try {
      delete process.env.AIDEN_VERBOSE;
      const d1 = makeDisplay();
      new CliCallbacks({ display: d1.display }).onBudgetWarning('caution', 70, 90);
      expect(d1.output()).not.toMatch(/budget.*70\/90/);

      process.env.AIDEN_VERBOSE = '1';
      const d2 = makeDisplay();
      new CliCallbacks({ display: d2.display }).onBudgetWarning('caution', 70, 90);
      expect(d2.output()).toMatch(/budget.*70\/90/);
    } finally {
      if (orig === undefined) delete process.env.AIDEN_VERBOSE;
      else process.env.AIDEN_VERBOSE = orig;
    }
  });

  it('warning emits a visible warn', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onBudgetWarning('warning', 85, 90);
    expect(output()).toMatch(/Budget: Turn 85\/90/);
    expect(output()).toMatch(/!/);
  });
});

describe('CliCallbacks.setVerboseMode', () => {
  it('switches verbose mode at runtime', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'compact' });
    cb.onPlannerGuardDecision({
      selectedTools: ['a'],
      excludedTools: ['b'],
      reason: 'rule_match',
    });
    expect(output()).toBe('');
    cb.setVerboseMode('verbose');
    cb.onPlannerGuardDecision({
      selectedTools: ['a'],
      excludedTools: ['b'],
      reason: 'rule_match',
    });
    expect(output()).toMatch(/planner/);
  });
});

describe('CliCallbacks Phase 23.5 onToolCall', () => {
  // v4.1.3-repl-polish: row format changed —
  //   - Failure / blocked / degraded rows render via the new trail
  //     format: `┊ {icon} {verb:12} {detail}  {outcome}`. Brackets
  //     [ok …] / [fail …] / [blocked] are gone; the outcome is a
  //     plain suffix colored by kind.
  //
  // v4.1.5 Issue N: clean-success rows are now PERSISTENT (was: silent).
  // The completed row replaces the running row and survives past the
  // turn for scrollback recall.
  it('non-TTY success emits a persistent completed row (v4.1.5 Issue N)', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onToolCall(
      { id: 'c1', name: 'web_search', arguments: { query: 'foo' } },
      'before',
    );
    cb.onToolCall(
      { id: 'c1', name: 'web_search', arguments: { query: 'foo' } },
      'after',
      { id: 'c1', name: 'web_search', result: { hits: [] } },
    );
    // v4.1.5 Issue N: clean-success now writes a completed row so the
    // log scrollback captures the action timeline. The exact ms suffix
    // is non-deterministic in tests (depends on fake-clock advance);
    // assert the row chrome + verb appear.
    const out = output();
    expect(out).toContain('┊');
    expect(out).toContain('fetching');
  });

  it('uses "blocked" suffix when result.error mentions URL provenance gate', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onToolCall(
      { id: 'c2', name: 'open_url', arguments: { url: 'https://x' } },
      'before',
    );
    cb.onToolCall(
      { id: 'c2', name: 'open_url', arguments: { url: 'https://x' } },
      'after',
      {
        id: 'c2',
        name: 'open_url',
        result: null,
        error:
          'Blocked: open_url URL https://www.youtube.com/watch?v=abc was ' +
          'not returned by any youtube_search call this turn (URL ' +
          'provenance gate).',
      },
    );
    const text = output();
    expect(text).toMatch(/┊/);
    expect(text).toMatch(/blocked/);
    // No legacy bracket form.
    expect(text).not.toMatch(/\[blocked\]/);
  });

  it('uses "fail Nms" suffix for non-blocked tool errors', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onToolCall(
      { id: 'c3', name: 'shell_exec', arguments: { command: 'foo' } },
      'before',
    );
    cb.onToolCall(
      { id: 'c3', name: 'shell_exec', arguments: { command: 'foo' } },
      'after',
      {
        id: 'c3',
        name: 'shell_exec',
        result: null,
        error: 'command not found',
      },
    );
    const text = output();
    expect(text).toMatch(/┊/);
    expect(text).toMatch(/fail \d+ms/);
    expect(text).not.toMatch(/\[fail/);
  });

  it('uses "partial Nms — reason" suffix when result.degraded === true', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onToolCall(
      { id: 'c4', name: 'recall_session', arguments: { query: 'x' } },
      'before',
    );
    cb.onToolCall(
      { id: 'c4', name: 'recall_session', arguments: { query: 'x' } },
      'after',
      {
        id: 'c4',
        name: 'recall_session',
        result: { matches: [] },
        degraded: true,
        degradedReason: '1 matched session has partial distillation data',
      },
    );
    const text = output();
    expect(text).toMatch(/partial \d+ms/);
    expect(text).toContain('partial distillation data');
  });

  it('renders capability card after fail row when result.capabilityCard is present (v4.1.3-essentials)', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onToolCall(
      { id: 'c5', name: 'media_transport', arguments: { action: 'pause' } },
      'before',
    );
    cb.onToolCall(
      { id: 'c5', name: 'media_transport', arguments: { action: 'pause' } },
      'after',
      {
        id: 'c5',
        name: 'media_transport',
        result: null,
        error: "Tool 'media_transport' is Windows-only.",
        requires: ['Windows'],
        capabilityCard: {
          title: 'media_transport requires Windows',
          canStill: ['Use shell_exec with playerctl'],
          cannotReliably: ['Native GSMTC control'],
          fix: 'Run Aiden on Windows.',
        },
      },
    );
    const text = output();
    // Fail row is still emitted (timeline anchor).
    expect(text).toMatch(/fail \d+ms/);
    // Card body shows.
    expect(text).toContain('media_transport requires Windows');
    expect(text).toContain('Can still:');
    expect(text).toContain('playerctl');
    expect(text).toContain('Cannot reliably:');
    expect(text).toContain('GSMTC');
    expect(text).toContain('Fix:');
    expect(text).toContain('Run Aiden on Windows');
  });

  it('does NOT render a capability card when result.error is present but capabilityCard is not', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onToolCall(
      { id: 'c6', name: 'shell_exec', arguments: { command: 'foo' } },
      'before',
    );
    cb.onToolCall(
      { id: 'c6', name: 'shell_exec', arguments: { command: 'foo' } },
      'after',
      {
        id: 'c6',
        name: 'shell_exec',
        result: null,
        error: 'command not found',
        // No capabilityCard — bare error.
      },
    );
    const text = output();
    expect(text).toMatch(/fail \d+ms/);
    // The card sections must NOT leak into the output.
    expect(text).not.toContain('Can still:');
    expect(text).not.toContain('Cannot reliably:');
  });

  it('fires beforeFirstToolHook exactly once per turn', () => {
    const { display } = makeDisplay();
    const cb = new CliCallbacks({ display });
    let calls = 0;
    cb.setBeforeFirstToolHook(() => {
      calls += 1;
    });
    cb.onToolCall(
      { id: 'a', name: 't', arguments: {} },
      'before',
    );
    cb.onToolCall(
      { id: 'a', name: 't', arguments: {} },
      'after',
      { id: 'a', name: 't', result: 'ok' },
    );
    cb.onToolCall(
      { id: 'b', name: 't', arguments: {} },
      'before',
    );
    cb.onToolCall(
      { id: 'b', name: 't', arguments: {} },
      'after',
      { id: 'b', name: 't', result: 'ok' },
    );
    expect(calls).toBe(1);
    // Re-arm for the next turn — fires again on the next first call.
    cb.setBeforeFirstToolHook(() => {
      calls += 1;
    });
    cb.onToolCall(
      { id: 'c', name: 't', arguments: {} },
      'before',
    );
    cb.onToolCall(
      { id: 'c', name: 't', arguments: {} },
      'after',
      { id: 'c', name: 't', result: 'ok' },
    );
    expect(calls).toBe(2);
  });
});
