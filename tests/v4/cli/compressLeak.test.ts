/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — the "[compress] refused — conversation too short" chat leak is killed
 * at the SOURCE: the auto path does not ATTEMPT compression below the threshold
 * (no attempt → no refusal), and the sink stays SILENT on a refusal anyway
 * (internal housekeeping → never the user chat). A long conversation still
 * compresses, silently.
 */
import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { CliCallbacks } from '../../../cli/v4/callbacks';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { AidenAgent, type ToolExecutor } from '../../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import { ContextCompressor } from '../../../core/v4/contextCompressor';
import { ModelMetadata } from '../../../core/v4/modelMetadata';
import type { AuxiliaryClient } from '../../../core/v4/auxiliaryClient';
import type { Message } from '../../../providers/v4/types';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
function makeDisplay() {
  const chunks: string[] = [];
  const out = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } }) as unknown as NodeJS.WriteStream;
  return { display: new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out }), output: () => stripAnsi(chunks.join('')) };
}
const userMsg = (c: string): Message => ({ role: 'user', content: c });
const execOk: ToolExecutor = async (call) => ({ id: call.id, name: call.name, result: 'ok' });

describe('ContextCompressor.shouldAutoAttempt — the threshold gate', () => {
  it('is false below the minimum, true at/above it', () => {
    const c = new ContextCompressor(new ModelMetadata(), {} as unknown as AuxiliaryClient);
    expect(c.shouldAutoAttempt(0)).toBe(false);   // empty / first message
    expect(c.shouldAutoAttempt(9)).toBe(false);   // short
    expect(c.shouldAutoAttempt(10)).toBe(true);   // at threshold
    expect(c.shouldAutoAttempt(50)).toBe(true);   // long
  });
});

describe('agent auto-compress gate — no attempt on a short conversation', () => {
  function fakeCompressor(): { c: ContextCompressor; compress: ReturnType<typeof vi.fn> } {
    const compress = vi.fn(async () => ({
      compressedMessages: [], removedMessageCount: 0, summaryTokens: 0,
      preservedRecentCount: 0, refused: true, errorMessage: 'too short',
    }));
    const c = { shouldAutoAttempt: (n: number) => n >= 10, compress } as unknown as ContextCompressor;
    return { c, compress };
  }

  it('a SHORT convo → compress is NOT attempted and onCompression NEVER fires (no leak)', async () => {
    const { c, compress } = fakeCompressor();
    const onCompression = vi.fn();
    const agent = new AidenAgent({
      provider: new MockProviderAdapter([MockProviderAdapter.stop('hi')]),
      tools: [], toolExecutor: execOk, contextCompressor: c, onCompression,
    });
    await agent.runConversation([userMsg('hello')], {});
    expect(compress).not.toHaveBeenCalled();        // gated at the source
    expect(onCompression).not.toHaveBeenCalled();   // → no refusal event, no chat leak
  });

  it('a LONG convo (>= threshold) → compress IS attempted (gate does not over-block)', async () => {
    const { c, compress } = fakeCompressor();
    const history: Message[] = [];
    for (let i = 0; i < 6; i += 1) { history.push({ role: 'user', content: `u${i}` }); history.push({ role: 'assistant', content: `a${i}` }); }
    const agent = new AidenAgent({
      provider: new MockProviderAdapter([MockProviderAdapter.stop('done')]),
      tools: [], toolExecutor: execOk, contextCompressor: c,
    });
    await agent.runConversation(history, {});       // 12 messages ≥ 10
    expect(compress).toHaveBeenCalled();
  });
});

describe('callbacks sink — a refusal is silent in chat', () => {
  it('onCompression(refused) writes NOTHING to the user chat', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onCompression({
      compressedMessages: [], removedMessageCount: 0, summaryTokens: 0,
      preservedRecentCount: 0, refused: true, errorMessage: 'Conversation too short to compress',
    });
    expect(output()).not.toMatch(/\[compress\]/);   // no "[compress] refused …" leak
    expect(output()).not.toMatch(/too short/i);
    expect(output().trim()).toBe('');
  });

  it('onCompression(success) is silent in chat by default (housekeeping)', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onCompression({ compressedMessages: [], removedMessageCount: 5, summaryTokens: 200, preservedRecentCount: 4 });
    expect(output()).not.toMatch(/\[compress\]/);   // success is telemetry, not chat noise
  });
});
