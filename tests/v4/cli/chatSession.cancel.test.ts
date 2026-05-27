/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 3 — mid-turn cancel integration.
 *
 * Coverage:
 *   1. ChatSession passes its per-turn AbortSignal into
 *      agent.runConversation (B1 — wake the wire).
 *   2. A mid-turn abort surfaces as finishReason='interrupted',
 *      the REPL renders "(turn interrupted)", and stays alive for
 *      the next user prompt (B5 — abort-aware catch + finally).
 *   3. The R1 callback-turnId guard drops late callbacks from a
 *      cancelled turn even when they fire AFTER a new turn has
 *      started (B4 — Tier-1 mitigation).
 *
 * Driven through the same harness pattern as chatSession.test.ts
 * (scripted agent + scripted prompt + writable Display) so the
 * tests exercise the production wire-through, not a mock surface.
 */
import { describe, it, expect, vi } from 'vitest';
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
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
    stderr: err,
  });
  return { display, out: chunks };
}

function mkPromptApi(inputs: string[]): ChatPromptApi {
  let i = 0;
  return {
    async readLine() {
      if (i >= inputs.length) throw new Error('User force closed');
      return inputs[i++];
    },
    async selectSlashCommand() { return null; },
  };
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
    list: () => [],
    get:  () => undefined,
    getSchemas:    () => [],
    register:      vi.fn(),
    unregister:    vi.fn(),
    byCategory:    () => [],
    buildExecutor: () => async () => ({ id: '1', name: 'noop', result: null }),
  };
}

function mkSessionManager() {
  return {
    startSession: vi.fn(() => ({ id: 'sess-cancel-1', title: null, providerId: 'g', modelId: 'm' } as never)),
    recordTurn:   vi.fn(),
    resumeLatest: vi.fn(),
    resumeById:   vi.fn(),
    listSessions: vi.fn(() => []),
    setSessionTitle: vi.fn(),
    search:       vi.fn(() => []),
  };
}

