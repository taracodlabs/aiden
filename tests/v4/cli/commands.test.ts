import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import {
  allCommands,
  help,
  tools,
  model,
  personality,
  save,
  title,
  compress,
  usage,
  undo,
  retry,
  yolo,
  skin,
  skills,
  reloadMcp,
  reasoning,
  verbose,
  clear,
  quit,
} from '../../../cli/v4/commands';
import { ApprovalEngine } from '../../../moat/approvalEngine';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeCtx(over: Record<string, unknown> = {}) {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
  });
  const reg = new CommandRegistry();
  for (const c of allCommands) reg.register(c);
  return {
    captured: chunks,
    output: () => stripAnsi(chunks.join('')),
    ctx: {
      args: [] as string[],
      rawArgs: '',
      display,
      registry: reg,
      ...over,
    },
  };
}

describe('barrel exports', () => {
  it('allCommands has 46 entries with unique names', () => {
    // Phase 16b.3 added /identity (17 → 18).
    // Phase 16b.4 added /debug-prompt (18 → 19).
    // Phase 16c added /streaming (19 → 20).
    // Phase 17 Task 3 added /plugins (20 → 21).
    // Phase 18 Task 5 added /auth (21 → 22).
    // Phase 20 Task 2 added /license (22 → 23).
    // Phase 20.1 added /doctor slash command (23 → 24).
    // Phase 24.1b added /cron slash command (24 → 25).
    // Phase 30.2.1 added /setup slash command (25 → 26).
    // Phase v4.1-1.1 added /channel slash command (26 → 27).
    // Phase v4.1-voice-cli added /voice (27 → 28).
    // Phase v4.1-tier3.1 added /status + /show (28 → 30).
    // Phase v4.1-tier3-essentials added /history (30 → 31).
    // Phase v4.1.2 alive-core added /reload-soul (31 → 32).
    // Phase v4.1.2-update added /update (32 → 33).
    // v4.5 Phase 8a added /sandbox /tce /browser-depth /daemon (33 → 37).
    // v4.5 Phase 8b added /suggestions (37 → 38).
    // v4.6 Phase 2M added /planner-guard (38 → 39).
    // v4.6 Phase 3A added /spawn-pause (39 → 40).
    // v4.6 Phase 3b added /recovery (40 → 41).
    // v4.6 ONB1 slice 10 added /walkthrough (41 → 42).
    // v4.9.0 Slice 1a added /theme (42 → 43).
    // v4.9.1 amendment added /memory + /hooks (43 → 45).
    // v4.9.3 Slice 1b added /greeter (45 → 46).
    // v4.11 Slice B added /undo (46 → 47).
    // v4.11 Slice C added /retry (47 → 48).
    // v4.12 Slice 1a added /mcp (48 → 49).
    // v4.12 B3.1 added /browser (49 → 50).
    // v4.12 BE.1 added /budget (50 → 51).
    // v4.12 /commands slice added /home (51 → 52). (/activity is inline-
    // registered in aidenCLI, like /tasks — not in the barrel, not counted.)
    // v4.12.1 Pillar 2 added /autonomy (52 → 53).
    // v4.12.1 Pillar 4 Slice 2a added /busy + /queue (53 → 55).
    // v4.12.1 Pillar 4 Slice 2b added /redirect (55 → 56).
    expect(allCommands.length).toBe(56);
    const names = new Set(allCommands.map((c) => c.name));
    expect(names.size).toBe(56);
  });

  it('every command exposes name, description, category', () => {
    for (const cmd of allCommands) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(['system', 'skill']).toContain(cmd.category);
    }
  });
});

describe('/help', () => {
  it('lists registered system commands grouped by Phase 22 sub-section', async () => {
    const { ctx, output } = makeCtx();
    await help.handler(ctx as any);
    const out = output();
    // Slice 4 (commit 1545e590): /help adopts framedPanel chrome.
    // Sections render as orange-bar panel titles, not `── Section ──` rules.
    // v4.8.0 Slice 11c — panel bar swapped ▎ → │ (universal-font glyph).
    expect(out).toMatch(/│\s*Help\b/);
    expect(out).toMatch(/│\s*System\b/);
    expect(out).toMatch(/\/help/);
    expect(out).toMatch(/\/quit/);
  });
});

