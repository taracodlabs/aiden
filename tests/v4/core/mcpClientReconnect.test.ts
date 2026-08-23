/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 2a — per-server connection reconnect inside McpClient.
 *
 * Uses an injected fake transport (stdioFactory seam) to drive the exit
 * seam + reconnect state machine deterministically (jitter=0, fake timers).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMcpClient } from '../../../core/v4/mcpClient';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { McpServerConfig } from '../../../core/v4/mcpClient';
import type { McpExitInfo } from '../../../core/v4/mcp/transport';

interface FakeOpts {
  initError?: Error;          // make 'initialize' reject (handshake failure)
  tools?: string[];           // tools/list rawNames
}

interface FakeTransport {
  label: string;
  request: (method: string) => Promise<unknown>;
  notify: () => void;
  onNotification: (h: (m: string, p: unknown) => void) => void;
  onExit: (h: (info: McpExitInfo) => void) => void;
  close: () => Promise<void>;
  triggerExit: (info: McpExitInfo) => void;
  closed: () => boolean;
}

function makeFake(opts: FakeOpts = {}): FakeTransport {
  const exitHandlers: Array<(info: McpExitInfo) => void> = [];
  let closed = false;
  return {
    label: 'fake',
    request: async (method: string) => {
      if (method === 'initialize') {
        if (opts.initError) throw opts.initError;
        return { protocolVersion: '2025-11-25', capabilities: {} };
      }
      if (method === 'tools/list') {
        return {
          tools: (opts.tools ?? ['a']).map((n) => ({
            name: n,
            description: n,
            inputSchema: { type: 'object', properties: {} },
          })),
        };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    notify: () => {},
    onNotification: () => {},
    onExit: (h) => { exitHandlers.push(h); },
    close: async () => { closed = true; },
    triggerExit: (info) => { if (!closed) for (const h of exitHandlers) h(info); },
    closed: () => closed,
  };
}

const CFG: McpServerConfig = { name: 'fs', type: 'stdio', stdio: { command: 'x', args: [] } };
const mcpToolNames = (r: ToolRegistry) => r.list().filter((n) => n.startsWith('mcp_'));

function harness(reconnect: Record<string, unknown> = {}) {
  const registry = new ToolRegistry();
  const queue: FakeTransport[] = [];
  const created: FakeTransport[] = [];
  const client = createMcpClient(registry, {
    log: () => {},
    stdioFactory: () => {
      const f = queue.shift() ?? makeFake();
      created.push(f);
      return f as never;
    },
    reconnect: { baseDelayMs: 100, maxDelayMs: 1_000, jitter: () => 0, ...reconnect },
  });
  return { registry, client, queue, created };
}

describe('McpClient reconnect (Slice 2a)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('exit seam fires onExit → server goes to reconnecting (attempt 1)', async () => {
    const h = harness();
    h.queue.push(makeFake({ tools: ['a'] }));
    await h.client.connect(CFG);
    expect(h.client.get('fs')!.status).toBe('ready');

    h.created[0].triggerExit({ code: 1, signal: null });
    const s = h.client.get('fs')!;
    expect(s.status).toBe('reconnecting');
    expect(s.reconnectAttempts).toBe(1);
  });

  it('transient crash → reconnects on backoff, status returns to ready', async () => {
    const h = harness();
    h.queue.push(makeFake({ tools: ['a'] })); // initial
    await h.client.connect(CFG);

    h.queue.push(makeFake({ tools: ['a'] })); // reconnect target
    h.created[0].triggerExit({ code: 1, signal: null });
    expect(h.client.get('fs')!.status).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1_000);
    const s = h.client.get('fs')!;
    expect(s.status).toBe('ready');
    expect(s.reconnectAttempts).toBe(0); // reset on success
  });

  it('permanent crash (spawn error) → straight to failed, no retry, tools unregistered', async () => {
    const h = harness();
    h.queue.push(makeFake({ tools: ['a', 'b'] }));
    await h.client.connect(CFG);
    expect(mcpToolNames(h.registry).length).toBe(2);

    h.created[0].triggerExit({ code: null, signal: null, error: new Error('spawn npx ENOENT') });
    const s = h.client.get('fs')!;
    expect(s.status).toBe('failed');
    expect(s.reconnectTimer).toBeUndefined();
    expect(mcpToolNames(h.registry).length).toBe(0); // dead tools dropped
  });

  it('permanent initial connect failure → failed, throws, no reconnect timer', async () => {
    const h = harness();
    h.queue.push(makeFake({ initError: new Error('spawn npx ENOENT') }));
    await expect(h.client.connect(CFG)).rejects.toThrow(/connect failed/i);
    const s = h.client.get('fs')!;
    expect(s.status).toBe('failed');
    expect(s.reconnectTimer).toBeUndefined();
  });

  it('exhausts max attempts → failed with "failed after N retries"', async () => {
    const h = harness({ maxPostReadyAttempts: 2 });
    h.queue.push(makeFake({ tools: ['a'] })); // initial ready
    await h.client.connect(CFG);

    // Every reconnect target fails transiently.
    h.queue.push(makeFake({ initError: new Error('connection closed') }));
    h.queue.push(makeFake({ initError: new Error('connection closed') }));
    h.queue.push(makeFake({ initError: new Error('connection closed') }));

    h.created[0].triggerExit({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(10_000); // cascade through both attempts

    const s = h.client.get('fs')!;
    expect(s.status).toBe('failed');
    expect(s.lastError).toContain('failed after 2 retries');
  });

  it('reconnect success re-registers tools (upsert + prune, no gap)', async () => {
    const h = harness();
    h.queue.push(makeFake({ tools: ['a', 'b'] }));
    await h.client.connect(CFG);
    expect(mcpToolNames(h.registry).sort()).toEqual(['mcp_fs_a', 'mcp_fs_b']);

    h.queue.push(makeFake({ tools: ['a', 'c'] })); // b dropped, c added
    h.created[0].triggerExit({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mcpToolNames(h.registry).sort()).toEqual(['mcp_fs_a', 'mcp_fs_c']);
  });

  it('deliberate disconnect → no reconnect (closed wins)', async () => {
    const h = harness();
    h.queue.push(makeFake({ tools: ['a'] }));
    await h.client.connect(CFG);

    await h.client.disconnect('fs');
    expect(h.client.get('fs')).toBeUndefined();
    // A late exit on the closed transport must not resurrect anything.
    h.created[0].triggerExit({ code: 0, signal: null });
    expect(h.client.get('fs')).toBeUndefined();
    expect(mcpToolNames(h.registry).length).toBe(0);
  });

  it('callTool short-circuits while reconnecting (tells the model not to retry)', async () => {
    const h = harness();
    h.queue.push(makeFake({ tools: ['a'] }));
    await h.client.connect(CFG);
    h.created[0].triggerExit({ code: 1, signal: null });
    expect(h.client.get('fs')!.status).toBe('reconnecting');

    await expect(h.client.callTool('fs', 'a', {})).rejects.toThrow(/reconnecting[\s\S]*not retry/i);
  });
});
