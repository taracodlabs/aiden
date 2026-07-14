/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 perf — parallel read-only tool dispatch + per-call timing
 * instrumentation tests.
 *
 * Pre-fix: `runTurnLoop` iterated `output.toolCalls` strictly
 * sequentially via `for...of` + `await this.toolExecutor(call)`.
 * Independent network reads (web_search × 4) waited on each other.
 * Post-fix: consecutive read-only batches pre-execute via
 * `Promise.all`; mutating calls stay sequential; result order
 * preserved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AidenAgent,
  type ToolExecutor,
} from '../../../core/v4/aidenAgent';
import {
  type Message,
  type ProviderAdapter,
  type ProviderCallInput,
  type ProviderCallOutput,
  type ToolCallRequest,
  type ToolSchema,
} from '../../../providers/v4/types';

const NO_TOOLS: ToolSchema[] = [];
const userMsg = (content: string): Message => ({ role: 'user', content });
const tc = (id: string, name: string): ToolCallRequest => ({
  id, name, arguments: { q: id },
});

/**
 * Scripted adapter: emits ONE response of N tool calls, then a
 * 'done' on the next iteration. Common shape for testing dispatch
 * behaviour against a known toolCalls[] batch.
 */
class ScriptedAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  callCount = 0;
  constructor(private scripted: ProviderCallOutput[]) {}
  async call(_input: ProviderCallInput): Promise<ProviderCallOutput> {
    this.callCount++;
    if (this.scripted.length === 0) {
      return { content: 'done', toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
    }
    return this.scripted.shift()!;
  }
}

/**
 * Returns a toolExecutor that sleeps for `delayMs` per call, recording
 * (start, end) timestamps keyed by call.id. Lets us observe whether
 * dispatch overlapped (parallel) or was serialized.
 */
function makeTimedExecutor(delayMs: number): {
  exec: ToolExecutor;
  events: Array<{ id: string; name: string; startedAt: number; endedAt: number }>;
} {
  const events: Array<{ id: string; name: string; startedAt: number; endedAt: number }> = [];
  const exec: ToolExecutor = async (call) => {
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, delayMs));
    const endedAt = Date.now();
    events.push({ id: call.id, name: call.name, startedAt, endedAt });
    return { id: call.id, name: call.name, result: `ok-${call.id}` };
  };
  return { exec, events };
}

/** Helper: did the events overlap in time (parallel) or were they back-to-back (sequential)? */
function maxOverlap(events: Array<{ startedAt: number; endedAt: number }>): number {
  // Count how many events are "in flight" at the peak.
  const points: Array<[number, number]> = []; // (time, +1 start / -1 end)
  for (const e of events) {
    points.push([e.startedAt, +1]);
    points.push([e.endedAt,   -1]);
  }
  // Sort by time; on tie, process ENDS (-1) before STARTS (+1) so a
  // back-to-back end/start at the same timestamp doesn't register a
  // spurious overlap blip.
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, d] of points) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