describe('/tools', () => {
  it('warns when toolRegistry missing', async () => {
    const { ctx, output } = makeCtx();
    await tools.handler(ctx as any);
    expect(output()).toMatch(/registry not wired/i);
  });

  it('lists tools grouped by toolset', async () => {
    const fakeReg = {
      list: () => ['read_file', 'shell_exec', 'web_search'],
      get: (n: string) => ({
        toolset: n.startsWith('shell') ? 'terminal' : n.startsWith('web') ? 'web' : 'files',
      }),
    };
    const { ctx, output } = makeCtx({ toolRegistry: fakeReg });
    await tools.handler(ctx as any);
    const o = output();
    expect(o).toMatch(/files \(1\)/);
    expect(o).toMatch(/terminal \(1\)/);
    expect(o).toMatch(/web \(1\)/);
  });
});

describe('/model', () => {
  it('parses spec and updates session', async () => {
    const setProvider = vi.fn(async () => {});
    const fakeResolver = { listProviders: () => [], listModels: () => [] };
    const session = {
      history: [],
      setHistory: () => {},
      clearHistory: () => {},
      getCurrentProvider: () => 'old',
      getCurrentModel: () => 'old-m',
      setProvider,
    };
    const { ctx, output } = makeCtx({
      resolver: fakeResolver,
      session,
      args: ['anthropic:claude-opus-4-7'],
      rawArgs: 'anthropic:claude-opus-4-7',
    });
    await model.handler(ctx as any);
    expect(setProvider).toHaveBeenCalledWith('anthropic', 'claude-opus-4-7');
    expect(output()).toMatch(/Now using anthropic/);
  });

  it('errors gracefully on invalid spec', async () => {
    const fakeResolver = { listProviders: () => [], listModels: () => [] };
    const { ctx, output } = makeCtx({
      resolver: fakeResolver,
      args: [':::'],
      rawArgs: ':::',
    });
    await model.handler(ctx as any);
    expect(output()).toMatch(/error|not found/i);
  });
});

describe('/personality', () => {
  function fakeManager(opts: {
    list?: any[];
    current?: string;
    setOk?: boolean;
    setReason?: string;
  } = {}) {
    let current = opts.current ?? 'default';
    return {
      list: async () =>
        opts.list ?? [
          { name: 'default', description: 'No overlay', source: 'bundled' },
          { name: 'concise', description: 'Short responses', source: 'bundled' },
        ],
      getCurrent: () => current,
      setCurrent: async (name: string) => {
        if (opts.setOk === false) {
          return { ok: false, reason: opts.setReason ?? `Unknown personality '${name}'` };
        }
        current = name;
        return { ok: true };
      },
    };
  }

  it('lists available personalities when called bare', async () => {
    const { ctx, output } = makeCtx({ personalityManager: fakeManager() });
    await personality.handler(ctx as any);
    const out = output();
    expect(out).toMatch(/Active personality: default/);
    expect(out).toMatch(/concise/);
    expect(out).toMatch(/Short responses/);
  });

  it('marks the active personality with an asterisk', async () => {
    const { ctx, output } = makeCtx({
      personalityManager: fakeManager({ current: 'concise' }),
    });
    await personality.handler(ctx as any);
    expect(output()).toMatch(/\*\s+concise/);
  });

  it('switches personality when given a known name', async () => {
    const mgr = fakeManager();
    const { ctx, output } = makeCtx({
      personalityManager: mgr,
      rawArgs: 'concise',
    });
    await personality.handler(ctx as any);
    expect(mgr.getCurrent()).toBe('concise');
    expect(output()).toMatch(/Personality: concise/);
  });

  it('prints an actionable error when target is unknown', async () => {
    const { ctx, output } = makeCtx({
      personalityManager: fakeManager({ setOk: false, setReason: "Unknown personality 'ghost'" }),
      rawArgs: 'ghost',
    });
    await personality.handler(ctx as any);
    expect(output()).toMatch(/ghost/);
    expect(output()).toMatch(/Run \/personality/);
  });

  it('warns when no PersonalityManager is wired', async () => {
    const { ctx, output } = makeCtx();
    await personality.handler(ctx as any);
    expect(output()).toMatch(/not wired/i);
  });
});

