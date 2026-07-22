import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { MessageApiAdapter } from '../../../providers/v4/messageApiAdapter';

type Stage = 'before_headers' | 'after_headers' | 'after_event' | 'complete';
let server: Server | null = null;
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function fixture(stage: Stage) {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  server = createServer((_request, response) => {
    requests += 1;
    if (stage === 'before_headers') {
      release();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    if (stage === 'after_event') {
      response.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n');
    }
    release();
    if (stage === 'complete') {
      response.end(
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
        'data: {"type":"message_stop"}\n\n',
      );
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, ready, requests: () => requests };
}

function make(baseUrl: string): MessageApiAdapter {
  return new MessageApiAdapter({
    baseUrl,
    apiKey: 'fixture-key',
    model: 'fixture-model',
    providerName: 'fixture',
    connectionTimeoutMs: 60,
    firstByteTimeoutMs: 70,
    bodyIdleTimeoutMs: 80,
    totalTimeoutMs: 500,
    maxRetries: 0,
  });
}

async function consume(instance: MessageApiAdapter, signal?: AbortSignal): Promise<string> {
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

describe('MessageApiAdapter request lifecycle', () => {
  it.each([
    ['before_headers', 'connection_timeout'],
    ['after_headers', 'first_byte_timeout'],
    ['after_event', 'body_idle_timeout'],
  ] as const)('reports %s as %s', async (stage, phase) => {
    const current = await fixture(stage);
    await expect(consume(make(current.baseUrl))).rejects.toMatchObject({
      name: 'ProviderPhaseTimeoutError',
      phase,
    });
    if (stage !== 'before_headers') {
      expect(current.requests()).toBe(1);
    }
  });

  it('keeps cancellation attached after headers and body data', async () => {
    const current = await fixture('after_event');
    const cancellation = new AbortController();
    const pending = consume(make(current.baseUrl), cancellation.signal);
    await current.ready;
    cancellation.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('completes a normal streamed response', async () => {
    const current = await fixture('complete');
    await expect(consume(make(current.baseUrl))).resolves.toBe('ok');
  });
});