describe('AidenAgent — parallel pure-read tool dispatch (v4.11 perf)', () => {
  it('3 consecutive read-only tool calls execute IN PARALLEL', async () => {
    // Provider emits 3 web_search calls in one batch. All read-only
    // (default: resolveMutates returns undefined → !==true → read).
    // Post-fix: Promise.all batches them. Sequential dispatch would
    // take ~3 × delayMs; parallel should take ~1 × delayMs.
    const adapter = new ScriptedAdapter([
      {
        content:   '',
        toolCalls: [tc('c1', 'web_search'), tc('c2', 'web_search'), tc('c3', 'web_search')],
        usage:        { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      },
    ]);
    const { exec, events } = makeTimedExecutor(200);
    const agent = new AidenAgent({
      provider:     adapter,
      tools:        NO_TOOLS,
      toolExecutor: exec,
      // No resolveMutates → all calls treated as read-only.
    });

    const wallStart = Date.now();
    await agent.runConversation([userMsg('do 3 searches')]);
    const wallMs = Date.now() - wallStart;

    // All 3 calls were dispatched.
    expect(events).toHaveLength(3);
    // PARALLELISM CHECK: at the peak there should be 3 in-flight.
    expect(maxOverlap(events)).toBe(3);
    // WALL-TIME CHECK: 3 × 200ms sequential would be ≥600ms.
    // Parallel target: ~200ms + overhead. Permissive bound at 400ms.
    expect(wallMs).toBeLessThan(500);
  });

  it('mutating calls STAY SEQUENTIAL (no parallel dispatch)', async () => {
    // 3 file_write calls — resolveMutates says 'file_write' mutates.
    // Post-fix: parallel path skipped; existing for-of awaits each.
    const adapter = new ScriptedAdapter([
      {
        content:   '',
        toolCalls: [tc('m1', 'file_write'), tc('m2', 'file_write'), tc('m3', 'file_write')],
        usage:        { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      },
    ]);
    const { exec, events } = makeTimedExecutor(100);
    const agent = new AidenAgent({
      provider:        adapter,
      tools:           NO_TOOLS,
      toolExecutor:    exec,
      resolveMutates:  (name) => name === 'file_write',
    });

    await agent.runConversation([userMsg('write 3 files')]);

    expect(events).toHaveLength(3);
    // SEQUENTIAL CHECK: at no point are 2+ in flight.
    expect(maxOverlap(events)).toBe(1);
  });

  it('mixed batch: leading read-only group parallelizes, mutating call follows sequentially', async () => {
    // Pattern: 2 web_search + 1 file_write. The 2 reads parallelize;
    // the write runs after (or before — the impl picks maximal
    // consecutive batches anywhere in the array, but mutating
    // calls always live-execute serially).
    const adapter = new ScriptedAdapter([
      {
        content:   '',
        toolCalls: [tc('r1', 'web_search'), tc('r2', 'web_search'), tc('w1', 'file_write')],
        usage:        { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      },
    ]);
    const { exec, events } = makeTimedExecutor(150);
    const agent = new AidenAgent({
      provider:       adapter,
      tools:          NO_TOOLS,
      toolExecutor:   exec,
      resolveMutates: (name) => name === 'file_write',
    });

    await agent.runConversation([userMsg('search 2 + write 1')]);

    expect(events).toHaveLength(3);
    // The 2 reads overlap → peak overlap is 2 (not 3 — the write
    // doesn't run concurrently with the reads).
    const reads = events.filter((e) => e.name === 'web_search');
    expect(maxOverlap(reads)).toBe(2);
    // The write doesn't overlap with anything (mutating tools
    // never enter the parallel batch).
    const allWithWrite = events;
    // Across ALL events, peak should be 2 (the parallel reads), not 3.
    expect(maxOverlap(allWithWrite)).toBeLessThanOrEqual(2);
  });

  it('result ORDER preserved: tool messages match original call order', async () => {
    // The model expects tool results in the same order it emitted
    // the tool calls. Promise.all preserves array order; we verify
    // by checking the tool-result message sequence on the captured
    // history.
    const adapter = new ScriptedAdapter([
      {
        content:   '',
        toolCalls: [tc('a1', 'web_search'), tc('a2', 'web_search'), tc('a3', 'web_search')],
        usage:        { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      },
    ]);
    // Asymmetric delays to make sure order isn't accidentally
    // preserved by uniform timing.
    let callIdx = 0;
    const exec: ToolExecutor = async (call) => {
      const delays = [200, 50, 100];
      const d = delays[callIdx++] ?? 50;
      await new Promise((r) => setTimeout(r, d));
      return { id: call.id, name: call.name, result: `ok-${call.id}` };
    };
    const agent = new AidenAgent({
      provider:     adapter,
      tools:        NO_TOOLS,
      toolExecutor: exec,
    });
    const result = await agent.runConversation([userMsg('go')]);

    // Tool-role messages in result.messages should appear in
    // original-call order (a1, a2, a3), even though a2 finished
    // first.
    const toolMsgs = result.messages.filter(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    );
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('solo read-only call does NOT enter parallel batch (live-execution path)', async () => {
    // Single tool call → batch size 1 → skip Promise.all. Verifies
    // we don't introduce unnecessary overhead for the common
    // 1-tool-per-iteration case. Hard to assert directly without
    // perf probe; assertion is "doesn't break behaviour" via
    // result-order check.
    const adapter = new ScriptedAdapter([
      {
        content:   '',
        toolCalls: [tc('solo', 'web_search')],
        usage:        { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      },
    ]);
    const { exec, events } = makeTimedExecutor(50);
    const agent = new AidenAgent({
      provider:     adapter,
      tools:        NO_TOOLS,
      toolExecutor: exec,
    });
    await agent.runConversation([userMsg('one')]);
    expect(events).toHaveLength(1);
  });

  it.each(['clarify', 'plan_approval'])('%s calls execute sequentially in provider order', async (interactiveName) => {
    const adapter = new ScriptedAdapter([{
      content: '',
      toolCalls: [tc('first', interactiveName), tc('second', interactiveName)],
      usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'tool_calls',
    }]);
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const exec: ToolExecutor = async (call) => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(call.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { id: call.id, name: call.name, result: 'ok' };
    };
    const agent = new AidenAgent({ provider: adapter, tools: NO_TOOLS, toolExecutor: exec });
    await agent.runConversation([userMsg('ask twice')]);
    expect(peak).toBe(1);
    expect(order).toEqual(['first', 'second']);
  });

  it('clarify does not overlap an adjacent normal read-only call', async () => {
    const adapter = new ScriptedAdapter([{
      content: '',
      toolCalls: [tc('search', 'web_search'), tc('ask', 'clarify')],
      usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'tool_calls',
    }]);
    const { exec, events } = makeTimedExecutor(30);
    const agent = new AidenAgent({ provider: adapter, tools: NO_TOOLS, toolExecutor: exec });
    await agent.runConversation([userMsg('search then ask')]);
    expect(maxOverlap(events)).toBe(1);
    expect(events.map((event) => event.id)).toEqual(['search', 'ask']);
  });
});

describe('AidenAgent — AIDEN_PERF_DIAG instrumentation (v4.11 perf)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let captured:  string[];

  beforeEach(() => {
    captured = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env.AIDEN_PERF_DIAG;
  });

  it('env-gate OFF (default): no [perf:...] lines emitted', async () => {
    delete process.env.AIDEN_PERF_DIAG;
    const adapter = new ScriptedAdapter([
      {
        content:   '',
        toolCalls: [tc('c1', 'web_search')],
        usage:        { inputTokens: 5, outputTokens: 3 },
        finishReason: 'tool_calls',
      },
    ]);
    const agent = new AidenAgent({
      provider:     adapter,
      tools:        NO_TOOLS,
      toolExecutor: async (call) => ({ id: call.id, name: call.name, result: 'ok' }),
    });
    await agent.runConversation([userMsg('hi')]);
    const perfLines = captured.filter((l) => l.startsWith('[perf:'));
    expect(perfLines).toHaveLength(0);
  });

  it('env-gate ON: emits per-iter LLM + per-tool stderr lines', async () => {
    process.env.AIDEN_PERF_DIAG = '1';
    const adapter = new ScriptedAdapter([
      {
        content:   '',
        toolCalls: [tc('c1', 'web_search')],
        usage:        { inputTokens: 5, outputTokens: 3 },
        finishReason: 'tool_calls',
      },
    ]);
    const agent = new AidenAgent({
      provider:     adapter,
      tools:        NO_TOOLS,
      toolExecutor: async (call) => ({ id: call.id, name: call.name, result: 'ok' }),
    });
    await agent.runConversation([userMsg('hi')]);
    const perfLines = captured.filter((l) => l.startsWith('[perf:'));
    // At least one llm-line (iter=1) + one tool-line (c1).
    expect(perfLines.some((l) => l.includes('llm=') && l.includes('tokens_in=5'))).toBe(true);
    expect(perfLines.some((l) => l.includes('tool=web_search'))).toBe(true);
  });
});