describe('/save and /title', () => {
  it('save uses ISO timestamp when title omitted', async () => {
    const setSessionTitle = vi.fn(() => true);
    const { ctx, output } = makeCtx({
      sessionManager: { setSessionTitle },
      session: {
        history: [],
        setHistory: () => {},
        clearHistory: () => {},
        getCurrentProvider: () => 'p',
        getCurrentModel: () => 'm',
        setProvider: async () => {},
        getSessionId: () => 'sess-1',
      },
    });
    await save.handler(ctx as any);
    expect(setSessionTitle).toHaveBeenCalled();
    const titleArg = setSessionTitle.mock.calls[0][1] as string;
    expect(titleArg).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(output()).toMatch(/Saved/);
  });

  it('title rejects empty input', async () => {
    const { ctx, output } = makeCtx({
      sessionManager: { setSessionTitle: () => true },
      session: {
        history: [],
        setHistory: () => {},
        clearHistory: () => {},
        getCurrentProvider: () => 'p',
        getCurrentModel: () => 'm',
        setProvider: async () => {},
        getSessionId: () => 'sess-1',
      },
    });
    await title.handler(ctx as any);
    expect(output()).toMatch(/cannot be empty/i);
  });

  it('title sets the session title', async () => {
    const setSessionTitle = vi.fn(() => true);
    const { ctx, output } = makeCtx({
      sessionManager: { setSessionTitle },
      session: {
        history: [],
        setHistory: () => {},
        clearHistory: () => {},
        getCurrentProvider: () => 'p',
        getCurrentModel: () => 'm',
        setProvider: async () => {},
        getSessionId: () => 'sess-1',
      },
      rawArgs: 'My Cool Session',
    });
    await title.handler(ctx as any);
    expect(setSessionTitle).toHaveBeenCalledWith('sess-1', 'My Cool Session');
    expect(output()).toMatch(/Renamed/);
  });
});

describe('/compress', () => {
  it('forceCompresses and replaces history', async () => {
    const compressed = [{ role: 'system', content: 'summary' }];
    const compressor = {
      forceCompress: vi.fn(async () => ({
        compressedMessages: compressed,
        removedMessageCount: 5,
        summaryTokens: 200,
        preservedRecentCount: 6,
      })),
    };
    const setHistory = vi.fn();
    const session = {
      history: Array(10).fill({ role: 'user', content: 'x' }),
      setHistory,
      clearHistory: () => {},
      getCurrentProvider: () => 'anthropic',
      getCurrentModel: () => 'claude-opus-4-7',
      setProvider: async () => {},
    };
    const { ctx, output } = makeCtx({ compressor, session });
    await compress.handler(ctx as any);
    expect(compressor.forceCompress).toHaveBeenCalled();
    expect(setHistory).toHaveBeenCalledWith(compressed);
    expect(output()).toMatch(/Compressed/);
  });
});

describe('/undo', () => {
  const baseSession = () => ({
    history: [],
    setHistory: () => {},
    clearHistory: () => {},
    getCurrentProvider: () => 'anthropic',
    getCurrentModel: () => 'claude-opus-4-7',
    setProvider: async () => {},
  });

  it('reverts and prints the in-memory caveat when a turn exists', async () => {
    const undoLastTurn = vi.fn(() => true);
    const { ctx, output } = makeCtx({ session: { ...baseSession(), undoLastTurn } });
    await undo.handler(ctx as any);
    expect(undoLastTurn).toHaveBeenCalled();
    expect(output()).toMatch(/Reverted the last turn/);
    expect(output()).toMatch(/undoes one turn only/);
    expect(output()).toMatch(/Memory writes.*not reverted/);
  });

  it('prints a clean message and does not crash when there is nothing to undo', async () => {
    const undoLastTurn = vi.fn(() => false);
    const { ctx, output } = makeCtx({ session: { ...baseSession(), undoLastTurn } });
    await undo.handler(ctx as any);
    expect(undoLastTurn).toHaveBeenCalled();
    expect(output()).toMatch(/Nothing to undo/);
  });

  it('warns when the session does not support undo', async () => {
    const { ctx, output } = makeCtx({ session: baseSession() });
    await undo.handler(ctx as any);
    expect(output()).toMatch(/not available/i);
  });
});

describe('/retry', () => {
  const baseSession = () => ({
    history: [],
    setHistory: () => {},
    clearHistory: () => {},
    getCurrentProvider: () => 'anthropic',
    getCurrentModel: () => 'claude-opus-4-7',
    setProvider: async () => {},
  });

  it('returns a rerun signal with the recovered prompt when a turn exists', async () => {
    const retryLastTurn = vi.fn(() => 'say banana');
    const { ctx, output } = makeCtx({ session: { ...baseSession(), retryLastTurn } });
    const result = await retry.handler(ctx as any);
    expect(retryLastTurn).toHaveBeenCalled();
    expect(result).toEqual({ rerun: 'say banana' });
    expect(output()).toMatch(/Re-running your last prompt/);
  });

  it('prints a clean message and no rerun when there is nothing to retry', async () => {
    const retryLastTurn = vi.fn(() => null);
    const { ctx, output } = makeCtx({ session: { ...baseSession(), retryLastTurn } });
    const result = await retry.handler(ctx as any);
    expect(retryLastTurn).toHaveBeenCalled();
    expect((result as any)?.rerun).toBeUndefined();
    expect(output()).toMatch(/Nothing to retry/);
  });

  it('warns when the session does not support retry', async () => {
    const { ctx, output } = makeCtx({ session: baseSession() });
    const result = await retry.handler(ctx as any);
    expect((result as any)?.rerun).toBeUndefined();
    expect(output()).toMatch(/not available/i);
  });
});

