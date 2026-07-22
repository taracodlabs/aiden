import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import { ProviderPhaseTimeoutError } from '../../../providers/v4/errors';

type StallStage = 'before_headers' | 'after_headers' | 'after_event';
type ServerStage = StallStage | 'complete' | 'rate_limit_once' | 'rate_limit_wait';

let server: Server | null = null;
const sockets = new Set<Socket>();

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function startServer(stage: ServerStage): Promise<{
  baseUrl: string;
  ready: Promise<void>;
  requests: () => number;
}> {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  let requestCount = 0;
  server = createServer((_request, response) => {
    requestCount += 1;
    if ((stage === 'rate_limit_once' || stage === 'rate_limit_wait') && requestCount === 1) {
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': stage === 'rate_limit_wait' ? '30' : '2',
      });
      response.end('{"error":{"message":"rate limited"}}');
      resolveReady();
      return;
    }
    if (stage === 'before_headers') {
      resolveReady();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    if (stage === 'after_event') {
      response.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    }
    resolveReady();
    if (stage === 'complete' || stage === 'rate_limit_once') {
      response.end(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
        'data: [DONE]\n\n',
      );
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, ready, requests: () => requestCount };
}

function adapter(
  baseUrl: string,
  maxRetries = 0,
  deadlines: Partial<{
    connectionTimeoutMs: number;
    firstByteTimeoutMs: number;
    bodyIdleTimeoutMs: number;
    totalTimeoutMs: number;
  }> = {},
): ChatCompletionsAdapter {
  return new ChatCompletionsAdapter({
    baseUrl,
    apiKey: 'fixture-key',
    model: 'fixture-model',
    providerName: 'fixture',
    connectionTimeoutMs: deadlines.connectionTimeoutMs ?? 70,
    firstByteTimeoutMs: deadlines.firstByteTimeoutMs ?? 80,
    bodyIdleTimeoutMs: deadlines.bodyIdleTimeoutMs ?? 90,
    totalTimeoutMs: deadlines.totalTimeoutMs ?? 500,
    maxRetries,
  });
}

async function consume(instance: ChatCompletionsAdapter, signal?: AbortSignal): Promise<string> {
  let content = '';
  for await (const event of instance.callStream({
    messages: [{ role: 'user', content: 'continue' }],
    tools: [],
    signal,
  })) {
    if (event.type === 'delta') content += event.content;
  }
  return content;
}

describe('ChatCompletionsAdapter request lifecycle', () => {
  it.each([
    ['before_headers', 'connection_timeout'],
    ['after_headers', 'first_byte_timeout'],
    ['after_event', 'body_idle_timeout'],
  ] as const)('reports the exact phase when stalled at %s', async (stage, phase) => {
    const fixture = await startServer(stage);
    if (stage === 'before_headers') {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    }
    const pending = consume(adapter(fixture.baseUrl, 0, {
      connectionTimeoutMs: stage === 'before_headers' ? 70 : 5_000,
      firstByteTimeoutMs: stage === 'after_headers' ? 80 : 5_000,
      totalTimeoutMs: 10_000,
    }));
    const rejection = pending.catch((error: unknown) => error);
    await fixture.ready;
    if (stage === 'before_headers') {
      await vi.advanceTimersByTimeAsync(70);
    }
    await expect(rejection).resolves.toMatchObject({
      name: 'ProviderPhaseTimeoutError',
      phase,
    });
    expect(fixture.requests()).toBe(1);
  });

  it.each<StallStage>(['before_headers', 'after_headers', 'after_event'])(
    'keeps external cancellation connected at %s',
    async (stage) => {
      const fixture = await startServer(stage);
      const cancellation = new AbortController();
      const pending = consume(adapter(fixture.baseUrl), cancellation.signal);
      await fixture.ready;
      cancellation.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(fixture.requests()).toBe(1);
    },
  );

  it('completes a normal response and removes the external abort listener once', async () => {
    const fixture = await startServer('complete');
    const cancellation = new AbortController();
    const add = vi.spyOn(cancellation.signal, 'addEventListener');
    const remove = vi.spyOn(cancellation.signal, 'removeEventListener');
    await expect(consume(adapter(fixture.baseUrl), cancellation.signal)).resolves.toBe('ok');
    expect(add.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
    expect(remove.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
  });

  it('does not retry after response body consumption starts', async () => {
    const fixture = await startServer('after_event');
    await expect(consume(adapter(fixture.baseUrl, 2))).rejects.toBeInstanceOf(ProviderPhaseTimeoutError);
    expect(fixture.requests()).toBe(1);
  });

  it('honours Retry-After before retrying a pre-body rate limit', async () => {
    const fixture = await startServer('rate_limit_once');
    const started = performance.now();
    await expect(consume(adapter(fixture.baseUrl, 1))).resolves.toBe('ok');
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(fixture.requests()).toBe(2);
  });

  it('keeps external cancellation connected during Retry-After', async () => {
    const fixture = await startServer('rate_limit_wait');
    const cancellation = new AbortController();
    const started = Date.now();
    const pending = consume(adapter(fixture.baseUrl, 1), cancellation.signal);
    await fixture.ready;
    cancellation.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(fixture.requests()).toBe(1);
  });
});
