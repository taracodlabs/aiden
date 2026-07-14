import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { ResponseStreamAdapter } from '../../../providers/v4/responseStreamAdapter';
import { ProviderTimeoutError } from '../../../providers/v4/errors';

type StallStage = 'before_headers' | 'after_headers' | 'after_event';

let server: Server | null = null;
const sockets = new Set<Socket>();
const nativeFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = nativeFetch;
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function startStallServer(stage: StallStage | 'complete'): Promise<{
  baseUrl: string;
  stageReady: Promise<void>;
  requestCount: () => number;
}> {
  let markReady!: () => void;
  const stageReady = new Promise<void>((resolve) => { markReady = resolve; });
  let requests = 0;

  server = createServer((_req, res) => {
    requests += 1;
    if (stage === 'before_headers') {
      markReady();
      setTimeout(() => res.socket?.destroy(), 2_000).unref();
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    if (stage === 'after_event') {
      res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    }
    markReady();

    if (stage === 'complete') {
      res.end(
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
        'data: [DONE]\n\n',
      );
      return;
    }

    // Test watchdog only: a broken adapter must eventually settle so the RED
    // suite cannot leave an open reader forever. Correct timeout/abort paths
    // finish well before this socket destruction.
    setTimeout(() => res.socket?.destroy(), 2_000).unref();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, stageReady, requestCount: () => requests };
}

function adapter(baseUrl: string, timeoutMs: number, maxRetries = 0): ResponseStreamAdapter {
  globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) =>
    nativeFetch(`${baseUrl}/responses`, init)) as typeof fetch;
  return new ResponseStreamAdapter({
    // Select the production streaming path. The fetch wrapper above redirects
    // only the transport destination to the real local HTTP fixture.
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: 'test-key',
    model: 'test-model',
    providerName: 'chatgpt-plus',
    timeoutMs,
    maxRetries,
  });
}

function call(a: ResponseStreamAdapter, signal?: AbortSignal) {
  return a.call({ messages: [{ role: 'user', content: 'continue' }], tools: [], signal });
}

describe('ResponseStreamAdapter full-lifecycle timeout and abort', () => {
  it.each<StallStage>(['before_headers', 'after_headers', 'after_event'])(
    'times out while stalled at %s',
    async (stage) => {
      const fixture = await startStallServer(stage);
      const started = Date.now();
      await expect(call(adapter(fixture.baseUrl, 500))).rejects.toBeInstanceOf(ProviderTimeoutError);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(fixture.requestCount()).toBe(1);
    },
  );

  it.each<StallStage>(['before_headers', 'after_headers', 'after_event'])(
    'honours external cancellation while stalled at %s',
    async (stage) => {
      const fixture = await startStallServer(stage);
      const abort = new AbortController();
      const pending = call(adapter(fixture.baseUrl, 2_000), abort.signal);
      await fixture.stageReady;
      // Ensure fetch has observed the flushed response headers and entered
      // body consumption for the post-header cases.
      await new Promise((resolve) => setTimeout(resolve, 30));
      abort.abort();
      const started = Date.now();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(Date.now() - started).toBeLessThan(250);
      expect(fixture.requestCount()).toBe(1);
    },
  );

  it('still consumes a normal complete SSE response', async () => {
    const fixture = await startStallServer('complete');
    const result = await call(adapter(fixture.baseUrl, 500));
    expect(result.content).toBe('ok');
    expect(fixture.requestCount()).toBe(1);
  });

  it('cleans its one timer and abort listener exactly once after body completion', async () => {
    const fixture = await startStallServer('complete');
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');

    await call(adapter(fixture.baseUrl, 987_654), abort.signal);

    const lifecycleTimer = setTimer.mock.results[
      setTimer.mock.calls.findIndex((args) => args[1] === 987_654)
    ]?.value;
    expect(lifecycleTimer).toBeDefined();
    expect(clearTimer.mock.calls.filter(([handle]) => handle === lifecycleTimer)).toHaveLength(1);
    expect(add.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
    expect(remove.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
  });

  it('cleans its timer and abort listener exactly once after body timeout', async () => {
    const fixture = await startStallServer('after_event');
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');

    await expect(call(adapter(fixture.baseUrl, 73), abort.signal))
      .rejects.toBeInstanceOf(ProviderTimeoutError);

    const lifecycleTimer = setTimer.mock.results[
      setTimer.mock.calls.findIndex((args) => args[1] === 73)
    ]?.value;
    expect(lifecycleTimer).toBeDefined();
    expect(clearTimer.mock.calls.filter(([handle]) => handle === lifecycleTimer)).toHaveLength(1);
    expect(add.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
    expect(remove.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
  });

  it('cleans its timer and abort listener exactly once after body cancellation', async () => {
    const fixture = await startStallServer('after_event');
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');

    const pending = call(adapter(fixture.baseUrl, 876_543), abort.signal);
    await fixture.stageReady;
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const lifecycleTimer = setTimer.mock.results[
      setTimer.mock.calls.findIndex((args) => args[1] === 876_543)
    ]?.value;
    expect(lifecycleTimer).toBeDefined();
    expect(clearTimer.mock.calls.filter(([handle]) => handle === lifecycleTimer)).toHaveLength(1);
    expect(add.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
    expect(remove.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
  });

  it('does not retry a request whose SSE body already started', async () => {
    const fixture = await startStallServer('after_event');
    await expect(call(adapter(fixture.baseUrl, 60, 2))).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(fixture.requestCount()).toBe(1);
  });
});