describe('/usage', () => {
  it('prints token totals and cost when pricing is known', async () => {
    const session = {
      history: [],
      setHistory: () => {},
      clearHistory: () => {},
      getCurrentProvider: () => 'anthropic',
      getCurrentModel: () => 'claude-opus-4-7',
      setProvider: async () => {},
      getTotalUsage: () => ({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    };
    const { ctx, output } = makeCtx({ session });
    await usage.handler(ctx as any);
    const o = output();
    expect(o).toMatch(/anthropic:claude-opus-4-7/);
    expect(o).toMatch(/\$90\.0000/); // 15 + 75
  });

  it('prints "(pricing unknown)" when model has no pricing', async () => {
    const session = {
      history: [],
      setHistory: () => {},
      clearHistory: () => {},
      getCurrentProvider: () => 'ollama',
      getCurrentModel: () => 'llama3.2',
      setProvider: async () => {},
      getTotalUsage: () => ({ inputTokens: 100, outputTokens: 50 }),
    };
    const { ctx, output } = makeCtx({ session });
    await usage.handler(ctx as any);
    expect(output()).toMatch(/pricing unknown/i);
    expect(output()).not.toMatch(/Estimated cost/);
  });
});

describe('/yolo', () => {
  it('toggles approval engine to off and back', async () => {
    const engine = new ApprovalEngine('manual');
    const { ctx, output } = makeCtx({ approvalEngine: engine });
    await yolo.handler(ctx as any);
    expect(engine.getMode()).toBe('off');
    expect(output()).toMatch(/YOLO enabled/);
    await yolo.handler(ctx as any);
    expect(engine.getMode()).toBe('manual');
  });
});

describe('/skin', () => {
  it('lists skins when called bare', async () => {
    const skinEngine = new SkinEngine({ forceMono: true });
    const { ctx, output } = makeCtx({ skin: skinEngine });
    await skin.handler(ctx as any);
    expect(output()).toMatch(/default/);
    expect(output()).toMatch(/monochrome/);
  });

  it('switches to a known skin', async () => {
    const skinEngine = new SkinEngine({ forceMono: true });
    const { ctx, output } = makeCtx({
      skin: skinEngine,
      rawArgs: 'monochrome',
    });
    await skin.handler(ctx as any);
    expect(skinEngine.getActive().name).toBe('monochrome');
    expect(output()).toMatch(/Skin: monochrome/);
  });

  it('reload re-reads the active skin from disk', async () => {
    const skinEngine = new SkinEngine({ forceMono: true });
    const reloadSpy = vi.spyOn(skinEngine, 'reload');
    const { ctx, output } = makeCtx({ skin: skinEngine, rawArgs: 'reload' });
    await skin.handler(ctx as any);
    expect(reloadSpy).toHaveBeenCalled();
    expect(output()).toMatch(/Skin reloaded/);
  });

  it('reports an actionable error when reload fails', async () => {
    const skinEngine = new SkinEngine({ forceMono: true });
    vi.spyOn(skinEngine, 'reload').mockRejectedValueOnce(new Error('bad yaml'));
    const { ctx, output } = makeCtx({ skin: skinEngine, rawArgs: 'reload' });
    await skin.handler(ctx as any);
    expect(output()).toMatch(/reload failed/i);
    expect(output()).toMatch(/yaml/);
  });

  it('rejects an unknown skin name with an actionable error', async () => {
    const skinEngine = new SkinEngine({ forceMono: true });
    const before = skinEngine.getActive().name;
    const { ctx, output } = makeCtx({ skin: skinEngine, rawArgs: 'totally-fake' });
    await skin.handler(ctx as any);
    expect(skinEngine.getActive().name).toBe(before);
    expect(output()).toMatch(/Unknown skin/);
  });
});

describe('/skills', () => {
  it('lists skills via SkillLoader', async () => {
    const skillLoader = {
      list: async () => [
        { name: 'alpha', description: 'first', version: '1.0', filePath: 'x' },
      ],
    };
    const { ctx, output } = makeCtx({ skillLoader, args: ['list'], rawArgs: 'list' });
    await skills.handler(ctx as any);
    expect(output()).toMatch(/alpha/);
  });
});

describe('/reload-mcp', () => {
  it('calls reload and prints server count', async () => {
    const reload = vi.fn(async () => {});
    const mcpClient = { reload, listServers: () => [{}, {}, {}] };
    const { ctx, output } = makeCtx({ mcpClient });
    await reloadMcp.handler(ctx as any);
    expect(reload).toHaveBeenCalled();
    expect(output()).toMatch(/3 server/);
  });
});

describe('/reasoning', () => {
  function fakeCfg(initial?: string) {
    let stored = initial;
    let saved = 0;
    return {
      get: () => undefined,
      getValue: (_key: string, fallback?: any) => stored ?? fallback,
      set: (_key: string, v: string) => {
        stored = v;
      },
      save: async () => {
        saved += 1;
      },
      // Test-only helpers (not on real ConfigManager).
      _read: () => stored,
      _saves: () => saved,
    };
  }

  it('shows the current effort when called bare', async () => {
    const cfg = fakeCfg('high');
    const { ctx, output } = makeCtx({ config: cfg });
    await reasoning.handler(ctx as any);
    expect(output()).toMatch(/Reasoning effort: high/);
  });

  it('defaults to medium when no value is stored', async () => {
    const cfg = fakeCfg();
    const { ctx, output } = makeCtx({ config: cfg });
    await reasoning.handler(ctx as any);
    expect(output()).toMatch(/Reasoning effort: medium/);
  });

  it('accepts low/medium/high and persists to config', async () => {
    for (const value of ['low', 'medium', 'high'] as const) {
      const cfg = fakeCfg();
      const { ctx, output } = makeCtx({ config: cfg, rawArgs: value });
      await reasoning.handler(ctx as any);
      expect(cfg._read()).toBe(value);
      expect(cfg._saves()).toBe(1);
      expect(output()).toMatch(new RegExp(`set to ${value}`));
    }
  });

  it("normalizes 'med' to 'medium'", async () => {
    const cfg = fakeCfg();
    const { ctx } = makeCtx({ config: cfg, rawArgs: 'med' });
    await reasoning.handler(ctx as any);
    expect(cfg._read()).toBe('medium');
  });

  it('rejects invalid values with an actionable error', async () => {
    const cfg = fakeCfg();
    const { ctx, output } = makeCtx({ config: cfg, rawArgs: 'extreme' });
    await reasoning.handler(ctx as any);
    expect(cfg._read()).toBeUndefined();
    expect(output()).toMatch(/Invalid effort/);
    expect(output()).toMatch(/low\|medium\|high/);
  });

  it('warns when the config manager is not wired', async () => {
    const { ctx, output } = makeCtx();
    await reasoning.handler(ctx as any);
    expect(output()).toMatch(/not wired/i);
  });
});

describe('/verbose', () => {
  it('cycles through compact -> normal -> verbose -> compact', async () => {
    let stored = 'compact';
    const cfg = {
      get: () => undefined,
      getValue: () => stored,
      set: (_k: string, v: string) => {
        stored = v;
      },
      save: async () => {},
    };
    const { ctx } = makeCtx({ config: cfg });
    await verbose.handler(ctx as any);
    expect(stored).toBe('normal');
    await verbose.handler(ctx as any);
    expect(stored).toBe('verbose');
    await verbose.handler(ctx as any);
    expect(stored).toBe('compact');
  });

  it('rejects unknown mode', async () => {
    const cfg = {
      get: () => undefined,
      getValue: () => 'normal',
      set: () => {},
      save: async () => {},
    };
    const { ctx, output } = makeCtx({ config: cfg, rawArgs: 'loud' });
    await verbose.handler(ctx as any);
    expect(output()).toMatch(/unknown verbosity/i);
  });
});

describe('/clear and /quit', () => {
  it('clear clears the session and signals clearHistory', async () => {
    const clearHistory = vi.fn();
    const { ctx } = makeCtx({
      session: {
        history: [{ role: 'user', content: 'x' }],
        setHistory: () => {},
        clearHistory,
        getCurrentProvider: () => 'p',
        getCurrentModel: () => 'm',
        setProvider: async () => {},
      },
    });
    const res = await clear.handler(ctx as any);
    expect(clearHistory).toHaveBeenCalled();
    expect(res).toEqual({ clearHistory: true });
  });

  it('quit signals exit', async () => {
    const { ctx } = makeCtx();
    const res = await quit.handler(ctx as any);
    expect(res).toEqual({ exit: true });
  });

  it('quit aliases include q and exit', () => {
    expect(quit.aliases).toEqual(['q', 'exit']);
  });
});
