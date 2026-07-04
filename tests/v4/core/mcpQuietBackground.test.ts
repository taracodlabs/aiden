/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — stop bothering the human with background MCP housekeeping.
 *   Fix 1: reconnect/retry/give-up chatter routes through the injected log
 *          channel ONLY (boot points that at a file sink) — the client has no
 *          chat/display dependency, so none of it can reach the conversation.
 *   Fix 2: a server that DECLARES OAuth but has no token yet is marked
 *          `needs-auth` QUIETLY — no establish, no reconnect-retry loop, no
 *          "giving up" alarm. A previously-ready server that DROPS still retries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMcpClient } from '../../../core/v4/mcpClient';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { McpServerConfig } from '../../../core/v4/mcpClient';
import type { McpExitInfo } from '../../../core/v4/mcp/transport';

interface FakeTransport {
  label: string;
  request: (method: string) => Promise<unknown>;
  notify: () => void;
  onNotification: () => void;
  onExit: (h: (info: McpExitInfo) => void) => void;
  close: () => Promise<void>;
  triggerExit: (info: McpExitInfo) => void;
}
function makeFake(opts: { initError?: Error; tools?: string[] } = {}): FakeTransport {
  const exitHandlers: Array<(info: McpExitInfo) => void> = [];
  let closed = false;
  return {
    label: 'fake',
    request: async (method: string) => {
      if (method === 'initialize') { if (opts.initError) throw opts.initError; return { capabilities: {} }; }
      if (method === 'tools/list') return { tools: (opts.tools ?? ['a']).map((n) => ({ name: n, description: n, inputSchema: { type: 'object', properties: {} } })) };
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    notify: () => {}, onNotification: () => {},
    onExit: (h) => { exitHandlers.push(h); },
    close: async () => { closed = true; },
    triggerExit: (info) => { if (!closed) for (const h of exitHandlers) h(info); },
  };
}

// ── Fix 1 — chatter on the log channel only ──────────────────────────────────
describe('Fix 1 — reconnect/give-up chatter routes to the log channel (chat-free)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a dropped ready server reconnects+gives-up entirely via the injected log', async () => {
    const logs: Array<[string, string]> = [];
    const registry = new ToolRegistry();
    const queue: FakeTransport[] = [makeFake({ tools: ['a'] })]; // first connects ready
    const client = createMcpClient(registry, {
      log: (lvl, msg) => logs.push([lvl, msg]),
      // every RECONNECT transport fails the handshake → forces the give-up path
      stdioFactory: (() => queue.shift() ?? makeFake({ initError: new Error('ECONNREFUSED') })) as never,
      reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: () => 0, maxPostReadyAttempts: 1 },
    });
    const server = await client.connect({ name: 'fs', type: 'stdio', stdio: { command: 'x', args: [] } });
    (server.transport as unknown as FakeTransport).triggerExit({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(200);

    const msgs = logs.map(([, m]) => m).join('\n');
    expect(msgs).toMatch(/disconnected/);
    expect(msgs).toMatch(/reconnecting \(attempt 1\/1\)/);
    expect(msgs).toMatch(/failed after 1 retries/);
    // The client exposes NO chat/display surface — its sole output is this log
    // callback. Boot wires that to a file, so the conversation stays clean.
  });
});

// ── Fix 2 — un-authorized OAuth server: quiet, no retry loop ──────────────────
describe('Fix 2 — a token-less OAuth server is quietly needs-auth (no giving-up alarm)', () => {
  const OAUTH_CFG: McpServerConfig = {
    name: 'github', type: 'http',
    http: { baseUrl: 'https://api.example/mcp/', oauth: { deviceAuthorizationEndpoint: 'https://example/device/code' } },
  };

  it("resolve 'none' + config declares OAuth → needs-auth, no establish, no reconnect", async () => {
    const logs: Array<[string, string]> = [];
    const registry = new ToolRegistry();
    const client = createMcpClient(registry, {
      log: (lvl, msg) => logs.push([lvl, msg]),
      authProvider: { resolve: async () => ({ state: 'none' }) }, // nothing persisted yet
      // If connect ever tried to establish, it would call this and throw.
      streamableFactory: (() => { throw new Error('MUST NOT build a transport for an un-authorized server'); }) as never,
    });
    const server = await client.connect(OAUTH_CFG);
    expect(server.status).toBe('needs-auth');
    expect(client.get('github')?.status).toBe('needs-auth');

    const msgs = logs.map(([, m]) => m).join('\n');
    expect(msgs).not.toMatch(/reconnecting|failed after|giving up/); // NO alarm
    expect(logs.filter(([, m]) => /needs auth/.test(m)).length).toBe(1); // calm hint, once
  });

  it("a plain (non-OAuth) http server with resolve 'none' still connects normally (unchanged)", async () => {
    const registry = new ToolRegistry();
    let built = 0;
    const client = createMcpClient(registry, {
      log: () => {},
      authProvider: { resolve: async () => ({ state: 'none' }) },
      streamableFactory: (() => { built += 1; return makeFake({ tools: ['x'] }); }) as never,
    });
    const server = await client.connect({ name: 'plain', type: 'http', http: { baseUrl: 'https://plain.example/mcp' } });
    expect(built).toBe(1);               // DID establish (no oauth declared)
    expect(server.status).toBe('ready');
  });
});
