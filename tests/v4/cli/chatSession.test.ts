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
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { Message } from '../../../providers/v4/types';

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
  };
  return { agent, calls, setProviderCalls };
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

  it('renders the boxed startup card with provider/model/tool/skill counts', async () => {
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
    expect(text).toContain('╭');
    expect(text).toContain('╰');
    expect(text).toContain('Aiden v4.0.0');
    expect(text).toContain('groq');
    expect(text).toContain('llama-3.3-70b-versatile');
    expect(text).toContain('3 tools');
    expect(text).toContain('2 skills');
    expect(text).toMatch(/files: file_read/);
  });

  it('renders status line after each turn', async () => {
    const { display, out } = mkDisplay();
    const session = new ChatSession(
      buildOpts({
        display,
        promptApi: mkPromptApi({ inputs: ['hello', '/quit'] }),
      }),
    );
    await session.run();
    // Phase 22 Task 4: status line dropped the leading "$ " prefix
    // and switched to vertical-bar separators between segments.
    const text = out.join('');
    expect(text).toMatch(/groq:llama-3\.3-70b-versatile/);
    expect(text).toMatch(/ctx \d/);
    expect(text).toMatch(/budget \d+\/90/);
    expect(text).toMatch(/ │ /); // separator present
    expect(text).toMatch(/ready/); // right-most state segment
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
    const { agent, setProviderCalls } = mkAgent();
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
    expect((approvalEngine as { setMode: { mock: { calls: unknown[][] } } }).setMode.mock.calls).toEqual([['off']]);
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
