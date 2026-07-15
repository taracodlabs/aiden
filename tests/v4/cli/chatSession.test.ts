import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import {
  ChatSession,
  renderProgressBar,
  formatTokens,
  formatDuration,
  type ChatPromptApi,
  type ChatSessionOptions,
} from '../../../cli/v4/chatSession';
import { CommandRegistry, type SlashCommand } from '../../../cli/v4/commandRegistry';
import { undo } from '../../../cli/v4/commands/undo';
import { retry } from '../../../cli/v4/commands/retry';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { Message } from '../../../providers/v4/types';
import { DuringTurnInput } from '../../../cli/v4/duringTurnInput';

function mkDisplay() {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const err = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  // Force non-TTY so spinner renders synchronously.
  (out as unknown as { isTTY: boolean }).isTTY = false;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
    stderr: err,
  });
  return { display, out: chunks };
}

function mkAgent(overrides: Partial<{
  finalContent: string;
  messages: Message[];
  inputTokens: number;
  outputTokens: number;
  shouldThrow: boolean;
}> = {}) {
  const calls: Message[][] = [];
  const setProviderCalls: unknown[] = [];
  const setActiveModelCalls: Array<{ providerId: string; modelId: string }> = [];
  const agent = {
    runConversation: vi.fn(async (history: Message[]) => {
      calls.push(history);
      if (overrides.shouldThrow) throw new Error('boom');
      const final = overrides.finalContent ?? 'ok';
      return {
        finalContent: final,
        messages: overrides.messages ?? [
          ...history,
          { role: 'assistant', content: final },
        ],
        turnCount: 1,
        toolCallCount: 0,
        fallbackActivated: false,
        finishReason: 'stop' as const,
        totalUsage: {
          inputTokens: overrides.inputTokens ?? 5,
          outputTokens: overrides.outputTokens ?? 3,
        },
        toolCallTrace: [],
        compressionEvents: 0,
        auxiliaryUsage: {},
      };
    }),
    setProvider: vi.fn((adapter: unknown) => {
      setProviderCalls.push(adapter);
    }),
    // Phase v4.1.2-bug2: chatSession.setProvider now also calls
    // agent.setActiveModel(...) so the prompt's Runtime slot stays in
    // lockstep with the routed provider. Mock records each call so
    // the wire-through is testable.
    setActiveModel: vi.fn((providerId: string, modelId: string) => {
      setActiveModelCalls.push({ providerId, modelId });
      return true;
    }),
  };
  return { agent, calls, setProviderCalls, setActiveModelCalls };
}

function mkSessionManager() {
  const startCalls: unknown[] = [];
  const recordCalls: { id: string; messages: Message[]; usage: unknown }[] = [];
  const mgr = {
    startSession: vi.fn((opts: { providerId: string; modelId: string }) => {
      startCalls.push(opts);
      return { id: 'sess-abc-123', title: null, ...opts } as never;
    }),
    recordTurn: vi.fn((id: string, messages: Message[], usage: unknown) => {
      recordCalls.push({ id, messages, usage });
    }),
    resumeLatest: vi.fn(),
    resumeById: vi.fn(),
    listSessions: vi.fn(() => []),
    setSessionTitle: vi.fn(),
    search: vi.fn(() => []),
  };
  return { mgr, startCalls, recordCalls };
}

function mkToolRegistry() {
  return {
    list: () => ['file_read', 'file_write', 'web_search'],
    get: (name: string) =>
      ({
        file_read: { schema: { name }, mutates: false, category: 'read', toolset: 'files' },
        file_write: { schema: { name }, mutates: true, category: 'write', toolset: 'files' },
        web_search: { schema: { name }, mutates: false, category: 'network', toolset: 'web' },
      } as Record<string, unknown>)[name] as never,
    getSchemas: () => [],
    register: vi.fn(),
    unregister: vi.fn(),
    byCategory: () => [],
    buildExecutor: () => async () => ({ id: '1', name: 'noop', result: null }),
  };
}

function mkSkillLoader(skills: { name: string; category?: string }[] = []) {
  return {
    list: vi.fn(async () => skills),
    load: vi.fn(),
    loadAll: vi.fn(async () => []),
    readSkillFile: vi.fn(),
  } as never;
}

