/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 — headless one-shot (`aiden -q`) coverage.
 *
 * executeOneShotTurn is the pure, testable core: run one turn → print the
 * answer to stdout (clean/pipeable) → honest exit code → always tear down.
 * runQuery wraps it with the headless runtime build (injected here so the
 * tests never need a real provider).
 *
 * Covers the requested behaviours: prints reply + exit 0; agent error →
 * non-zero + stderr; approval-denied tool → surfaced + non-zero; incomplete
 * turn → non-zero; no-provider → clean "run aiden setup" + non-zero (wizard
 * NOT launched); stdout is clean; teardown always runs; and the calls RESOLVE
 * (no hang — the memory #29 discipline at the logic layer).
 */
import { describe, it, expect, vi } from 'vitest';

import {
  executeOneShotTurn,
  runQuery,
  NoProviderConfiguredError,
} from '../../../cli/v4/aidenCLI';

function mkAgent(result: any) {
  return { runConversation: vi.fn(async () => result) };
}

describe('executeOneShotTurn', () => {
  it('prints only the answer to stdout and returns 0 on a clean turn', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const teardown = vi.fn(async () => {});
    const code = await executeOneShotTurn({
      agent:   mkAgent({ finalContent: '4', finishReason: 'stop', toolCallTrace: [] }),
      prompt:  'what is 2+2',
      writeOut: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      teardown,
    });
    expect(code).toBe(0);
    expect(out.join('')).toBe('4\n');   // clean — only the answer, newline-terminated
    expect(err.join('')).toBe('');      // nothing on stderr
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('returns non-zero and reports to stderr when the agent throws (teardown still runs)', async () => {
    const err: string[] = [];
    const teardown = vi.fn(async () => {});
    const agent = { runConversation: vi.fn(async () => { throw new Error('provider 500'); }) };
    const code = await executeOneShotTurn({
      agent, prompt: 'x', writeOut: () => {}, writeErr: (s) => err.push(s), teardown,
    });
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/agent error: provider 500/);
    expect(teardown).toHaveBeenCalledTimes(1);   // finally always fires
  });

  it('surfaces an approval-denied tool and returns non-zero (answer still printed)', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await executeOneShotTurn({
      agent: mkAgent({
        finalContent: 'I was not able to run that tool.',
        finishReason: 'stop',
        toolCallTrace: [{ error: 'Tool execution denied by approval engine' }],
      }),
      prompt: 'delete everything', writeOut: (s) => out.push(s), writeErr: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/denied by the approval policy/i);
    expect(err.join('')).toMatch(/--yolo/);
    expect(out.join('')).toContain('I was not able to run that tool.');
  });

  it('returns non-zero when the turn did not finish cleanly', async () => {
    const err: string[] = [];
    const code = await executeOneShotTurn({
      agent: mkAgent({ finalContent: 'partial', finishReason: 'budget_exhausted', toolCallTrace: [] }),
      prompt: 'x', writeOut: () => {}, writeErr: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/finishReason: budget_exhausted/);
  });

  it('newline-terminates output for pipe hygiene, without doubling', async () => {
    const a: string[] = [];
    await executeOneShotTurn({ agent: mkAgent({ finalContent: 'no nl', finishReason: 'stop' }), prompt: 'x', writeOut: (s) => a.push(s), writeErr: () => {} });
    expect(a.join('')).toBe('no nl\n');

    const b: string[] = [];
    await executeOneShotTurn({ agent: mkAgent({ finalContent: 'has nl\n', finishReason: 'stop' }), prompt: 'x', writeOut: (s) => b.push(s), writeErr: () => {} });
    expect(b.join('')).toBe('has nl\n');
  });

  it('resolves cleanly (no hang) and runs teardown even on an empty answer', async () => {
    const teardown = vi.fn(async () => {});
    const code = await executeOneShotTurn({ agent: mkAgent({ finalContent: '', finishReason: 'stop' }), prompt: 'x', writeOut: () => {}, writeErr: () => {}, teardown });
    expect(code).toBe(0);
    expect(teardown).toHaveBeenCalled();
  });
});

describe('runQuery', () => {
  function mkRuntime(agentResult: any) {
    return {
      agent:         { runConversation: vi.fn(async () => agentResult) },
      mcpClient:     { closeAll: vi.fn(async () => {}) },
      pluginLoader:  { teardown: vi.fn(async () => {}) },
      channelManager:{ stopAll: vi.fn(async () => {}) },
      store:         { close: vi.fn(() => {}) },
    } as any;
  }

  it('maps NoProviderConfiguredError to a clean "run aiden setup" + exit 1 (wizard NOT launched)', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const build = vi.fn(async () => { throw new NoProviderConfiguredError(); });
      const code = await runQuery('hi', {}, {} as any, build as any);
      expect(code).toBe(1);
      const errText = errSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(errText).toMatch(/no provider configured/i);
      expect(errText).toMatch(/aiden setup/);
    } finally { errSpy.mockRestore(); }
  });

  it('maps an arbitrary startup failure to exit 1 without throwing', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const build = vi.fn(async () => { throw new Error('sqlite locked'); });
      const code = await runQuery('hi', {}, {} as any, build as any);
      expect(code).toBe(1);
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toMatch(/failed to start: sqlite locked/);
    } finally { errSpy.mockRestore(); }
  });

  it('runs one turn, tears down every handle, and returns 0 on success', async () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const runtime = mkRuntime({ finalContent: 'hello', finishReason: 'stop', toolCallTrace: [] });
      const build = vi.fn(async () => runtime);
      const code = await runQuery('say hi', {}, {} as any, build as any);
      expect(code).toBe(0);
      expect(runtime.mcpClient.closeAll).toHaveBeenCalled();
      expect(runtime.pluginLoader.teardown).toHaveBeenCalled();
      expect(runtime.channelManager.stopAll).toHaveBeenCalled();
      expect(runtime.store.close).toHaveBeenCalled();
      expect(outSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('hello');
    } finally { outSpy.mockRestore(); }
  });

  it('forwards headless:true and --yolo into the runtime build', async () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const build = vi.fn(async () => mkRuntime({ finalContent: 'ok', finishReason: 'stop' }));
      await runQuery('x', { yolo: true, provider: 'groq' }, {} as any, build as any);
      const passed = build.mock.calls[0][0] as any;
      expect(passed.headless).toBe(true);
      expect(passed.yolo).toBe(true);
      expect(passed.provider).toBe('groq');
    } finally { outSpy.mockRestore(); }
  });
});
