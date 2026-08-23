/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { StdioTransport, StreamableHttpTransport } from '../../../core/v4/mcp/transport';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter & { setEncoding: (encoding: string) => void };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  };
  child.stdin = new Writable({ write: (_chunk, _encoding, done) => done() });
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  return child;
}

function spawnFactory(child: ReturnType<typeof fakeChild>) {
  return (() => child) as unknown as typeof import('node:child_process').spawn;
}

function response(body: ReadableStream<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body,
  } as Response;
}

describe('MCP hostile transport bounds', () => {
  it('terminates an unterminated stdio frame once its byte budget is exceeded', async () => {
    const child = fakeChild();
    const killed: NodeJS.Signals[] = [];
    const transport = new StdioTransport({
      command: 'fixture', args: [], spawnFn: spawnFactory(child), maxFrameBytes: 64,
      killTreeFn: (_proc, signal) => { killed.push(signal); child.emit('exit', 1, signal); },
    });
    const pending = transport.request('tools/list', undefined, { timeoutMs: 1_000 });
    child.stdout.emit('data', 'x'.repeat(65));
    await expect(pending).rejects.toThrow(/frame exceeds 64 bytes/i);
    expect(killed).toEqual(['SIGTERM']);
  });

  it('enforces the per-request response budget for a complete stdio frame', async () => {
    const child = fakeChild();
    const transport = new StdioTransport({ command: 'fixture', args: [], spawnFn: spawnFactory(child) });
    const pending = transport.request('tools/list', undefined, { maxResponseBytes: 64 });
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 'x'.repeat(100) } })}\n`);
    await expect(pending).rejects.toThrow(/response exceeds 64 bytes/i);
    child.emit('exit', 0, null);
  });

  it('rejects an oversized streamable HTTP SSE event before JSON parsing', async () => {
    const bytes = new TextEncoder().encode(`data: ${'x'.repeat(129)}\n\n`);
    const fetchFn = async () => response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
    const transport = new StreamableHttpTransport({ baseUrl: 'https://mcp.example.test', fetchFn: fetchFn as typeof fetch });
    await expect(transport.request('tools/list', undefined, { maxResponseBytes: 128 })).rejects.toThrow(/event exceeds 128 bytes/i);
    await transport.close();
  });
});