interface ScriptedPromptOpts {
  inputs: string[];
  selectResult?: (input: string | undefined) => string | null;
}

function mkPromptApi(opts: ScriptedPromptOpts): ChatPromptApi {
  let i = 0;
  return {
    async readLine() {
      if (i >= opts.inputs.length) {
        // Simulate Ctrl+C — the REPL recognises this as a clean exit.
        throw new Error('User force closed');
      }
      return opts.inputs[i++];
    },
    async selectSlashCommand(source) {
      const list = await source(undefined);
      if (opts.selectResult) {
        const r = opts.selectResult(undefined);
        if (r === null) return null;
        return r;
      }
      return list[0]?.value ?? null;
    },
  };
}

function mkApprovalEngine() {
  let mode: 'manual' | 'smart' | 'off' = 'manual';
  return {
    setMode: vi.fn((m: 'manual' | 'smart' | 'off') => {
      mode = m;
    }),
    getMode: () => mode,
    checkApproval: vi.fn(async () => true),
    allowForSession: vi.fn(),
    allowAlways: vi.fn(),
    resetSession: vi.fn(),
  } as never;
}

function mkSkinEngine() {
  return new SkinEngine({ forceMono: true });
}

function buildOpts(over: Partial<ChatSessionOptions> = {}): ChatSessionOptions {
  const { display } = mkDisplay();
  const { agent } = mkAgent();
  const { mgr } = mkSessionManager();
  const registry = new CommandRegistry();
  return {
    agent: agent as never,
    display,
    commandRegistry: registry,
    callbacks: {} as never,
    sessionManager: mgr as never,
    approvalEngine: mkApprovalEngine(),
    skin: mkSkinEngine(),
    toolRegistry: mkToolRegistry() as never,
    skillLoader: mkSkillLoader(),
    resolver: {
      resolve: vi.fn(async () => ({ call: vi.fn() })),
      describe: vi.fn(),
      listProviders: vi.fn(() => []),
      listModels: vi.fn(() => []),
    } as never,
    config: {} as never,
    initialProviderId: 'groq',
    initialModelId: 'llama-3.3-70b-versatile',
    installSignalHandler: false,
    promptApi: mkPromptApi({ inputs: ['/quit'] }),
    ...over,
  };
}

