/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.9 — streaming-end-to-end contract eval.
 *
 * Closes the gap that the Slice 10.6c perf diagnosis surfaced: the
 * user's "Aiden feels slow" complaint traced back to streaming being
 * silently disabled at the wizard layer. Pre-10.9 there was NO
 * end-to-end test asserting that when streaming IS enabled, the
 * adapter actually yields multiple `delta` events during a real
 * provider call. Unit tests of SSE parsing exist but they don't drive
 * the full path from a real HTTP server through the adapter's
 * `callStream` generator.
 *
 * Approach: spin up the existing `mockProvider` (Slice 10.4 harness)
 * which speaks OpenAI-compat SSE with configurable chunk count +
 * delays. Construct a real `ChatCompletionsAdapter` pointing at it.
 * Iterate `callStream` and assert N>1 delta events PLUS a terminal
 * `done` event carrying the concatenated content.
 *
 * The adapter's `callStream` is an AsyncGenerator yielding
 * `StreamEvent`; the agent layer (AidenAgent.runConversation)
 * wraps that generator and re-emits as `onDelta` / `onToolCallStart`
 * / `onProgress` callbacks. Existing PTY tests exercise the agent
 * wrapper; this file pins the LOWER-LEVEL adapter contract so a
 * regression in either layer fails the right test.
 *
 * Cost: ~250ms per run (mockProvider boot + adapter dispatch +
 * teardown). mockProvider grabs a random free port so the file
 * could in principle run concurrent with other PTY tests; we keep
 * it serial within the file because beforeAll/afterAll share one
 * mock instance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { startMockProvider, type MockProvider } from '../harness/mockProvider';
import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import type { StreamEvent, ProviderCallInput } from '../../../providers/v4/types';

let mock: MockProvider;

beforeAll(async () => {
  mock = await startMockProvider({
    responseText: 'one two three four five six seven',
    chunkCount:   6,
    chunkDelayMs: 5,
    modelId:      'mock-streaming',
  });
});

afterAll(async () => {
  await mock.stop();
});

function makeInput(extra: Partial<ProviderCallInput> = {}): ProviderCallInput {
  return {
    messages: [{ role: 'user', content: 'stream me a sentence' }],
    tools:    [],
    stream:   true,
    ...extra,
  };
}

describe('streaming-end-to-end — adapter callStream yields multiple deltas (Slice 10.9)', () => {
  it('callStream yields delta events repeatedly + concatenates to full response', async () => {
    // mockProvider auto-appends `/v1` only if the path includes it;
    // the adapter strips trailing slashes and appends `/chat/completions`.
    // The harness already handles both shapes — see mockProvider.ts
    // header comment. Pointing baseUrl at the mock's /v1 path is the
    // production shape (OpenAI-compat adapters target a base ending
    // in /v1 by convention).
    const adapter = new ChatCompletionsAdapter({
      baseUrl:      `${mock.baseUrl}/v1`,
      apiKey:       'mock-key',
      model:        'mock-streaming',
      providerName: 'mock',
    });

    const events: StreamEvent[] = [];
    for await (const evt of adapter.callStream(makeInput())) {
      events.push(evt);
    }

    // Contract assertions:
    // 1. Multiple delta events fired (the "streaming" guarantee).
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(1);

    // 2. Concatenated delta content matches the mock's response.
    const reconstructed = deltas.map((d) => (d as { content: string }).content).join('');
    expect(reconstructed).toBe('one two three four five six seven');

    // 3. Terminal `done` event carries the final ProviderCallOutput.
    const done = events.find((e) => e.type === 'done') as { type: 'done'; output: { content: string; finishReason: string } } | undefined;
    expect(done).toBeDefined();
    expect(done!.output.content).toBe('one two three four five six seven');
    expect(done!.output.finishReason).toBe('stop');

    // 4. mockProvider received the call with stream:true.
    expect(mock.callCount()).toBeGreaterThan(0);
    const req = mock.lastRequest() as { stream?: boolean } | null;
    expect(req?.stream).toBe(true);
  });

  it('source-contract guard — chatCompletionsAdapter.ts callStream exists + AsyncGenerator-shaped', async () => {
    // The streaming guarantee depends on callStream remaining an
    // AsyncGenerator yielding StreamEvent. A refactor that converts
    // the generator into a callback-shaped API would break the
    // assertion above (and break the agent's iterator wrapper at
    // aidenAgent.ts:1721-1725). This source-level check catches
    // that class of regression even if mockProvider drifts.
    //
    // NOTE on the non-streaming-counterpart test we considered but
    // didn't ship: mockProvider always returns SSE regardless of
    // the request's `stream` flag (it's a streaming-specific harness
    // from Slice 10.4). The non-streaming `call()` path is exercised
    // by the dispatcher unit tests + ollamaPromptTools.real
    // integration (baseline-failing today, unrelated). Adding a
    // mockProvider-backed counterpart would require teaching the
    // mock about non-streaming responses — out of scope for this
    // slice; pin the streaming surface where the v4.10 perception
    // bug actually lived.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../providers/v4/chatCompletionsAdapter.ts'),
      'utf8',
    );
    // AsyncGenerator declaration shape: `async *callStream(...)`.
    expect(src).toMatch(/async\s*\*\s*callStream\s*\(/);
    // The yielded events must include the delta variant; otherwise
    // streaming silently degrades to a single done-event emission.
    expect(src).toMatch(/yield[^;]*type:\s*['"]delta['"]/);
  });
});
