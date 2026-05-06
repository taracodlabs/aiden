import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CodexResponsesAdapter } from '../../../providers/v4/codexResponsesAdapter';

/**
 * Phase 21 #6d — Codex SSE three-stage recovery, ported from Hermes
 * run_agent.py:5895-5917. The Codex backend regularly emits
 * `response.completed` with an empty output[] even when items were
 * streamed. Aiden must backfill from output_item.done events OR
 * synthesize from output_text.delta accumulation, not trust the empty
 * completed.output.
 */

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AIDEN_DEBUG_CODEX;
  vi.restoreAllMocks();
});

function sse(events: object[]): Response {
  const body =
    events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') +
    '\n\ndata: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function adapter() {
  return new CodexResponsesAdapter({
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: 'sk-test',
    model: 'gpt-5.3-codex',
    providerName: 'chatgpt-plus',
    maxRetries: 0,
  });
}

describe('Phase 21 #6d — Codex SSE recovery', () => {
  it('1. text-only response with output_item.added + output_item.done parses cleanly', async () => {
    globalThis.fetch = vi.fn(async () =>
      sse([
        { type: 'response.created', response: { status: 'in_progress', output: [] } },
        {
          type: 'response.output_item.added',
          item: { type: 'message', id: 'm1', role: 'assistant', content: [] },
        },
        { type: 'response.output_text.delta', item_id: 'm1', delta: 'hi back' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hi back' }],
          },
        },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'm1',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hi back' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ]),
    ) as never;

    const r = await adapter().call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(r.content).toBe('hi back');
  });

  it('2. backfill stage — completed.output empty, output_item.done collected', async () => {
    globalThis.fetch = vi.fn(async () =>
      sse([
        { type: 'response.created', response: { status: 'in_progress', output: [] } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'recovered' }],
          },
        },
        {
          type: 'response.completed',
          // ← Codex bug shape: completed event but output[] is empty.
          response: {
            status: 'completed',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ]),
    ) as never;

    const r = await adapter().call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(r.content).toBe('recovered');
  });

  it('3. synthesis stage — completed.output empty AND no output_item.done; only deltas', async () => {
    globalThis.fetch = vi.fn(async () =>
      sse([
        { type: 'response.created', response: { status: 'in_progress', output: [] } },
        { type: 'response.output_text.delta', item_id: '', delta: 'partial ' },
        { type: 'response.output_text.delta', item_id: '', delta: 'reply' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ]),
    ) as never;

    const r = await adapter().call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(r.content).toBe('partial reply');
  });

  it('4. response.incomplete (not completed) is treated as recoverable terminal', async () => {
    globalThis.fetch = vi.fn(async () =>
      sse([
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'partial answer' }],
          },
        },
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_tokens' },
            output: [],
          },
        },
      ]),
    ) as never;

    const r = await adapter().call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(r.content).toBe('partial answer');
  });

  it('5. AIDEN_DEBUG_CODEX=1 logs unknown event types instead of dropping silently', async () => {
    process.env.AIDEN_DEBUG_CODEX = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThis.fetch = vi.fn(async () =>
      sse([
        { type: 'response.unknown.future_event', payload: { foo: 'bar' } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'm1',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ]),
    ) as never;

    const r = await adapter().call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(r.content).toBe('ok');
    const warnings = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnings).toContain('response.unknown.future_event');
  });
});