describe('ChatSession.run', () => {
  it('hands a queued submission to the agent exactly once without downstream mutation', async () => {
    const { agent, calls } = mkAgent();
    const session = new ChatSession(buildOpts({
      agent: agent as never,
      promptApi: mkPromptApi({ inputs: ['/quit'] }),
    }));
    const submitted = '  const answer = 42;\n\n\treturn answer;  \n';
    (session as unknown as { duringTurnInput: DuringTurnInput }).duringTurnInput.enqueue(submitted);

    await session.run();

    expect(calls).toHaveLength(1);
    expect(calls[0].filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: submitted },
    ]);
    expect(session.listQueue()).toEqual([]);
  });

  it('boots a session and persists turn to SessionManager', async () => {
    const { display, out } = mkDisplay();
    const { agent, calls } = mkAgent({ finalContent: 'hello there' });
    const { mgr, startCalls, recordCalls } = mkSessionManager();
    const session = new ChatSession(
      buildOpts({
        display,
        agent: agent as never,
        sessionManager: mgr as never,
        promptApi: mkPromptApi({ inputs: ['hi', '/quit'] }),
      }),
    );
    await session.run();

    expect(startCalls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0].id).toBe('sess-abc-123');
    expect(out.join('')).toContain('hello there');
  });

  it.skip('renders the neofetch-style sectioned startup card /* TODO v4.1.1: tier3.1+ restructured boot card */ (Phase 26.2.4)', async () => {
    // Phase 26.2.4: boot card is now banner + tagline + status pills row
    // + Environment + Capabilities two-column block + scroll-shaped
    // credits footer + bottom prompt hint. No more box wrapper, no
    // provider name in the pills, no version/session lines, no
    // `ready ▸` line.
    const { display, out } = mkDisplay();
    const session = new ChatSession(
      buildOpts({
        display,
        skillLoader: mkSkillLoader([
          { name: 'trading-alert', category: 'finance' },
          { name: 'research', category: 'research' },
        ]),
      }),
    );
    await session.run();
    const text = out.join('');
    // Box wrapper still gone.
    expect(text).not.toContain('╭');
    expect(text).not.toContain('╰');
    // Banner ASCII still present.
    expect(text).toMatch(/█████╗/);
    // Tagline.
    expect(text).toContain('Autonomous AI Engine');
    // Status pills row — model name in pill, no provider name.
    expect(text).toContain('● core online');
    expect(text).toContain('● mode auto');
    expect(text).toContain('● model llama-3.3-70b-versatile');
    expect(text).toContain('● memory active');
    // Two-column block.
    expect(text).toContain('Environment');
    expect(text).toContain('Capabilities');
    // tools/skills counts now appear as `N loaded` rows in Environment.
    expect(text).toContain('3 loaded');
    expect(text).toContain('2 loaded');
    expect(text).toContain('local-first');
    expect(text).toContain('research · extract');
    // Credits scroll (≥75 cols mock terminal — full scroll).
    expect(text).toContain('Built solo');
    expect(text).toContain('github.com/taracodlabs/aiden');
    // Bottom prompt hint. v4.8.0 Slice 11 — leading ▲ dropped (the
    // inquirer prompt below the hint already paints the brand
    // triangle as its input prefix; the hint's own ▲ read as a
    // duplicate orphan one row above the active cursor).
    expect(text).toContain('Type your message');
    expect(text).not.toMatch(/▲\s+Type your message/);
    expect(text).toMatch(/\/help for commands/);
    expect(text).toContain('/skills');
  });

  it('renders the v3-style status footer after each turn (Phase 23.6)', async () => {
    const { display, out } = mkDisplay();
    const session = new ChatSession(
      buildOpts({
        display,
        promptApi: mkPromptApi({ inputs: ['hello', '/quit'] }),
      }),
    );
    await session.run();
    // Phase 23.6 + v4.9.0 pre-ship UI: status footer is
    // `provider · model │ ctx-bar │ elapsed` — leading ▲ dropped
    // (prompt arrow owns the marker; footer ▲ was a duplicate).
    const text = out.join('');
    expect(text).toMatch(/groq/);
    expect(text).toContain('llama-3.3-70b-versatile');
    expect(text).toMatch(/ │ /); // vertical-bar separator
    // Elapsed segment ends with a unit suffix.
    expect(text).toMatch(/\d+(?:ms|s|m)/);
  });

  it('intercepts slash commands before the agent', async () => {
    const handler = vi.fn(async () => ({}));
    const reg = new CommandRegistry();
    reg.register({
      name: 'tools',
      description: 'show tools',
      category: 'system',
      handler,
    });
    const { agent } = mkAgent();
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        commandRegistry: reg,
        promptApi: mkPromptApi({ inputs: ['/tools', '/quit'] }),
      }),
    );
    await session.run();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(agent.runConversation).not.toHaveBeenCalled();
  });

  it('clearHistory result drops conversation history', async () => {
    const reg = new CommandRegistry();
    reg.register({
      name: 'clear',
      description: 'clear',
      category: 'system',
      handler: async (ctx) => {
        ctx.session?.clearHistory();
        return { clearHistory: true };
      },
    });
    const session = new ChatSession(
      buildOpts({
        commandRegistry: reg,
        promptApi: mkPromptApi({ inputs: ['/clear', '/quit'] }),
      }),
    );
    session.history = [{ role: 'user', content: 'old' }];
    await session.run();
    expect(session.history).toEqual([]);
  });

  it('/undo reverts history and the next turn uses the reverted history (Slice B)', async () => {
    const reg = new CommandRegistry();
    reg.register(undo);
    const { agent, calls } = mkAgent();
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        commandRegistry: reg,
        // inputs run out after "say b" → force-close exits run()
        promptApi: mkPromptApi({ inputs: ['say a', '/undo', 'say b'] }),
      }),
    );
    await session.run();
    // Turn 1 baseHistory is just the first user message.
    expect(calls[0].map((m) => (m as { content: string }).content)).toEqual(['say a']);
    // The turn AFTER /undo must NOT carry "say a" — proves the revert took
    // effect AND the next turn builds on the reverted history.
    expect(calls[1].map((m) => (m as { content: string }).content)).toEqual(['say b']);
    // In-memory history reflects only the post-undo turn.
    expect(session.history.map((m) => (m as { content: string }).content)).toEqual(['say b', 'ok']);
  });

  it('/retry reverts the last turn and re-runs the same prompt fresh (Slice C)', async () => {
    const reg = new CommandRegistry();
    reg.register(retry);
    const { agent, calls } = mkAgent();
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        commandRegistry: reg,
        // inputs run out after "/retry" → force-close exits run()
        promptApi: mkPromptApi({ inputs: ['say a', '/retry'] }),
      }),
    );
    await session.run();
    // Two runConversation calls: the original turn + the /retry re-dispatch.
    expect(calls).toHaveLength(2);
    expect(calls[0].map((m) => (m as { content: string }).content)).toEqual(['say a']);
    // The rerun ran on the REVERTED history (just the re-sent prompt), not
    // appended after the prior turn — proves revert-then-rerun.
    expect(calls[1].map((m) => (m as { content: string }).content)).toEqual(['say a']);
    // Final history is a single fresh turn, not doubled up.
    expect(session.history.map((m) => (m as { content: string }).content)).toEqual(['say a', 'ok']);
  });

  it('/retry with no prior turn is a clean no-op (no rerun, no crash)', async () => {
    const reg = new CommandRegistry();
    reg.register(retry);
    const { agent, calls } = mkAgent();
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        commandRegistry: reg,
        promptApi: mkPromptApi({ inputs: ['/retry'] }),
      }),
    );
    await session.run();
    expect(calls).toHaveLength(0);
    expect(session.history).toEqual([]);
  });

  it('exit result terminates the loop', async () => {
    const reg = new CommandRegistry();
    reg.register({
      name: 'quit',
      description: 'quit',
      category: 'system',
      handler: async () => ({ exit: true }),
    });
    const { agent } = mkAgent();
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        commandRegistry: reg,
        // After /quit we'd never reach this — proves the loop broke.
        promptApi: mkPromptApi({ inputs: ['/quit', 'should-not-run'] }),
        maxIterations: 5,
      }),
    );
    await session.run();
    expect(agent.runConversation).not.toHaveBeenCalled();
  });

  it('multi-line via triple quote concatenates into one message', async () => {
    const { agent, calls } = mkAgent();
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        promptApi: mkPromptApi({
          inputs: ['"""line 1', 'line 2', 'line 3"""', '/quit'],
        }),
      }),
    );
    await session.run();
    expect(calls).toHaveLength(1);
    const lastUserMsg = calls[0][calls[0].length - 1];
    expect(lastUserMsg.content).toBe('line 1\nline 2\nline 3');
  });

  it('paste detection accepts a multi-newline chunk verbatim', async () => {
    const { agent, calls } = mkAgent();
    const pasted = 'line one\nline two\nline three';
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        promptApi: mkPromptApi({ inputs: [pasted, '/quit'] }),
      }),
    );
    await session.run();
    expect(calls).toHaveLength(1);
    expect((calls[0][calls[0].length - 1] as Message).content).toBe(pasted);
  });

  it('setProvider hot-swaps the agent provider', async () => {
    const { agent, setProviderCalls, setActiveModelCalls } = mkAgent();
    const resolver = {
      resolve: vi.fn(async () => ({ call: vi.fn(), tag: 'new-adapter' })),
      describe: vi.fn(),
      listProviders: vi.fn(() => []),
      listModels: vi.fn(() => []),
    };
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        resolver: resolver as never,
        promptApi: mkPromptApi({ inputs: ['/quit'] }),
      }),
    );
    await session.setProvider('anthropic', 'claude-opus-4-7');
    expect(setProviderCalls).toHaveLength(1);
    expect(session.getCurrentProvider()).toBe('anthropic');
    expect(session.getCurrentModel()).toBe('claude-opus-4-7');
    // Phase v4.1.2-bug2: also asserts the Runtime-slot wire-through.
    // setProvider must call setActiveModel after the adapter swap so
    // the system prompt's `## Runtime` slot stays in lockstep.
    expect(setActiveModelCalls).toEqual([
      { providerId: 'anthropic', modelId: 'claude-opus-4-7' },
    ]);
  });

  it('yoloMode flips approval engine to off at boot', async () => {
    const approvalEngine = mkApprovalEngine();
    const session = new ChatSession(
      buildOpts({
        approvalEngine,
        yoloMode: true,
        promptApi: mkPromptApi({ inputs: ['/quit'] }),
      }),
    );
    await session.run();
    // v4.12 SH.1 — yoloMode is user-initiated so it survives the frozen-mode
    // lock (in-process code can't flip approvals; the user's --yolo still can).
    expect((approvalEngine as { setMode: { mock: { calls: unknown[][] } } }).setMode.mock.calls)
      .toEqual([['off', { userInitiated: true }]]);
  });

  it('queueSystemPrompt prepends a system message on the next turn', async () => {
    const { agent, calls } = mkAgent();
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        promptApi: mkPromptApi({ inputs: ['hello', '/quit'] }),
      }),
    );
    session.queueSystemPrompt('You are now in finance mode.');
    await session.run();
    const conv = calls[0];
    expect(conv[0]).toMatchObject({ role: 'system', content: 'You are now in finance mode.' });
  });

  it('error from agent is caught and reported, loop continues', async () => {
    const { display, out } = mkDisplay();
    const { agent } = mkAgent({ shouldThrow: true });
    const session = new ChatSession(
      buildOpts({
        display,
        agent: agent as never,
        promptApi: mkPromptApi({ inputs: ['boom', '/quit'] }),
      }),
    );
    await session.run();
    expect(out.join('')).toMatch(/error|boom/i);
  });

  it('resumeSessionId preloads history and reuses the id', async () => {
    const { mgr, startCalls } = mkSessionManager();
    const preload: Message[] = [
      { role: 'user', content: 'old turn' },
      { role: 'assistant', content: 'reply' },
    ];
    const session = new ChatSession(
      buildOpts({
        sessionManager: mgr as never,
        resumeSessionId: 'existing-id',
        resumeHistory: preload,
        promptApi: mkPromptApi({ inputs: ['/quit'] }),
      }),
    );
    await session.run();
    expect(startCalls).toHaveLength(0);
    expect(session.getSessionId()).toBe('existing-id');
    expect(session.history.length).toBe(2);
  });
});

