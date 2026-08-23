import { describe, it, expect } from 'vitest';
import { setupMcpFromConfig, resolveMcpClientOptions } from '../../tools/v4/mcpSetup';
import { ToolRegistry } from '../../core/v4/toolRegistry';
import type { McpTransport, McpNotificationHandler } from '../../core/v4/mcp/transport';

class StubTransport implements McpTransport {
  readonly label: string;
  closed = false;
  private handlers: McpNotificationHandler[] = [];
  private script = new Map<string, Array<{ result?: unknown; error?: Error }>>();

  constructor(label: string) {
    this.label = label;
  }

  queue(method: string, response: { result?: unknown; error?: Error }): this {
    if (!this.script.has(method)) this.script.set(method, []);
    this.script.get(method)!.push(response);
    return this;
  }

  request(method: string): Promise<unknown> {
    const r = this.script.get(method)?.shift();
    if (!r) return Promise.reject(new Error(`No scripted ${method}`));
    if (r.error) return Promise.reject(r.error);
    return Promise.resolve(r.result);
  }
  notify(): void {}
  onNotification(h: McpNotificationHandler): void {
    this.handlers.push(h);
  }
  onExit(): void { /* stub — reconnect lifecycle covered in mcpClientReconnect.test.ts */ }
  async close(): Promise<void> {
    this.closed = true;
  }
}

interface FakeConfig {
  values: Record<string, unknown>;
}

function fakeConfig(values: Record<string, unknown>): FakeConfig {
  return { values };
}

// Minimal ConfigManager-shaped stub. Only `getValue` is used by
// setupMcpFromConfig. Cast at the call site.
function asConfig(f: FakeConfig): { getValue: <T = unknown>(k: string, d?: T) => T | undefined } {
  return {
    getValue: <T,>(key: string, defaultValue?: T) => {
      return (f.values[key] as T) ?? defaultValue;
    },
  };
}

describe('setupMcpFromConfig', () => {
  it('returns a client with no servers when config has no mcp section', async () => {
    const cfg = asConfig(fakeConfig({}));
    const registry = new ToolRegistry();
    const result = await setupMcpFromConfig(cfg as never, registry, { log: () => {} });
    expect(result.connected).toEqual([]);
    expect(Object.keys(result.failures)).toEqual([]);
    expect(result.client.list()).toEqual([]);
  });

  it('connects each configured server', async () => {
    const cfg = asConfig(fakeConfig({
      mcp: {
        servers: {
          fs: { type: 'stdio', stdio: { command: 'fake', args: [] } },
          gh: { type: 'stdio', stdio: { command: 'fake', args: [] } },
        },
      },
    }));
    const registry = new ToolRegistry();
    const made = new Map<string, StubTransport>();
    const stdioFactory = (_c: unknown, _e: unknown, label: string) => {
      const t = new StubTransport(label);
      t.queue('initialize', { result: { protocolVersion: '2025-11-25', capabilities: {} } });
      t.queue('tools/list', { result: { tools: [{ name: 't' }] } });
      made.set(label, t);
      return t;
    };
    const result = await setupMcpFromConfig(cfg as never, registry, {
      stdioFactory: stdioFactory as never,
      httpFactory: (() => { throw new Error('no http'); }) as never,
      log: () => {},
    });
    expect(result.connected.sort()).toEqual(['fs', 'gh']);
    expect(result.failures).toEqual({});
    expect(registry.get('mcp_fs_t')).toBeDefined();
    expect(registry.get('mcp_gh_t')).toBeDefined();
  });

  it('failed connect is recorded but does not throw', async () => {
    const cfg = asConfig(fakeConfig({
      mcp: {
        servers: {
          good: { type: 'stdio', stdio: { command: 'fake', args: [] } },
          bad: { type: 'stdio', stdio: { command: 'fake', args: [] } },
        },
      },
    }));
    const registry = new ToolRegistry();
    const stdioFactory = (_c: unknown, _e: unknown, label: string) => {
      const t = new StubTransport(label);
      if (label === 'bad') {
        t.queue('initialize', { error: new Error('connect failed') });
      } else {
        t.queue('initialize', { result: { protocolVersion: '2025-11-25', capabilities: {} } });
        t.queue('tools/list', { result: { tools: [] } });
      }
      return t;
    };
    const result = await setupMcpFromConfig(cfg as never, registry, {
      stdioFactory: stdioFactory as never,
      httpFactory: (() => { throw new Error(); }) as never,
      log: () => {},
      // Report the failure immediately (no background startup retry timer in the test).
      reconnect: { maxStartupAttempts: 0 },
    });
    expect(result.connected).toEqual(['good']);
    expect(result.failures.bad).toMatch(/connect failed/);
  });

  it('rejects unsupported type with a helpful message', async () => {
    const cfg = asConfig(fakeConfig({
      mcp: { servers: { weird: { type: 'websocket' } } },
    }));
    const registry = new ToolRegistry();
    const result = await setupMcpFromConfig(cfg as never, registry, { log: () => {} });
    expect(result.connected).toEqual([]);
    expect(result.failures.weird).toMatch(/unsupported type/);
  });

  it('uses configKey override', async () => {
    const cfg = asConfig(fakeConfig({
      'integrations.mcp': {
        servers: { f: { type: 'stdio', stdio: { command: 'fake', args: [] } } },
      },
    }));
    const registry = new ToolRegistry();
    const stdioFactory = (_c: unknown, _e: unknown, label: string) => {
      const t = new StubTransport(label);
      t.queue('initialize', { result: { protocolVersion: '2025-11-25', capabilities: {} } });
      t.queue('tools/list', { result: { tools: [] } });
      return t;
    };
    const result = await setupMcpFromConfig(cfg as never, registry, {
      configKey: 'integrations.mcp',
      stdioFactory: stdioFactory as never,
      httpFactory: (() => { throw new Error(); }) as never,
      log: () => {},
    });
    expect(result.connected).toEqual(['f']);
  });
});

