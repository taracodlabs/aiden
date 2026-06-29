/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 3 — SIGINT two-press dispatcher integration tests.
 *
 * Drives real `process.on('SIGINT', ...)` registration through the
 * chatSession lifecycle. Mocks `process.exit` so the graceful-shutdown
 * branch is observable without actually killing the test process.
 *
 * Covers the state-machine cases the Phase A audit A6.2 locked:
 *   T1. First press at IDLE (no active turn)         → graceful shutdown
 *   T2. First press DURING a turn                    → abort() the controller, REPL alive
 *   T3. Second press within FORCE_EXIT_WINDOW_MS     → graceful shutdown
 *   T4. Second press AFTER the window expires        → fresh first press (abort, no exit)
 *
 * The graceful-shutdown branch is the existing pre-Slice-3 behaviour
 * (session_summary + farewell + process.exit). We assert it is reached
 * by spying on process.exit; we do NOT assert on the summary internals
 * (covered by existing chatSession.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import {
  ChatSession,
  type ChatPromptApi,
  type ChatSessionOptions,
} from '../../../cli/v4/chatSession';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { Message } from '../../../providers/v4/types';

// ── Harness ─────────────────────────────────────────────────────────────

function mkDisplay() {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
  }) as unknown as NodeJS.WriteStream;
  const err = new Writable({
    write(_chunk, _enc, cb) { cb(); },
  }) as unknown as NodeJS.WriteStream;
  (out as unknown as { isTTY: boolean }).isTTY = false;
  return new Display({
    skin:   new SkinEngine({ forceMono: true }),
    stdout: out,
    stderr: err,
  });
}

function mkApprovalEngine() {
  let mode: 'manual' | 'smart' | 'off' = 'manual';
  return {
    setMode: vi.fn((m: typeof mode) => { mode = m; }),
    getMode: () => mode,
    checkApproval: vi.fn(async () => true),
    allowForSession: vi.fn(),
    allowAlways:     vi.fn(),
    resetSession:    vi.fn(),
  } as never;
}

function mkToolRegistry() {
  return {
    list: () => [], get: () => undefined, getSchemas: () => [],
    register: vi.fn(), unregister: vi.fn(), byCategory: () => [],
    buildExecutor: () => async () => ({ id: '1', name: 'noop', result: null }),
  };
}

function mkSessionManager() {
  return {
    startSession: vi.fn(() => ({ id: 'sess-sigint-1', title: null, providerId: 'g', modelId: 'm' } as never)),
    recordTurn:   vi.fn(),
    resumeLatest: vi.fn(),
    resumeById:   vi.fn(),
    listSessions: vi.fn(() => []),
    setSessionTitle: vi.fn(),
    search:       vi.fn(() => []),
  };
}

function buildOpts(over: Partial<ChatSessionOptions>): ChatSessionOptions {
  return {
    agent:           over.agent!,
    display:         over.display ?? mkDisplay(),
    commandRegistry: new CommandRegistry(),
    callbacks:       {} as never,
    sessionManager:  mkSessionManager() as never,
    approvalEngine:  mkApprovalEngine(),
    skin:            new SkinEngine({ forceMono: true }),
    toolRegistry:    mkToolRegistry() as never,
    skillLoader: {
      list: vi.fn(async () => []), load: vi.fn(), loadAll: vi.fn(async () => []),
      readSkillFile: vi.fn(),
    } as never,
    resolver: {
      resolve:       vi.fn(async () => ({ call: vi.fn() })),
      describe:      vi.fn(),
      listProviders: vi.fn(() => []),
      listModels:    vi.fn(() => []),
    } as never,
    config:           {} as never,
    initialProviderId:'groq',
    initialModelId:   'm',
    // SIGINT tests REQUIRE the handler to be installed.
    installSignalHandler: true,
    promptApi:        over.promptApi!,
    ...over,
  };
}

/**
 * Make a prompt API that returns scripted inputs. When `forceClose`
 * resolves (via `releasePrompt()` returned by the helper), any
 * subsequent readLine rejects with 'User force closed' — the same
 * sentinel inquirer throws on a real Ctrl+C. This is how the test
 * harness simulates the REPL exiting cleanly after the mocked
 * process.exit returned (instead of actually killing the process).
 */
function mkScriptedPromptApi(inputs: string[]): {
  api:            ChatPromptApi;
  releasePrompt:  () => void;
} {
  let i = 0;
  let resolveClose!: () => void;
  const closed = new Promise<void>((res) => { resolveClose = res; });
  return {
    api: {
      async readLine() {
        if (i >= inputs.length) {
          // Past the script — block until released.
          await closed;
          throw new Error('User force closed');
        }
        return inputs[i++];
      },
      async selectSlashCommand() { return null; },
    },
    releasePrompt: () => resolveClose(),
  };
}

