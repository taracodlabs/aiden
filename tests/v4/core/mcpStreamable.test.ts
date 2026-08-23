/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 3c.1 — Streamable HTTP transport (request/response core):
 * JSON vs SSE-body reply, Mcp-Session-Id capture/echo, 404→re-init→retry-once,
 * auth merge + 401-retry, and buildTransport selection (streamable default / sse legacy).
 */
import { describe, it, expect, vi } from 'vitest';
import { StreamableHttpTransport, type McpTransport } from '../../../core/v4/mcp/transport';
import { createMcpClient } from '../../../core/v4/mcpClient';
import { ToolRegistry } from '../../../core/v4/toolRegistry';

function headersOf(map: Record<string, string>) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (k: string) => lower.get(k.toLowerCase()) ?? null };
}
function jsonRes(obj: unknown, opts: { status?: number; sessionId?: string } = {}) {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sessionId) h['mcp-session-id'] = opts.sessionId;
  const status = opts.status ?? 200;
  return { ok: status < 400, status, statusText: '', headers: headersOf(h), json: async () => obj };
}
function streamFrom(text: string): ReadableStream<Uint8Array> {
  const data = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { c.enqueue(data); c.close(); } });
}
function sseRes(frames: unknown[], opts: { sessionId?: string } = {}) {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
  const h: Record<string, string> = { 'content-type': 'text/event-stream' };
  if (opts.sessionId) h['mcp-session-id'] = opts.sessionId;
  return { ok: true, status: 200, statusText: '', headers: headersOf(h), body: streamFrom(text) };
}
function fakeFetch(responder: (callIndex: number, body: { id?: number; method?: string }) => unknown) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: { id?: number; method?: string } }> = [];
  const fn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    return responder(calls.length - 1, body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('StreamableHttpTransport — request/response', () => {
  it('JSON reply: single application/json response resolves the request', async () => {
    const { fn, calls } = fakeFetch((_i, b) => jsonRes({ jsonrpc: '2.0', id: b.id, result: { ok: true } }));
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn });
    expect(await t.request('initialize', {})).toEqual({ ok: true });
    expect(calls[0].url).toBe('http://x/mcp'); // single endpoint
    expect(calls[0].headers.Accept).toContain('text/event-stream');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    await t.close();
  });

  it('SSE body: id-matching frame resolves; id-less frame → onNotification', async () => {
    const captured: Array<[string, unknown]> = [];
    const { fn } = fakeFetch((i, b) =>
      i === 0
        ? jsonRes({ jsonrpc: '2.0', id: b.id, result: {} }, { sessionId: 'S1' })
        : sseRes([
            { jsonrpc: '2.0', method: 'notifications/progress', params: { pct: 50 } },
            { jsonrpc: '2.0', id: b.id, result: { done: true } },
          ]),
    );
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn });
    t.onNotification((m, p) => captured.push([m, p]));
    await t.request('initialize', {});
    expect(await t.request('tools/call', {})).toEqual({ done: true });
    expect(captured).toEqual([['notifications/progress', { pct: 50 }]]);
    await t.close();
  });

  it('captures Mcp-Session-Id from initialize and echoes it on later requests', async () => {
    const { fn, calls } = fakeFetch((i, b) =>
      jsonRes({ jsonrpc: '2.0', id: b.id, result: {} }, i === 0 ? { sessionId: 'SESS-9' } : {}),
    );
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn });
    await t.request('initialize', {});
    await t.request('tools/list', {});
    expect(calls[0].headers['Mcp-Session-Id']).toBeUndefined(); // none yet on initialize
    expect(calls[1].headers['Mcp-Session-Id']).toBe('SESS-9'); // echoed afterwards
    await t.close();
  });

  it('404 (session expired) → re-initialize → retry the original once', async () => {
    let toolCalls = 0;
    const { fn, calls } = fakeFetch((_i, b) => {
      if (b.method === 'initialize') {
        return jsonRes({ jsonrpc: '2.0', id: b.id, result: {} }, { sessionId: b.id === 1 ? 'S1' : 'S2' });
      }
      toolCalls += 1;
      if (toolCalls === 1) return jsonRes({ error: 'gone' }, { status: 404 }); // session expired
      return jsonRes({ jsonrpc: '2.0', id: b.id, result: { ok: true } });
    });
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn });
    await t.request('initialize', { foo: 1 });
    expect(await t.request('tools/call', {})).toEqual({ ok: true });
    const inits = calls.filter((c) => c.body.method === 'initialize');
    expect(inits.length).toBe(2); // re-initialized after the 404
    const retried = calls.filter((c) => c.body.method === 'tools/call').pop();
    expect(retried?.headers['Mcp-Session-Id']).toBe('S2'); // retry used the fresh session
    await t.close();
  });

  it('merges the bearer and retries once on 401 (shared helper)', async () => {
    let authCalls = 0;
    const { fn, calls } = fakeFetch((i, b) =>
      i === 0 ? jsonRes({ error: 'no' }, { status: 401 }) : jsonRes({ jsonrpc: '2.0', id: b.id, result: { ok: true } }),
    );
    const t = new StreamableHttpTransport({
      baseUrl: 'http://x/mcp', fetchFn: fn,
      authHeader: async () => ({ Authorization: 'Bearer T' }),
      onAuthError: async () => { authCalls++; return true; },
    });
    expect(await t.request('initialize', {})).toEqual({ ok: true });
    expect(authCalls).toBe(1);
    expect(calls.length).toBe(2); // one + retry
    expect(calls[0].headers.Authorization).toBe('Bearer T');
    await t.close();
  });
});