describe('resolveMcpClientOptions — config.yaml breaker/reconnect tuning', () => {
  it('maps mcp.breaker + mcp.reconnect from config into client options', () => {
    const opts = resolveMcpClientOptions(
      {
        breaker: { threshold: 5, cooldownMs: 5000 },
        reconnect: { maxPostReadyAttempts: 7, maxStartupAttempts: 2, baseDelayMs: 250, maxDelayMs: 9000 },
      },
      {},
    );
    expect(opts.breaker).toEqual({ threshold: 5, cooldownMs: 5000 });
    expect(opts.reconnect).toEqual({
      maxPostReadyAttempts: 7,
      maxStartupAttempts: 2,
      baseDelayMs: 250,
      maxDelayMs: 9000,
    });
  });

  it('drops invalid values (non-positive / non-number / non-int threshold) → fall back to defaults', () => {
    const opts = resolveMcpClientOptions(
      {
        breaker: { threshold: 0, cooldownMs: -5 },
        reconnect: { baseDelayMs: 'x', maxStartupAttempts: -1, maxPostReadyAttempts: 1.5 },
      },
      {},
    );
    expect(opts.breaker).toEqual({});   // threshold<1 + cooldownMs<=0 rejected
    expect(opts.reconnect).toEqual({}); // wrong-type / negative / non-int rejected
  });

  it('maxStartupAttempts: 0 is valid (int >= 0 = "no startup retry")', () => {
    expect(resolveMcpClientOptions({ reconnect: { maxStartupAttempts: 0 } }, {}).reconnect)
      .toEqual({ maxStartupAttempts: 0 });
  });

  it('explicit code opts win over config (per field)', () => {
    const opts = resolveMcpClientOptions(
      { breaker: { cooldownMs: 5000, threshold: 9 } },
      { breaker: { cooldownMs: 999 } },
    );
    expect(opts.breaker).toEqual({ threshold: 9, cooldownMs: 999 }); // opts cooldown wins, config threshold kept
  });

  it('missing mcp config → empty tuning (client uses code defaults)', () => {
    const opts = resolveMcpClientOptions(undefined, {});
    expect(opts.breaker).toEqual({});
    expect(opts.reconnect).toEqual({});
  });
});

describe('setupMcpFromConfig — config tuning reaches the live client', () => {
  it('mcp.reconnect.maxStartupAttempts:0 from config → transient connect fail gives up immediately (no retry timer)', async () => {
    const cfg = asConfig(fakeConfig({
      mcp: {
        servers: { bad: { type: 'stdio', stdio: { command: 'fake', args: [] } } },
        reconnect: { maxStartupAttempts: 0 },
      },
    }));
    const registry = new ToolRegistry();
    const stdioFactory = (_c: unknown, _e: unknown, label: string) => {
      const t = new StubTransport(label);
      t.queue('initialize', { error: new Error('connect failed') }); // transient
      return t;
    };
    const result = await setupMcpFromConfig(cfg as never, registry, {
      stdioFactory: stdioFactory as never,
      httpFactory: (() => { throw new Error('no http'); }) as never,
      log: () => {},
    });
    expect(result.failures.bad).toMatch(/connect failed/);
    const s = result.client.get('bad');
    // Without the config wiring this would default to 3 startup retries →
    // status 'reconnecting' + a live timer. Config maxStartupAttempts:0 → failed now.
    expect(s?.status).toBe('failed');
    expect(s?.reconnectTimer).toBeUndefined();
  });
});