// Track exit calls so the dispatcher's graceful-shutdown branch is
// observable without actually terminating the test process.
//
// The mock does NOT throw — the SIGINT handler is async, and a synch
// throw inside an awaited code path produces an UnhandledRejection
// that confuses the runner. Instead, exit-spy records the call and
// resolves a deferred that the test or harness can `await`.
//
// To make `session.run()` actually return after the mocked exit, we
// also expose a "release" hook — see mkScriptedPromptApi's `releaseOnExit`
// option, which rejects the next `readLine` call with the same
// "User force closed" sentinel the inquirer prompt produces on a
// real Ctrl+C. This lets the REPL's main while-loop catch at
// chatSession.ts:781 break cleanly.
function installExitSpy() {
  const exits: Array<number | undefined> = [];
  let resolveExit!: () => void;
  const exited = new Promise<void>((res) => { resolveExit = res; });
  const spy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code);
    resolveExit();
    return undefined as never;
  }) as never);
  return { spy, exits, exited };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('ChatSession SIGINT two-press dispatcher (v4.11 Slice 3)', () => {
  let exitSpy: ReturnType<typeof installExitSpy>;

  beforeEach(() => {
    exitSpy = installExitSpy();
  });
  afterEach(() => {
    exitSpy.spy.mockRestore();
    // Drain any lingering SIGINT listeners installed by the test
    // (chatSession's finally `process.off` should have run, but if a
    // test threw early we belt-and-braces here).
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('T1: first press at IDLE (no active turn) → graceful shutdown', async () => {
    // Agent never runs — we send SIGINT while the prompt is awaiting
    // input. installSignalHandler:true means SIGINT is wired before
    // the prompt blocks.
    const agent = {
      runConversation: vi.fn(),
      setProvider:     vi.fn(),
      setActiveModel:  vi.fn(() => true),
    };
    const { api: promptApi, releasePrompt } = mkScriptedPromptApi([]);
    const session = new ChatSession(buildOpts({ agent: agent as never, promptApi }));

    const runP = session.run();
    // Give chatSession a microtask to install the SIGINT handler.
    await new Promise((r) => setImmediate(r));
    process.emit('SIGINT');
    await exitSpy.exited;
    // After the mocked exit returns, release the prompt so run() can
    // exit cleanly (in real life, process.exit terminated us first).
    releasePrompt();
    await runP;
    expect(exitSpy.exits).toEqual([0]);
    // Agent never invoked.
    expect(agent.runConversation).not.toHaveBeenCalled();
  });

  it('T2: first press DURING a turn → controller.abort, REPL stays alive', async () => {
    // The agent runs and awaits a deferred promise; the test fires
    // SIGINT while the agent is mid-await; the agent observes
    // signal.aborted and returns finishReason='interrupted'. The
    // REPL must NOT call process.exit — it stays alive for the next
    // prompt iteration. To prove it: queue a /quit after the first
    // turn and assert the REPL reaches it without exiting from the
    // first SIGINT.
    let resolveAgent!: () => void;
    const agentBlocked = new Promise<void>((res) => { resolveAgent = res; });

    let capturedSignal: AbortSignal | undefined;
    const agent = {
      runConversation: vi.fn(async (
        _history: Message[],
        opts: { signal?: AbortSignal },
      ) => {
        capturedSignal = opts.signal;
        // Wait for the test to either fire SIGINT (we observe it via
        // signal.aborted) or resolve us directly.
        opts.signal?.addEventListener('abort', () => resolveAgent(), { once: true });
        await agentBlocked;
        return {
          finalContent: '',
          messages:     [..._history],
          turnCount:    0, toolCallCount: 0, fallbackActivated: false,
          finishReason: 'interrupted' as const,
          totalUsage:   { inputTokens: 0, outputTokens: 0 },
          toolCallTrace: [],
        };
      }),
      setProvider:    vi.fn(),
      setActiveModel: vi.fn(() => true),
    };
    // Single-input script: after the turn settles, the next readLine
    // blocks until the test releases it. This isolates the assertion
    // to ONE turn without /quit falling through into another agent
    // invocation (the test registry has no real commands).
    const { api: promptApi, releasePrompt } = mkScriptedPromptApi(['hi-from-test']);
    const session = new ChatSession(buildOpts({ agent: agent as never, promptApi }));

    const runP = session.run();
    // Let the first turn enter the agent.
    await new Promise((r) => setImmediate(r));
    // Spin until the agent has captured the signal.
    for (let i = 0; i < 50 && !capturedSignal; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    // First press during the turn.
    process.emit('SIGINT');
    // The controller should have aborted.
    expect(capturedSignal!.aborted).toBe(true);
    // process.exit must NOT have been called — REPL alive.
    expect(exitSpy.exits).toEqual([]);
    // Let the agent finalise and the REPL re-enter readLine.
    // Then release so run() can exit cleanly.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    releasePrompt();
    await runP;
    // process.exit was never called — REPL stayed alive past the cancel.
    expect(exitSpy.exits).toEqual([]);
    // The agent ran exactly once for the cancelled turn.
    expect(agent.runConversation).toHaveBeenCalledTimes(1);
  });

  it('T3: SECOND press within FORCE_EXIT_WINDOW_MS → graceful shutdown', async () => {
    // First press aborts the turn; second press within 2s falls
    // through to graceful shutdown. We fire both in quick succession
    // while the agent is mid-await.
    let resolveAgent!: () => void;
    const agentBlocked = new Promise<void>((res) => { resolveAgent = res; });
    let capturedSignal: AbortSignal | undefined;
    const agent = {
      runConversation: vi.fn(async (
        _history: Message[],
        opts: { signal?: AbortSignal },
      ) => {
        capturedSignal = opts.signal;
        opts.signal?.addEventListener('abort', () => resolveAgent(), { once: true });
        await agentBlocked;
        return {
          finalContent: '',
          messages:     [..._history],
          turnCount:    0, toolCallCount: 0, fallbackActivated: false,
          finishReason: 'interrupted' as const,
          totalUsage:   { inputTokens: 0, outputTokens: 0 },
          toolCallTrace: [],
        };
      }),
      setProvider:    vi.fn(),
      setActiveModel: vi.fn(() => true),
    };
    const { api: promptApi, releasePrompt } = mkScriptedPromptApi(['will-be-cancelled']);
    const session = new ChatSession(buildOpts({ agent: agent as never, promptApi }));

    const runP = session.run();
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 50 && !capturedSignal; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    // First press — abort, no exit.
    process.emit('SIGINT');
    expect(capturedSignal!.aborted).toBe(true);
    expect(exitSpy.exits).toEqual([]);
    // Second press IMMEDIATELY (well inside the 2s window).
    process.emit('SIGINT');
    await exitSpy.exited;
    releasePrompt();
    await runP;
    expect(exitSpy.exits).toEqual([0]);
  });

  it('T4: second press AFTER window expiry → treated as a fresh first press (no exit)', async () => {
    // First press aborts turn 1; the turn settles, finally clears
    // lastInterruptAt; user submits turn 2; presses Ctrl+C again.
    // Because lastInterruptAt was reset in finally, this is a FIRST
    // press for turn 2 — should abort without exiting.
    let resolveCount = 0;
    const blocks: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const agent = {
      runConversation: vi.fn(async (
        _history: Message[],
        opts: { signal?: AbortSignal },
      ) => {
        if (opts.signal) signals.push(opts.signal);
        await new Promise<void>((res) => {
          blocks.push(res);
          opts.signal?.addEventListener('abort', () => res(), { once: true });
        });
        resolveCount += 1;
        return {
          finalContent: '',
          messages:     [..._history],
          turnCount:    0, toolCallCount: 0, fallbackActivated: false,
          finishReason: 'interrupted' as const,
          totalUsage:   { inputTokens: 0, outputTokens: 0 },
          toolCallTrace: [],
        };
      }),
      setProvider:    vi.fn(),
      setActiveModel: vi.fn(() => true),
    };
    const { api: promptApi, releasePrompt } = mkScriptedPromptApi(['turn-1', 'turn-2']);
    const session = new ChatSession(buildOpts({ agent: agent as never, promptApi }));

    const runP = session.run();
    // Turn 1: wait for signal, press once.
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 50 && signals.length < 1; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    process.emit('SIGINT');
    expect(signals[0].aborted).toBe(true);
    // Wait for turn 1 to settle (finally runs — lastInterruptAt cleared).
    for (let i = 0; i < 100 && resolveCount < 1; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    // Turn 2: wait for second signal capture, then press once.
    for (let i = 0; i < 100 && signals.length < 2; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    process.emit('SIGINT');
    expect(signals[1].aborted).toBe(true);
    // Because the first-press timestamp was reset between turns,
    // this is treated as a fresh first press → no process.exit.
    expect(exitSpy.exits).toEqual([]);
    // Let turn 2 settle, then release the prompt so run() exits.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    releasePrompt();
    await runP;
    expect(exitSpy.exits).toEqual([]);
  });
});
