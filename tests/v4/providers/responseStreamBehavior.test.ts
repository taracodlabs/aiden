import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ResponseStreamAdapter } from '../../../providers/v4/responseStreamAdapter';

/**
 * Phase 21 #6c — the subscription response endpoint requires `stream: true`.
 * Sending stream:false (or omitting it) returns HTTP 400
 * "Stream must be set to true." Aiden always streams this backend
 * and aggregates SSE frames internally so callers see the same JSON
 * shape they get from non-streaming providers.
 */

let originalFetch: typeof globalThis.fetch;
let captured: { url?: string; headers?: any; body?: any };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  captured = {};
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Build a minimal SSE response with response.completed carrying a final shape. */
function sseResponse(events: object[]): Response {
  const body =
    events
      .map((e) => `data: ${JSON.stringify(e)}`)
      .join('\n\n') + '\n\ndata: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(obj: object): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function adapter(baseUrl: string) {
  return new ResponseStreamAdapter({
    baseUrl,
    apiKey: 'sk-test',
    model: 'gpt-5.3-codex',
    providerName: 'chatgpt-plus',
    maxRetries: 0,
  });
}

describe('Phase 21 #6c — subscription response backend always streams', () => {
  it('1. request body sets stream:true for the subscription response backend', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      captured.url = String(url);
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      return sseResponse([
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hi back' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ]);
    }) as never;

    const a = adapter('https://chatgpt.com/backend-api/codex');
    const r = await a.call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(captured.body.stream).toBe(true);
    expect(r.content).toBe('hi back');
    expect(r.finishReason).toBe('stop');
  });

  it('2. regular baseUrl does NOT set stream:true (standard Responses API path uses JSON)', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      // Standard path expects JSON response — adapter calls response.json().
      return jsonResponse({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'plain' }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as never;

    const a = adapter('https://api.openai.com/v1');
    const r = await a.call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(captured.body.stream).toBeUndefined();
    expect(r.content).toBe('plain');
  });

  it('3. SSE aggregator collects output_text.delta events when response.completed lacks fully-formed content', async () => {
    globalThis.fetch = vi.fn(async () => {
      // Stream where the message item is added but its text comes via
      // delta events; response.completed at the end has the final shape
      // with content already merged.
      return sseResponse([
        {
          type: 'response.created',
          response: { status: 'in_progress', output: [] },
        },
        {
          type: 'response.output_item.added',
          item: {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [],
          },
        },
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'hello ' },
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'world' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg_1',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hello world' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ]);
    }) as never;

    const a = adapter('https://chatgpt.com/backend-api/codex');
    const r = await a.call({
      messages: [{ role: 'user', content: 'say hi' }],
      tools: [],
    });
    expect(r.content).toBe('hello world');
    expect(r.usage.outputTokens).toBe(2);
  });
});
