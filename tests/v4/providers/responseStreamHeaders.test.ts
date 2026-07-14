import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  ResponseStreamAdapter,
  extractResponseAccountId,
} from '../../../providers/v4/responseStreamAdapter';

/**
 * Phase 21 #6 reopen — compatibility headers required by the
 * subscription response endpoint.
 *
 * Without these headers the backend rejects otherwise entitled models.
 * These tests pin the required wire contract so a future cleanup does not
 * strip compatibility fields.
 */

// Build a minimal JWT (header.payload.signature) with the account-id
// claim. We never verify signatures — adapter just decodes the payload.
function makeJwt(payload: object): string {
  const b64 = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`;
}

describe('extractResponseAccountId', () => {
  it('1. extracts the account id from the auth claim', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_abc123' },
    });
    expect(extractResponseAccountId(token)).toBe('acct_abc123');
  });

  it('2. returns null on malformed JWT (no crash)', () => {
    expect(extractResponseAccountId('')).toBeNull();
    expect(extractResponseAccountId(null)).toBeNull();
    expect(extractResponseAccountId('not-a-jwt')).toBeNull();
    expect(extractResponseAccountId('a.b.c')).toBeNull(); // valid shape, garbage payload
    expect(extractResponseAccountId(makeJwt({ unrelated: 'claim' }))).toBeNull();
  });
});

describe('ResponseStreamAdapter — subscription backend headers (Phase 21 #6)', () => {
  let originalFetch: typeof globalThis.fetch;
  let captured: { url?: string; headers?: any; body?: any };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = {};
    globalThis.fetch = vi.fn(async (url, init) => {
      captured.url = String(url);
      captured.headers = init?.headers ?? {};
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      // Minimal response. Subscription backend → SSE (Phase 21 #6c
      // always-stream contract). Standard baseUrl → plain JSON. Tests pass the
      // baseUrl through callWith() so we route on captured.url.
      const isStreamingEndpoint = String(url).includes('chatgpt.com/backend-api/codex');
      const finalShape = {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (isStreamingEndpoint) {
        const evt = { type: 'response.completed', response: finalShape };
        return new Response(
          `data: ${JSON.stringify(evt)}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify(finalShape), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as never;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function callWith(baseUrl: string, token: string) {
    const adapter = new ResponseStreamAdapter({
      baseUrl,
      apiKey: token,
      model: 'gpt-5.3-codex',
      providerName: 'chatgpt-plus',
      maxRetries: 0,
    });
    return adapter.call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 1024,
    });
  }

  it('3. sends required compatibility headers for the subscription backend', async () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_xyz' },
    });
    await callWith('https://chatgpt.com/backend-api/codex', token);
    expect(captured.headers['User-Agent']).toBe('codex_cli_rs/0.0.0 (Aiden Agent)');
    expect(captured.headers['originator']).toBe('codex_cli_rs');
    expect(captured.headers['ChatGPT-Account-ID']).toBe('acct_xyz');
  });

  it('4. omits max_output_tokens for the subscription backend', async () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_xyz' },
    });
    await callWith('https://chatgpt.com/backend-api/codex', token);
    expect(captured.body.max_output_tokens).toBeUndefined();
  });

  it('5. does not send compatibility headers to the standard API backend', async () => {
    await callWith('https://api.openai.com/v1', 'sk-test-not-a-jwt');
    // No special UA/originator/account-id on the standard backend —
    // a regular OpenAI API call uses the standard SDK contract.
    expect(captured.headers['originator']).toBeUndefined();
    expect(captured.headers['ChatGPT-Account-ID']).toBeUndefined();
    // Default User-Agent is fine here (whatever fetch sends, we don't override).
    expect(captured.headers['User-Agent']).toBeUndefined();
    // max_output_tokens is sent for standard backends.
    expect(captured.body.max_output_tokens).toBe(1024);
  });
});