describe('ChatSession helpers', () => {
  it('renderProgressBar produces width-correct bar', () => {
    const bar = renderProgressBar(2, 10, 10);
    expect(bar).toBe('[▓▓░░░░░░░░]');
    const empty = renderProgressBar(0, 10, 5);
    expect(empty).toBe('[░░░░░]');
    const full = renderProgressBar(10, 10, 5);
    expect(full).toBe('[▓▓▓▓▓]');
  });

  it('formatTokens uses k/M suffix', () => {
    expect(formatTokens(123)).toBe('123');
    expect(formatTokens(4_200)).toBe('4.2k');
    expect(formatTokens(200_000)).toBe('200k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('formatDuration covers s/m/h', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(3 * 60_000)).toBe('3m');
    expect(formatDuration(62 * 60_000)).toBe('1h2m');
  });
});

// ── v4.6 Phase 2Q-B — REPL parent-run row wiring ─────────────────────────

describe('ChatSession — v4.6 Phase 2Q-B REPL parent-run row', () => {
  // Lightweight in-memory RunStore stub: records create + setStatus
  // calls without standing up sqlite. The chat session shouldn't care
  // what backs the store — it just needs an id back from create() and
  // a non-throwing setStatus().
  function mkFakeRunStore() {
    const created: Array<Parameters<import('../../../core/v4/daemon/runStore').RunStore['create']>[0]> = [];
    const status: Array<{ runId: number; status: string; opts?: { finishReason?: string; completedAt?: number } }> = [];
    let nextId = 100;
    const store = {
      create: vi.fn((opts) => {
        created.push(opts);
        return nextId++;
      }),
      setStatus: vi.fn((runId, s, opts) => {
        status.push({ runId, status: s, opts });
      }),
      markResumePending: vi.fn(),
      emitEvent:         vi.fn(),
      listActive:        vi.fn(() => []),
      get:               vi.fn(() => null),
      countEvents:       vi.fn(() => 0),
      listRecent:        vi.fn(() => []),
      listEvents:        vi.fn(() => []),
      countChildren:     vi.fn(() => ({ total: 0, completed: 0 })),
    };
    return { store: store as never, created, status };
  }

  it('writes a runs row before runConversation and updates to completed on success', async () => {
    const { agent } = mkAgent({ finalContent: 'hi back' });
    const { store, created, status } = mkFakeRunStore();
    const ref: { runId: number | null; sessionId: string | null } = { runId: null, sessionId: null };
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        promptApi: mkPromptApi({ inputs: ['hello', '/quit'] }),
        replRunStore:     store,
        replInstanceId:   'inst-test',
        replParentRunRef: ref,
      }),
    );
    await session.run();
    // One row created for the one user turn.
    expect(created).toHaveLength(1);
    expect(created[0].instanceId).toBe('inst-test');
    expect(created[0].status).toBe('running');
    // setStatus called once at completion with 'completed' + finishReason 'stop'.
    expect(status).toHaveLength(1);
    expect(status[0].status).toBe('completed');
    expect(status[0].opts?.finishReason).toBe('stop');
    // Ref cleared after the turn so cross-turn spawns get NULL parent.
    expect(ref.runId).toBeNull();
    expect(ref.sessionId).toBeNull();
  });

  it('writes failed status on agent throw and clears the ref', async () => {
    const { agent } = mkAgent({ shouldThrow: true });
    const { store, created, status } = mkFakeRunStore();
    const ref: { runId: number | null; sessionId: string | null } = { runId: null, sessionId: null };
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        promptApi: mkPromptApi({ inputs: ['boom', '/quit'] }),
        replRunStore:     store,
        replInstanceId:   'inst-test',
        replParentRunRef: ref,
      }),
    );
    await session.run();
    expect(created).toHaveLength(1);
    expect(status).toHaveLength(1);
    expect(status[0].status).toBe('failed');
    expect(status[0].opts?.finishReason).toBe('error');
    expect(ref.runId).toBeNull();
  });

  it('best-effort: runStore.create throwing does NOT crash the REPL turn', async () => {
    const { agent } = mkAgent({ finalContent: 'ok' });
    const store = {
      create: vi.fn(() => { throw new Error('synthetic db lock'); }),
      setStatus: vi.fn(),
      markResumePending: vi.fn(),
      emitEvent: vi.fn(),
      listActive: vi.fn(() => []),
      get: vi.fn(() => null),
      countEvents: vi.fn(() => 0),
      listRecent: vi.fn(() => []),
      listEvents: vi.fn(() => []),
      countChildren: vi.fn(() => ({ total: 0, completed: 0 })),
    };
    const ref: { runId: number | null; sessionId: string | null } = { runId: null, sessionId: null };
    // Silence the expected warn so test output stays clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        promptApi: mkPromptApi({ inputs: ['x', '/quit'] }),
        replRunStore:     store as never,
        replInstanceId:   'inst-test',
        replParentRunRef: ref,
      }),
    );
    await session.run();
    // Turn still ran to completion — agent.runConversation was called.
    expect(agent.runConversation).toHaveBeenCalledTimes(1);
    // setStatus was NOT called because create() failed first.
    expect(store.setStatus).not.toHaveBeenCalled();
    expect(ref.runId).toBeNull();
    warnSpy.mockRestore();
  });

  it('no runStore wiring → no rows written, no crash', async () => {
    const { agent } = mkAgent({ finalContent: 'ok' });
    const session = new ChatSession(
      buildOpts({
        agent: agent as never,
        promptApi: mkPromptApi({ inputs: ['x', '/quit'] }),
        // No replRunStore / replInstanceId / replParentRunRef.
      }),
    );
    await session.run();
    expect(agent.runConversation).toHaveBeenCalledTimes(1);
  });
});