// ── Selection: buildTransport routes streamable (default) vs sse (legacy) ─────

class StubTransport implements McpTransport {
  readonly label = 'stub';
  request(method: string): Promise<unknown> {
    if (method === 'initialize') return Promise.resolve({ protocolVersion: '2025-11-25', capabilities: {} });
    if (method === 'tools/list') return Promise.resolve({ tools: [] });
    return Promise.resolve({});
  }
  notify(): void {}
  onNotification(): void {}
  onExit(): void {}
  close(): Promise<void> { return Promise.resolve(); }
}

describe('McpClient — http transport selection', () => {
  it('defaults to streamable; transport:"sse" selects the legacy factory', async () => {
    let streamable = 0;
    let sse = 0;
    const client = createMcpClient(new ToolRegistry(), {
      log: () => {},
      streamableFactory: (() => { streamable++; return new StubTransport(); }) as never,
      httpFactory: (() => { sse++; return new StubTransport(); }) as never,
    });
    await client.connect({ name: 'a', type: 'http', http: { baseUrl: 'http://x/mcp' } }); // default
    await client.connect({ name: 'b', type: 'http', http: { baseUrl: 'http://y/mcp', transport: 'sse' } });
    expect(streamable).toBe(1);
    expect(sse).toBe(1);
  });
});

// ── 3c.2: server-push GET stream + hardened reconnect ────────────────────────

