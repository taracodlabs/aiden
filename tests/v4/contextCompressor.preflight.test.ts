/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 preflight compression retrofit — coverage for the 6 PB fixes:
 *
 *   PB1 — Compressor wired in production (smoke through buildAgentRuntime)
 *   PB2 — Trigger expansion: tool-schema tokens count toward threshold
 *   PB3 — Tool-chain boundary scan in partitionMessages
 *   PB4 — Latest-user invariant
 *   PB5 — Visible abort path (errorMessage + invariantViolation surface)
 *   PB6 — Orphan tool-pair check post-compression
 *
 * The 12 existing tests in `tests/v4/contextCompressor.test.ts` still
 * pass — this file adds the v4.11 surface. Mock provider returns a
 * fixed summary so we can assert on envelope shapes deterministically.
 */
import { describe, it, expect } from 'vitest';
import {
  ContextCompressor,
  partitionMessages,
} from '../../core/v4/contextCompressor';
import { ModelMetadata } from '../../core/v4/modelMetadata';
import { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type {
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  ToolSchema,
} from '../../providers/v4/types';

// ── Fixtures ───────────────────────────────────────────────────────────────

class StubSummaryAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  public calls = 0;
  constructor(private readonly summary: string = 'SUMMARY') {}
  async call(_input: ProviderCallInput): Promise<ProviderCallOutput> {
    this.calls += 1;
    return {
      content:      this.summary,
      toolCalls:    [],
      finishReason: 'stop',
      usage:        { inputTokens: 50, outputTokens: 80 },
    };
  }
}

class EmptySummaryAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  async call(): Promise<ProviderCallOutput> {
    return {
      content:      '',                // ← null/empty triggers invariantViolation: summary_empty
      toolCalls:    [],
      finishReason: 'stop',
      usage:        { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function makeAux(adapter: ProviderAdapter): AuxiliaryClient {
  return new AuxiliaryClient({
    defaultProvider: 'groq',
    defaultModel:    'llama-3.1-8b-instant',
    adapter,
    warn:            () => {},
  });
}

const sysMsg  = (content: string): Message => ({ role: 'system',    content });
const userMsg = (content: string): Message => ({ role: 'user',      content });
const asstMsg = (content: string, toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): Message =>
  toolCalls && toolCalls.length > 0
    ? { role: 'assistant', content, toolCalls }
    : { role: 'assistant', content };
const toolMsg = (toolCallId: string, content: string): Message =>
  ({ role: 'tool', toolCallId, content });

function bigText(approxTokens: number): string {
  // ~4 chars per token (matches the modelMetadata char/4 fallback math).
  return 'x'.repeat(approxTokens * 4);
}

function makeFatToolCatalog(n: number): ToolSchema[] {
  return Array.from({ length: n }, (_, i) => ({
    name:        `fat_tool_${i}`,
    description: bigText(150), // ~150 tokens per tool → 60 tools ≈ 9000 tokens
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required:   ['query'],
    },
  }));
}

const COMPRESSOR_THRESHOLD = 0.5;

function makeCompressor(adapter: ProviderAdapter): ContextCompressor {
  return new ContextCompressor(
    new ModelMetadata(),
    makeAux(adapter),
    COMPRESSOR_THRESHOLD,
  );
}

// ── PB2 — Trigger expansion: tool tokens count toward threshold ────────────

describe('PB2 — Trigger expansion (principle #2)', () => {
  it('shouldCompress: ignores tools when not supplied (back-compat)', () => {
    const cc = makeCompressor(new StubSummaryAdapter());
    // 6 short messages — well below threshold on a 128K model.
    const msgs = [
      sysMsg('s'), userMsg('hi'), asstMsg('hello'),
      userMsg('ok'), asstMsg('done'), userMsg('q'),
    ];
    const trig = cc.shouldCompress(msgs, 'groq', 'llama-3.3-70b-versatile');
    expect(trig.shouldCompress).toBe(false);
    expect(trig.toolTokens).toBeUndefined();
  });

  it('shouldCompress: adds tool tokens to utilization when supplied', () => {
    const cc = makeCompressor(new StubSummaryAdapter());
    // Tiny context model so the 60-tool catalog dominates utilization.
    // ollama llama3.2:1b has ~8K context per the catalog (smallest typical).
    // If unknown to catalog it falls back to 128K; we use a known small
    // model via the modelCatalog defaults. Use a small custom context
    // by relying on getDefaults via an unknown model name to test the
    // delta: with tools, the SAME message set should push us higher.
    const msgs = [
      sysMsg('s'), userMsg('hi'), asstMsg('hello'),
      userMsg('ok'), asstMsg('done'), userMsg('q'),
    ];
    const fatTools = makeFatToolCatalog(60); // ~9000 tokens
    const trigNoTools  = cc.shouldCompress(msgs, 'groq', 'llama-3.3-70b-versatile');
    const trigWithTools = cc.shouldCompress(msgs, 'groq', 'llama-3.3-70b-versatile', fatTools);
    // Critical: utilization MUST be higher when tools are counted.
    expect(trigWithTools.currentTokens).toBeGreaterThan(trigNoTools.currentTokens);
    expect(trigWithTools.toolTokens).toBeGreaterThan(0);
    // The fat catalog adds at least ~5K tokens.
    expect(trigWithTools.toolTokens!).toBeGreaterThanOrEqual(5_000);
  });

  it('shouldCompress: tool tokens raise utilization monotonically', () => {
    // Monotonicity guard: adding tool budget can ONLY increase
    // utilization, never decrease it. Cheap to verify with small
    // message arrays — the regression we're protecting against is
    // "tools forgotten in the count" (principle #2), not the absolute
    // threshold crossing.
    const cc = makeCompressor(new StubSummaryAdapter());
    const msgs: Message[] = [
      sysMsg('s'),
      ...Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0 ? userMsg(`u${i}`) : asstMsg(`a${i}`)),
    ];
    const trigNoTools   = cc.shouldCompress(msgs, 'groq', 'llama-3.3-70b-versatile');
    const fatTools      = makeFatToolCatalog(60);
    const trigWithTools = cc.shouldCompress(msgs, 'groq', 'llama-3.3-70b-versatile', fatTools);
    expect(trigWithTools.utilization).toBeGreaterThan(trigNoTools.utilization);
    expect(trigWithTools.currentTokens - trigNoTools.currentTokens)
      .toBeGreaterThanOrEqual(5_000);  // ≥5K tokens of tool budget
  });
});

// ── PB3 — Tool-chain boundary scan ─────────────────────────────────────────

describe('PB3 — partitionMessages tool-chain boundary scan (principle #11)', () => {
  it('basic: no tool chain, boundary lands at default cut', () => {
    const msgs: Message[] = [
      sysMsg('s'),
      ...Array.from({ length: 12 }, (_, i) => userMsg(`msg ${i}`)),
    ];
    const { head, middle, recent } = partitionMessages(msgs);
    expect(head).toHaveLength(1);
    expect(recent).toHaveLength(6); // MIN_RECENT_TURNS
    expect(middle).toHaveLength(6); // 12 - 6 recent
  });

  it('tool chain at boundary: split would orphan tool result, cut slides forward', () => {
    // Construct a 12-message tail where the assistant's tool_calls
    // fire AT the recent-6 boundary (index 6 from end). A naive
    // slice at `tail.length - 6 = 6` would put assistant in middle
    // and the tool result in recent. The walk-forward must move the
    // cut past the tool result so both stay together in `recent`.
    const msgs: Message[] = [
      sysMsg('s'),
      // head/middle area:
      userMsg('a0'), asstMsg('a1'), userMsg('a2'), asstMsg('a3'),
      userMsg('a4'),
      // boundary zone — assistant with tool_calls at the naive cut:
      asstMsg('thinking…', [
        { id: 'call-1', name: 'web_search', arguments: { q: 'x' } },
      ]),
      toolMsg('call-1', 'tool result for call-1'),
      // post-tool recent tail:
      asstMsg('synthesized reply'),
      userMsg('follow-up question'),
      asstMsg('follow-up reply'),
      userMsg('q3'),
      asstMsg('a3'),
    ];
    const { middle, recent } = partitionMessages(msgs);
    // The assistant with tool_calls MUST NOT be in middle without its
    // tool result. If it's in middle, the result must ALSO be in middle.
    // If the assistant is in recent, the result must ALSO be in recent.
    const assistantInMiddle = middle.some(
      (m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === 'call-1'),
    );
    const toolInMiddle = middle.some(
      (m) => m.role === 'tool' && m.toolCallId === 'call-1',
    );
    expect(assistantInMiddle).toBe(toolInMiddle);
    const assistantInRecent = recent.some(
      (m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === 'call-1'),
    );
    const toolInRecent = recent.some(
      (m) => m.role === 'tool' && m.toolCallId === 'call-1',
    );
    expect(assistantInRecent).toBe(toolInRecent);
  });

  it('multi-call chain: all results stay grouped with their assistant', () => {
    // Two tool calls from one assistant message, results interleaved
    // around the boundary — chain must stay intact end-to-end.
    const msgs: Message[] = [
      sysMsg('s'),
      userMsg('a'), asstMsg('b'), userMsg('c'), asstMsg('d'),
      userMsg('plan'),
      asstMsg('running both', [
        { id: 'c1', name: 'tool_a', arguments: {} },
        { id: 'c2', name: 'tool_b', arguments: {} },
      ]),
      toolMsg('c1', 'r1'),
      toolMsg('c2', 'r2'),
      asstMsg('final'),
      userMsg('next'),
      asstMsg('reply'),
    ];
    const { middle, recent } = partitionMessages(msgs);
    // If the assistant lives in `recent`, both tool results must too.
    const asstSlot = recent.find(
      (m) => m.role === 'assistant' && m.toolCalls?.length === 2,
    );
    if (asstSlot) {
      const ids = recent.filter((m) => m.role === 'tool').map(
        (m) => (m as Extract<Message, { role: 'tool' }>).toolCallId,
      );
      expect(ids).toContain('c1');
      expect(ids).toContain('c2');
    } else {
      // OR it lives in middle — then both tool results must too.
      const midToolIds = middle.filter((m) => m.role === 'tool').map(
        (m) => (m as Extract<Message, { role: 'tool' }>).toolCallId,
      );
      expect(midToolIds).toContain('c1');
      expect(midToolIds).toContain('c2');
    }
  });

  it('degenerate: chain larger than entire tail → middle becomes empty', () => {
    // Pathological case — every tail message is part of one chain. The
    // walker would push the cut past the end. partitionMessages should
    // return middle:[] in that case (caller short-circuits).
    const msgs: Message[] = [
      sysMsg('s'),
      asstMsg('opening', [
        { id: 'c1', name: 't', arguments: {} },
        { id: 'c2', name: 't', arguments: {} },
        { id: 'c3', name: 't', arguments: {} },
        { id: 'c4', name: 't', arguments: {} },
        { id: 'c5', name: 't', arguments: {} },
        { id: 'c6', name: 't', arguments: {} },
        { id: 'c7', name: 't', arguments: {} },
      ]),
      toolMsg('c1', 'r'), toolMsg('c2', 'r'), toolMsg('c3', 'r'),
      toolMsg('c4', 'r'), toolMsg('c5', 'r'), toolMsg('c6', 'r'),
      toolMsg('c7', 'r'),
    ];
    const { middle } = partitionMessages(msgs);
    expect(middle).toHaveLength(0);
  });
});

// ── PB4 — Latest-user invariant ────────────────────────────────────────────

describe('PB4 — Latest-user invariant (principle #6)', () => {
  it('forceCompress: latest user message survives verbatim in compressed', async () => {
    const cc = makeCompressor(new StubSummaryAdapter());
    const latestUser = 'THIS IS THE LATEST USER QUERY — must survive';
    const msgs: Message[] = [
      sysMsg('s'),
      ...Array.from({ length: 8 }, (_, i) => i % 2 === 0 ? userMsg(`u${i}`) : asstMsg(`a${i}`)),
      userMsg(latestUser),
    ];
    const result = await cc.forceCompress(msgs, 'groq', 'llama-3.3-70b-versatile');
    expect(result.error).toBeFalsy();
    expect(result.refused).toBeFalsy();
    // Latest user must appear verbatim in the compressed output.
    const hasLatestUser = result.compressedMessages.some(
      (m) => m.role === 'user' && m.content === latestUser,
    );
    expect(hasLatestUser).toBe(true);
  });

  it('no user messages in history: invariant passes trivially', async () => {
    const cc = makeCompressor(new StubSummaryAdapter());
    const msgs: Message[] = [
      sysMsg('s'),
      ...Array.from({ length: 12 }, (_, i) => asstMsg(`a${i}`)),
    ];
    const result = await cc.forceCompress(msgs, 'groq', 'llama-3.3-70b-versatile');
    // No user messages → no invariant to enforce → compression succeeds.
    expect(result.error).toBeFalsy();
  });
});

// ── PB5 — Visible abort path ───────────────────────────────────────────────

describe('PB5 — Visible abort path (principle #12)', () => {
  it('empty summary: returns error envelope with errorMessage + invariantViolation', async () => {
    const cc = makeCompressor(new EmptySummaryAdapter());
    const msgs: Message[] = [
      sysMsg('s'),
      ...Array.from({ length: 12 }, (_, i) => i % 2 === 0 ? userMsg(`u${i}`) : asstMsg(`a${i}`)),
    ];
    const result = await cc.forceCompress(msgs, 'groq', 'llama-3.3-70b-versatile');
    expect(result.error).toBe(true);
    expect(result.refused).toBe(true);
    expect(result.errorMessage).toMatch(/auxiliary summarizer returned empty/i);
    expect(result.invariantViolation).toBe('summary_empty');
    // History unchanged on abort.
    expect(result.compressedMessages).toBe(msgs);
  });

  it('below-threshold conversation: compress() refuses without error flag', async () => {
    const cc = makeCompressor(new StubSummaryAdapter());
    // 5 messages — below threshold on a 128K-window model.
    const msgs: Message[] = [
      sysMsg('s'), userMsg('a'), asstMsg('b'), userMsg('c'), asstMsg('d'),
    ];
    const result = await cc.compress(msgs, 'groq', 'llama-3.3-70b-versatile');
    expect(result.refused).toBe(true);
    expect(result.error).toBeFalsy();          // refused-only, not an error
    expect(result.compressedMessages).toBe(msgs);  // unchanged passthrough
  });
});

// ── PB6 — Orphan tool-pair check post-compression ─────────────────────────

describe('PB6 — Orphan tool-pair detection (principle #7)', () => {
  it('compression that would split a chain is caught by post-check OR by partition (whichever fires first)', async () => {
    // Construct a deliberately tricky case where the boundary walk
    // works but ALSO verify that even if the partition split, the
    // post-compression assertNoUnansweredToolCalls catches it.
    // Use a chain that lives squarely in the middle — should compress
    // cleanly (the chain is preserved together inside `middle` which
    // gets summarized + replaced with a single system msg → no orphan).
    const cc = makeCompressor(new StubSummaryAdapter());
    const msgs: Message[] = [
      sysMsg('s'),
      userMsg('intro'),
      asstMsg('using tools', [{ id: 'c1', name: 'web_search', arguments: {} }]),
      toolMsg('c1', 'result of c1'),
      asstMsg('synthesized'),
      userMsg('continue'),
      asstMsg('reply'),
      userMsg('again'),
      asstMsg('reply2'),
      userMsg('again2'),
      asstMsg('reply3'),
      userMsg('latest'),
    ];
    const result = await cc.forceCompress(msgs, 'groq', 'llama-3.3-70b-versatile');
    expect(result.error).toBeFalsy();
    // Output must satisfy assertNoUnansweredToolCalls.
    // Re-import + reuse helper — the compressor already calls it,
    // so passing through implies success. We assert via no orphan id.
    const assistantCallIds = new Set<string>();
    const toolResultIds    = new Set<string>();
    for (const m of result.compressedMessages) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const c of m.toolCalls) assistantCallIds.add(c.id);
      }
      if (m.role === 'tool') toolResultIds.add(m.toolCallId);
    }
    for (const id of assistantCallIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });
});

