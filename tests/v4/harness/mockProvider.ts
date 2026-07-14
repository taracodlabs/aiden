/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/harness/mockProvider.ts — v4.10 Slice 10.4.
 *
 * Minimal HTTP server speaking OpenAI-compatible
 * `/v1/chat/completions` with deterministic SSE streaming. Aiden
 * points at it via `CUSTOM_BASE_URL` + `CUSTOM_API_KEY`. Backs PTY
 * tests that need an LLM round-trip without provider-side latency,
 * rate limits, or chunk-timing nondeterminism.
 *
 * Scope-locked for Slice 10.4 smoke: streams a single fixed
 * response. Future slices add scriptable responses, tool-call
 * emission, delays-between-chunks, and error injection — building
 * on this skeleton.
 *
 * Wire shape (matches what the OpenAI-compat adapter expects):
 *   POST /v1/chat/completions  { stream: true, messages: [...] }
 *     → text/event-stream
 *     → data: {"choices":[{"delta":{"role":"assistant"}}]}
 *     → data: {"choices":[{"delta":{"content":"hello"}}]}
 *     → data: {"choices":[{"delta":{"content":" world"}}]}
 *     → data: {"choices":[{"finish_reason":"stop"}]}
 *     → data: [DONE]
 *
 * GET /v1/models returns a single-model list so model fetch
 * succeeds during wizard / setup paths if a test exercises them.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockProviderOptions {
  /** The text the mock streams back. Default: "hello from mock" */
  responseText?: string;
  /** Number of equal-sized chunks to split responseText into. Default: 4. */
  chunkCount?: number;
  /** Delay between chunks in ms. Default: 10. */
  chunkDelayMs?: number;
  /** Optional delay before response headers, for cancellation tests. */
  headerDelayMs?: number;
  /** Model id served + accepted. Default: "mock-model". */
  modelId?: string;
  /** Optional deterministic response per provider call. */
  script?: MockProviderTurn[];
}

export interface MockProviderTurn {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export interface MockProvider {
  /** Full base URL, e.g. http://127.0.0.1:54321 */
  baseUrl: string;
  /** Bound port. */
  port: number;
  /** Number of POST /v1/chat/completions calls received. */
  callCount(): number;
  /** Last seen request body (parsed JSON). */
  lastRequest(): unknown | null;
  /** Stop the server + wait for close. */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

export async function startMockProvider(
  opts: MockProviderOptions = {},
): Promise<MockProvider> {
  const responseText = opts.responseText ?? 'hello from mock';
  const chunkCount   = Math.max(1, opts.chunkCount ?? 4);
  const chunkDelay   = opts.chunkDelayMs ?? 10;
  const headerDelay  = opts.headerDelayMs ?? 0;
  const modelId      = opts.modelId ?? 'mock-model';
  const script       = opts.script;

  let callCount = 0;
  let lastRequest: unknown | null = null;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url?.startsWith('/v1/models') || req.url?.startsWith('/models'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ id: modelId, object: 'model', owned_by: 'mock' }],
      }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // Read body (small — single request, fits in memory).
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    await new Promise<void>((resolve) => req.on('end', resolve));
    try {
      lastRequest = JSON.parse(body);
    } catch {
      lastRequest = body;
    }
    const scriptedTurn = script?.[callCount];
    callCount += 1;

    if (headerDelay > 0) await sleep(headerDelay);
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    // Opening frame: role announcement.
    res.write(`data: ${JSON.stringify({
      id: 'mock-completion-1',
      object: 'chat.completion.chunk',
      model: modelId,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })}\n\n`);

    if (scriptedTurn?.toolCalls?.length) {
      await sleep(chunkDelay);
      res.write(`data: ${JSON.stringify({
        id: `mock-completion-${callCount}`,
        object: 'chat.completion.chunk',
        model: modelId,
        choices: [{
          index: 0,
          delta: {
            tool_calls: scriptedTurn.toolCalls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          },
          finish_reason: null,
        }],
      })}\n\n`);
    } else {
      const scriptedText = scriptedTurn?.content ?? responseText;
      const scriptedChunks: string[] = [];
      const scriptedChunkSize = Math.max(1, Math.ceil(scriptedText.length / chunkCount));
      for (let i = 0; i < scriptedText.length; i += scriptedChunkSize) {
        scriptedChunks.push(scriptedText.slice(i, i + scriptedChunkSize));
      }
      for (const c of scriptedChunks) {
        await sleep(chunkDelay);
        res.write(`data: ${JSON.stringify({
          id: `mock-completion-${callCount}`,
          object: 'chat.completion.chunk',
          model: modelId,
          choices: [{ index: 0, delta: { content: c }, finish_reason: null }],
        })}\n\n`);
      }
    }

    // Finish frame.
    await sleep(chunkDelay);
    res.write(`data: ${JSON.stringify({
      id: 'mock-completion-1',
      object: 'chat.completion.chunk',
      model: modelId,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: scriptedTurn?.toolCalls?.length ? 'tool_calls' : 'stop',
      }],
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const port = addr.port;

  return {
    baseUrl:      `http://127.0.0.1:${port}`,
    port,
    callCount:    () => callCount,
    lastRequest:  () => lastRequest,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