function closedStream(text: string): ReadableStream<Uint8Array> {
  const d = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { if (text) c.enqueue(d); c.close(); } });
}
function openStream(text: string, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const d = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      if (text) c.enqueue(d);
      signal?.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* already closed */ } });
      // otherwise stays open (server-push streams are long-lived)
    },
  });
}
const sseText = (frames: unknown[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
function sseResp(body: ReadableStream<Uint8Array>) {
  return { ok: true, status: 200, statusText: '', headers: headersOf({ 'content-type': 'text/event-stream' }), body };
}
function codeResp(status: number, sessionId?: string) {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return { ok: status < 400, status, statusText: '', headers: headersOf(h), json: async () => ({}) };
}
interface MethodInit { method?: string; body?: string; signal?: AbortSignal; headers: Record<string, string> }
function methodFetch(handlers: { post?: (body: { method?: string }, i: number) => unknown; get?: (i: number, init: MethodInit) => unknown }) {
  const state = { posts: [] as Array<{ body: { method?: string }; headers: Record<string, string> }>, gets: [] as Array<{ headers: Record<string, string> }> };
  const fn = (async (_url: string, init: MethodInit) => {
    if (init.method === 'GET') {
      const i = state.gets.length;
      state.gets.push({ headers: init.headers });
      return handlers.get ? handlers.get(i, init) : codeResp(405);
    }
    const body = JSON.parse(init.body!);
    const i = state.posts.length;
    state.posts.push({ body, headers: init.headers });
    return handlers.post ? handlers.post(body, i) : codeResp(200);
  }) as unknown as typeof fetch;
  return { fn, state };
}
const PARK: () => Promise<void> = () => new Promise<void>(() => {}); // never resolves (loop parks until close)

describe('StreamableHttpTransport — server-push GET stream (3c.2)', () => {
  it('delivers an id-less notification from the GET stream → onNotification', async () => {
    const captured: string[] = [];
    const { fn } = methodFetch({
      post: () => codeResp(200, 'S1'),
      get: (_i, init) => sseResp(openStream(sseText([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]), init.signal)),
    });
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn, sleepFn: PARK });
    t.onNotification((m) => captured.push(m));
    await t.request('initialize', {});
    await vi.waitFor(() => expect(captured).toContain('notifications/tools/list_changed'));
    await t.close();
  });

  it('stream drop → backoff reconnect (deterministic sleepFn)', async () => {
    const captured: string[] = [];
    let sleeps = 0;
    const { fn, state } = methodFetch({
      post: () => codeResp(200, 'S1'),
      get: (i, init) => i === 0
        ? sseResp(closedStream('')) // empty stream → ends → drop
        : sseResp(openStream(sseText([{ jsonrpc: '2.0', method: 'notifications/progress' }]), init.signal)),
    });
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn, sleepFn: async () => { sleeps += 1; } });
    t.onNotification((m) => captured.push(m));
    await t.request('initialize', {});
    await vi.waitFor(() => expect(captured).toContain('notifications/progress'));
    expect(state.gets.length).toBeGreaterThanOrEqual(2); // reconnected after the drop
    expect(sleeps).toBeGreaterThanOrEqual(1); // backed off between attempts
    await t.close();
  });

  it('405 on GET → loop disabled, no reconnect (POST-only server)', async () => {
    const { fn, state } = methodFetch({ post: () => codeResp(200, 'S1'), get: () => codeResp(405) });
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn, sleepFn: async () => {} });
    await t.request('initialize', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(state.gets.length).toBe(1); // tried once, then disabled
    await t.close();
  });

  it('GET 404 → reinit (new session) → reconnect with the fresh id', async () => {
    let initCount = 0;
    const captured: string[] = [];
    const { fn, state } = methodFetch({
      post: (b) => (b.method === 'initialize' ? codeResp(200, `S${++initCount}`) : codeResp(200)),
      get: (i, init) => (i === 0 ? codeResp(404) : sseResp(openStream(sseText([{ jsonrpc: '2.0', method: 'notifications/ok' }]), init.signal))),
    });
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn, sleepFn: async () => {} });
    t.onNotification((m) => captured.push(m));
    await t.request('initialize', {});
    await vi.waitFor(() => expect(captured).toContain('notifications/ok'));
    expect(initCount).toBe(2); // re-initialized after the 404
    expect(state.gets.at(-1)!.headers['Mcp-Session-Id']).toBe('S2'); // reconnected with the new session
    await t.close();
  });

  it('reinit dedup: concurrent 404s trigger ONE re-initialize', async () => {
    let initCount = 0;
    let toolPosts = 0;
    const { fn } = methodFetch({
      post: (b) => {
        if (b.method === 'initialize') return codeResp(200, `S${++initCount}`);
        toolPosts += 1;
        return codeResp(toolPosts <= 2 ? 404 : 200); // first wave of 2 → 404, then ok
      },
      get: () => codeResp(405), // disable push to isolate the request-path reinit
    });
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn, sleepFn: async () => {} });
    await t.request('initialize', {});
    await Promise.all([t.request('tools/call', {}), t.request('tools/call', {})]);
    expect(initCount).toBe(2); // 1 setup + 1 shared reinit (NOT 3)
    await t.close();
  });

  it('close() stops the loop — no GET after close', async () => {
    const { fn, state } = methodFetch({ post: () => codeResp(200, 'S1'), get: (_i, init) => sseResp(openStream('', init.signal)) });
    const t = new StreamableHttpTransport({ baseUrl: 'http://x/mcp', fetchFn: fn, sleepFn: async () => {} });
    await t.request('initialize', {});
    await vi.waitFor(() => expect(state.gets.length).toBe(1)); // GET opened (stays open)
    await t.close();
    const after = state.gets.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(state.gets.length).toBe(after); // none after close
  });
});