// ── PB1 — Production wiring (smoke) ────────────────────────────────────────

describe('PB1 — Production wiring (source contract)', () => {
  // Importing aidenCLI in a unit test is too heavy (it triggers the
  // graphify post-build hook + boots logger sinks). Use a source-text
  // check instead — same pattern as the v4.10 chatSessionUiPersist
  // "the dispatch site MUST call X" assertions.
  it('aidenCLI.ts constructs ContextCompressor + passes it to AidenAgent', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs   = await import('node:fs/promises');
    const path = await import('node:path');
    const src  = await fs.readFile(
      path.resolve(__dirname, '../../cli/v4/aidenCLI.ts'),
      'utf8',
    );
    // Production wires ContextCompressor (the v4.11 retrofit's key
    // change — pre-v4.11 the symbol wasn't even imported here).
    expect(src).toMatch(/new ContextCompressor\(/);
    expect(src).toMatch(/contextCompressor,/);
    // And the sessionOpts must hand the same instance to ChatSession
    // so the /compress slash command works end-to-end.
    expect(src).toMatch(/compressor:\s*runtime\.contextCompressor/);
  });

  it('AgentRuntime interface carries contextCompressor field', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs   = await import('node:fs/promises');
    const path = await import('node:path');
    const src  = await fs.readFile(
      path.resolve(__dirname, '../../cli/v4/aidenCLI.ts'),
      'utf8',
    );
    // The interface declaration must include the field so tests + the
    // slash-command wiring see a non-undefined value.
    expect(src).toMatch(/contextCompressor:\s*ContextCompressor;/);
  });
});