function buildBaseOpts(over: Partial<ChatSessionOptions>): ChatSessionOptions {
  const { display } = mkDisplay();
  return {
    agent:           over.agent!,
    display:         over.display ?? display,
    commandRegistry: new CommandRegistry(),
    callbacks:       {} as never,
    sessionManager:  mkSessionManager() as never,
    approvalEngine:  mkApprovalEngine(),
    skin:            new SkinEngine({ forceMono: true }),
    toolRegistry:    mkToolRegistry() as never,
    skillLoader:     {
      list:           vi.fn(async () => []),
      load:           vi.fn(),
      loadAll:        vi.fn(async () => []),
      readSkillFile:  vi.fn(),
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
    installSignalHandler: false,
    promptApi:        over.promptApi ?? mkPromptApi(['/quit']),
    ...over,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('ChatSession — mid-turn cancel (v4.11 Slice 3)', () => {
  it('B1: passes a live AbortSignal to agent.runConversation per turn', async () => {
    // The scripted agent captures the signal it was passed and the
    // turn settles cleanly. We assert (a) a signal arrives and (b) it
    // is unique per turn (each runAgentTurn mints its own controller).
    const signals: (AbortSignal | undefined)[] = [];
    const agent = {
      runConversation: vi.fn(async (
        _history: Message[],
        opts: { signal?: AbortSignal },
      ) => {
        signals.push(opts.signal);
        return {
          finalContent: 'ok',
          messages:     [..._history, { role: 'assistant', content: 'ok' }] as Message[],
          turnCount: 1, toolCallCount: 0, fallbackActivated: false,
          finishReason: 'stop' as const,
          totalUsage: { inputTokens: 1, outputTokens: 1 },
          toolCallTrace: [],
        };
      }),
      setProvider:    vi.fn(),
      setActiveModel: vi.fn(() => true),
    };
    const { display } = mkDisplay();
    const session = new ChatSession(buildBaseOpts({
      agent:     agent as never,
      display,
      promptApi: mkPromptApi(['hi', 'again', '/quit']),
    }));
    await session.run();
    // Two user turns → two distinct signals captured.
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBeDefined();
    expect(signals[0]).not.toBe(signals[1]);
    // Neither was aborted by turn-end (controller cleared in finally).
    expect(signals[0]!.aborted).toBe(false);
    expect(signals[1]!.aborted).toBe(false);
  });

  it('B5: abort during a turn → finishReason=interrupted + dim "(turn interrupted)"', async () => {
    // The scripted agent aborts ITS OWN signal mid-await, then returns
    // finishReason='interrupted'. Mirrors what the real agent loop
    // does when the between-iteration check or provider AbortError
    // fires. ChatSession's success-path branch should render the
    // dim confirmation line.
    const agent = {
      runConversation: vi.fn(async (
        history: Message[],
        opts: { signal?: AbortSignal },
      ) => {
        // Simulate Ctrl+C mid-turn — the SIGINT dispatcher would
        // ordinarily abort, but for unit isolation we abort here.
        opts.signal?.dispatchEvent?.(new Event('abort'));
        return {
          finalContent: '',
          messages:     [...history],
          turnCount: 0, toolCallCount: 0, fallbackActivated: false,
          finishReason: 'interrupted' as const,
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          toolCallTrace: [],
        };
      }),
      setProvider:    vi.fn(),
      setActiveModel: vi.fn(() => true),
    };
    const { display, out } = mkDisplay();
    const session = new ChatSession(buildBaseOpts({
      agent:     agent as never,
      display,
      promptApi: mkPromptApi(['hi', '/quit']),
    }));
    await session.run();
    const text = out.join('');
    expect(text).toContain('(turn interrupted)');
  });

  it('B5: REPL survives mid-turn cancel — next user prompt runs the agent again', async () => {
    // Turn 1 returns interrupted; turn 2 returns ok. Assert agent
    // was called twice (REPL didn't exit on the cancel).
    let calls = 0;
    const agent = {
      runConversation: vi.fn(async (history: Message[]) => {
        calls += 1;
        if (calls === 1) {
          return {
            finalContent: '',
            messages:     [...history],
            turnCount: 0, toolCallCount: 0, fallbackActivated: false,
            finishReason: 'interrupted' as const,
            totalUsage: { inputTokens: 0, outputTokens: 0 },
            toolCallTrace: [],
          };
        }
        return {
          finalContent: 'reply',
          messages:     [...history, { role: 'assistant', content: 'reply' }] as Message[],
          turnCount: 1, toolCallCount: 0, fallbackActivated: false,
          finishReason: 'stop' as const,
          totalUsage: { inputTokens: 1, outputTokens: 1 },
          toolCallTrace: [],
        };
      }),
      setProvider:    vi.fn(),
      setActiveModel: vi.fn(() => true),
    };
    const { display, out } = mkDisplay();
    const session = new ChatSession(buildBaseOpts({
      agent:     agent as never,
      display,
      promptApi: mkPromptApi(['cancel-me', 'second-turn', '/quit']),
    }));
    await session.run();
    expect(calls).toBe(2);
    expect(out.join('')).toContain('reply');
  });

  it('B5: AbortError THROWN from the agent → caught + dim line + REPL alive', async () => {
    // Path: agent's catch doesn't route the abort and re-throws an
    // AbortError. ChatSession's catch must recognise it and render
    // the dim line instead of the generic printError/capability card.
    let calls = 0;
    const agent = {
      runConversation: vi.fn(async (history: Message[]) => {
        calls += 1;
        if (calls === 1) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        return {
          finalContent: 'second',
          messages:     [...history, { role: 'assistant', content: 'second' }] as Message[],
          turnCount: 1, toolCallCount: 0, fallbackActivated: false,
          finishReason: 'stop' as const,
          totalUsage: { inputTokens: 1, outputTokens: 1 },
          toolCallTrace: [],
        };
      }),
      setProvider:    vi.fn(),
      setActiveModel: vi.fn(() => true),
    };
    const { display, out } = mkDisplay();
    const session = new ChatSession(buildBaseOpts({
      agent:     agent as never,
      display,
      promptApi: mkPromptApi(['cancel-me', 'next', '/quit']),
    }));
    await session.run();
    const text = out.join('');
    expect(text).toContain('(turn interrupted)');
    // No "Run `/model` to switch providers" — that's the error-class
    // fallback hint. Cancel should NOT surface it.
    expect(text).not.toContain('Run `/model`');
    // Second turn ran.
    expect(text).toContain('second');
    expect(calls).toBe(2);
  });

  it('B4 / R1: a stale-turn callback dropped silently (no display mutation)', async () => {
    // We capture an onDelta callback from turn 1, run turn 2, then
    // invoke the captured callback AFTER turn 2 settles. The
    // wrapTurnId guard should make it a no-op — display.streamPartial
    // must NOT be called.
    let capturedDelta: ((text: string) => void) | undefined;
    const agent = {
      runConversation: vi.fn(async (
        history: Message[],
        opts: { onDelta?: (text: string) => void },
      ) => {
        // Capture the onDelta of the FIRST turn only.
        if (!capturedDelta) capturedDelta = opts.onDelta;
        return {
          finalContent: 'ok',
          messages:     [...history, { role: 'assistant', content: 'ok' }] as Message[],
          turnCount: 1, toolCallCount: 0, fallbackActivated: false,
          finishReason: 'stop' as const,
          totalUsage: { inputTokens: 1, outputTokens: 1 },
          toolCallTrace: [],
        };
      }),
      setProvider:    vi.fn(),
      setActiveModel: vi.fn(() => true),
    };
    // Enable streaming so onDelta is actually wired (else it's undefined).
    const config = {
      getValue: <T>(k: string, def: T): T =>
        k === 'display.streaming' ? (true as unknown as T) : def,
    } as never;
    const { display } = mkDisplay();
    const spyStream = vi.spyOn(display, 'streamPartial');

    const session = new ChatSession(buildBaseOpts({
      agent:     agent as never,
      display,
      config,
      promptApi: mkPromptApi(['turn1', 'turn2', '/quit']),
    }));
    await session.run();
    // Two turns ran; capturedDelta is from turn 1, and activeTurnId
    // has now advanced past turn-1's id and been cleared. Invoke it.
    expect(typeof capturedDelta).toBe('function');
    spyStream.mockClear();
    capturedDelta!('LATE PAINT FROM CANCELLED TURN');
    // Guard MUST have dropped this — streamPartial NOT called.
    expect(spyStream).not.toHaveBeenCalled();
  });
});
