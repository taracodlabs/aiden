/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 2b — per-server tool-call circuit breaker.
 *
 * Real compiled McpClient + injected fake transport (control tools/call
 * success/failure) + injected `now` clock (cooldown without real time).
 */
import { describe, it, expect, vi } from 'vitest';
import { createMcpClient } from '../../../core/v4/mcpClient';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { McpServerConfig } from '../../../core/v4/mcpClient';

type CallMode = 'ok' | 'throw' | 'isError';

function makeFake() {
  const state = { callMode: 'ok' as CallMode, tools: ['a'], callCount: 0 };
  const exitHandlers: Array<(info: unknown) => void> = [];
  let closed = false;
  const transport = {
    label: 'fake',
    request: async (method: string) => {
      if (method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: {} };
      if (method === 'tools/list') {
        return { tools: state.tools.map((n) => ({ name: n, description: n, inputSchema: { type: 'object', properties: {} } })) };
      }
      if (method === 'tools/call') {
        state.callCount += 1;
        if (state.callMode === 'throw') throw new Error('tool exploded');
        if (state.callMode === 'isError') return { isError: true, content: [{ type: 'text', text: 'tool error' }] };
        return { content: [{ type: 'text', text: 'ok' }] };
      }
      return {};
    },
    notify: () => {},
    onNotification: () => {},
    onExit: (h: (info: unknown) => void) => { exitHandlers.push(h); },
    close: async () => { closed = true; },
    triggerExit: (info: unknown) => { if (!closed) for (const h of exitHandlers) h(info); },
  };
  return { state, transport };
}

const CFG: McpServerConfig = { name: 'fs', type: 'stdio', stdio: { command: 'x', args: [] } };

function harness() {
  const registry = new ToolRegistry();
  const fake = makeFake();
  let clock = 0;
  const client = createMcpClient(registry, {
    log: () => {},
    stdioFactory: () => fake.transport as never,
    breaker: { threshold: 3, cooldownMs: 1000 },
    now: () => clock,
    reconnect: { baseDelayMs: 10, jitter: () => 0 },
  });
  return { registry, client, fake, setClock: (n: number) => { clock = n; } };
}

const br = (h: ReturnType<typeof harness>) => h.client.get('fs')!.breaker;

async function failN(h: ReturnType<typeof harness>, n: number) {
  h.fake.state.callMode = 'throw';
  for (let i = 0; i < n; i += 1) {
    await expect(h.client.callTool('fs', 'a', {})).rejects.toThrow(/failed/);
  }
}

describe('McpClient tool-call circuit breaker (Slice 2b)', () => {
  it('3 consecutive failures → open', async () => {
    const h = harness();
    await h.client.connect(CFG);
    await failN(h, 2);
    expect(br(h).state).toBe('closed'); // 2 < threshold
    await failN(h, 1);
    expect(br(h).state).toBe('open');
    expect(br(h).failures).toBe(3);
  });

  it('open → short-circuits WITHOUT hitting the transport, tells model not to retry', async () => {
    const h = harness();
    await h.client.connect(CFG);
    await failN(h, 3);
    const before = h.fake.state.callCount;
    h.fake.state.callMode = 'ok'; // would succeed — but breaker is open
    await expect(h.client.callTool('fs', 'a', {})).rejects.toThrow(/circuit open[\s\S]*not retry/i);
    expect(h.fake.state.callCount).toBe(before); // transport NOT hit
  });

  it('cooldown elapsed → half-open probe allowed; success → closed + reset', async () => {
    const h = harness();
    await h.client.connect(CFG);
    await failN(h, 3); // open at clock 0
    h.setClock(1000);  // cooldown elapsed
    h.fake.state.callMode = 'ok';
    const before = h.fake.state.callCount;
    const out = await h.client.callTool('fs', 'a', {});
    expect(out).toContain('ok'); // v4.12 — success result now redacted + fenced
    expect(h.fake.state.callCount).toBe(before + 1); // probe DID hit transport
    expect(br(h).state).toBe('closed');
    expect(br(h).failures).toBe(0);
  });

  it('half-open probe failure → reopen + restart cooldown', async () => {
    const h = harness();
    await h.client.connect(CFG);
    await failN(h, 3);           // open at clock 0
    h.setClock(1000);            // cooldown elapsed → next call is the probe
    await expect(h.client.callTool('fs', 'a', {})).rejects.toThrow(/failed/); // probe fails (still throw mode)
    expect(br(h).state).toBe('open');
    expect(br(h).openedAt).toBe(1000); // cooldown restarted at current clock
  });

  it('mid-streak success resets the consecutive counter', async () => {
    const h = harness();
    await h.client.connect(CFG);
    await failN(h, 2);                    // failures=2, closed
    h.fake.state.callMode = 'ok';
    await h.client.callTool('fs', 'a', {}); // success → reset
    expect(br(h).failures).toBe(0);
    await failN(h, 2);                    // 2 more → still under threshold
    expect(br(h).state).toBe('closed');
    expect(br(h).failures).toBe(2);
  });

  it('a tool isError result counts as a failure (opens after 3)', async () => {
    const h = harness();
    await h.client.connect(CFG);
    h.fake.state.callMode = 'isError';
    for (let i = 0; i < 3; i += 1) {
      await expect(h.client.callTool('fs', 'a', {})).rejects.toThrow(/reported error/);
    }
    expect(br(h).state).toBe('open');
  });

  it('2a state wins — breaker does not engage (no double-count) when reconnecting', async () => {
    const h = harness();
    await h.client.connect(CFG);
    const callsAfterConnect = h.fake.state.callCount;
    h.client.get('fs')!.status = 'reconnecting';
    await expect(h.client.callTool('fs', 'a', {})).rejects.toThrow(/reconnecting/i);
    expect(br(h).failures).toBe(0);                       // breaker untouched
    expect(h.fake.state.callCount).toBe(callsAfterConnect); // transport not hit
  });

  it('reconnect (establish) resets an open breaker', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.client.connect(CFG);
      await failN(h, 3);
      expect(br(h).state).toBe('open');

      h.fake.state.callMode = 'ok';            // so reconnect establishes cleanly
      h.fake.transport.triggerExit({ code: 1, signal: null }); // simulate crash
      await vi.advanceTimersByTimeAsync(1000); // let reconnect fire

      const s = h.client.get('fs')!;
      expect(s.status).toBe('ready');
      expect(s.breaker.state).toBe('closed');  // breaker reset on re-establish
    } finally {
      vi.useRealTimers();
    }
  });
});
