/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createExternalAuthority } from '../../../core/v4/external/externalAuthority';
import { createMcpClient } from '../../../core/v4/mcpClient';
import { MCP_PROTOCOL_VERSION } from '../../../core/v4/mcp/protocol';
import {
  McpUnknownOutcomeError,
  StreamableHttpTransport,
  type McpTransport,
} from '../../../core/v4/mcp/transport';
import { ToolRegistry } from '../../../core/v4/toolRegistry';

class FixtureTransport implements McpTransport {
  readonly label = 'fixture:mcp';
  readonly calls: Array<{ method: string; params: unknown; opts: unknown }> = [];
  constructor(
    private readonly initializeVersion: string | undefined = MCP_PROTOCOL_VERSION,
    private readonly advertisedTools: Array<Record<string, unknown>> = [
      {
        name: 'read_file', description: 'Read one file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'write_file', description: 'Write one file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
  ) {}
  async request(method: string, params?: unknown, opts?: unknown): Promise<unknown> {
    this.calls.push({ method, params, opts });
    if (method === 'initialize') {
      return {
        protocolVersion: this.initializeVersion,
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      };
    }
    if (method === 'tools/list') {
      return { tools: this.advertisedTools };
    }
    if (method === 'resources/list') {
      return { resources: [{ uri: 'repo://package.json', name: 'package.json', mimeType: 'application/json' }] };
    }
    if (method === 'resources/read') {
      return { contents: [{ uri: 'repo://package.json', mimeType: 'application/json', text: '{"name":"fixture"}' }] };
    }
    if (method === 'tools/call') return { content: [{ type: 'text', text: 'fixture result' }] };
    return {};
  }
  notify(): void {}
  onNotification(): void {}
  onExit(): void {}
  close(): Promise<void> { return Promise.resolve(); }
}

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (key: string) => normalized.get(key.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => text,
  };
}

describe('MCP v4.27 client boundary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  it('rejects a server that does not negotiate a supported protocol revision', async () => {
    const transport = new FixtureTransport('2024-10-07');
    const client = createMcpClient(new ToolRegistry(), {
      log: () => {}, stdioFactory: () => transport,
      reconnect: { maxStartupAttempts: 0 },
    });
    await expect(client.connect({ name: 'old', type: 'stdio', stdio: { command: 'fixture', args: [] } }))
      .rejects.toThrow(/unsupported MCP protocol/i);
    expect(transport.calls[0]).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION },
    });
  });

  it('classifies exact read-only tools, preserves schemas, and gates mutation capability drift', async () => {
    const registry = new ToolRegistry();
    const authority = createExternalAuthority({ db });
    const transport = new FixtureTransport();
    const client = createMcpClient(registry, {
      log: () => {}, stdioFactory: () => transport, externalAuthority: authority,
    });
    const server = await client.connect({ name: 'files', type: 'stdio', stdio: { command: 'fixture', args: [] } });

    expect(server.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(server.capabilitySnapshotId).toMatch(/^external_caps_/);
    expect(server.mutationBlocked).toBe(true);
    expect(registry.get('mcp_files_read_file')).toMatchObject({ category: 'network', mutates: false });
    expect(registry.get('mcp_files_write_file')).toMatchObject({ category: 'execute', mutates: true });
    expect(registry.get('mcp_files_read_file')?.schema.inputSchema.required).toEqual(['path']);

    await expect(registry.get('mcp_files_write_file')!.execute({ path: 'x' }, {} as never))
      .rejects.toThrow(/capabilit.*review/i);
    expect(await registry.get('mcp_files_read_file')!.execute({ path: 'x' }, {} as never))
      .toContain('fixture result');

    const accepted = client.approveCapabilities('files', 'local-user');
    expect(accepted.reviewRequired).toBe(false);
    expect(client.get('files')?.mutationBlocked).toBe(false);
    expect(await registry.get('mcp_files_write_file')!.execute({ path: 'x' }, {} as never))
      .toContain('fixture result');
  });

  it('lists and reads bounded MCP resources through the negotiated server', async () => {
    const transport = new FixtureTransport();
    const client = createMcpClient(new ToolRegistry(), { log: () => {}, stdioFactory: () => transport });
    await client.connect({ name: 'resources', type: 'stdio', stdio: { command: 'fixture', args: [] } });
    expect(await client.listResources('resources')).toEqual([
      { uri: 'repo://package.json', name: 'package.json', mimeType: 'application/json' },
    ]);
    const resource = await client.readResource('resources', 'repo://package.json');
    expect(resource.contents[0]).toMatchObject({ uri: 'repo://package.json', text: '{"name":"fixture"}' });
  });

  it('blocks a denied HTTP endpoint before constructing or using a transport', async () => {
    let transportConstructed = false;
    const client = createMcpClient(new ToolRegistry(), {
      log: () => {},
      endpointPolicy: { check: async () => ({ blocked: true, reason: 'resolved to private address' }) },
      streamableFactory: () => {
        transportConstructed = true;
        return new FixtureTransport();
      },
      reconnect: { maxStartupAttempts: 0 },
    });
    await expect(client.connect({
      name: 'blocked', type: 'http', http: { baseUrl: 'https://blocked.example.test/mcp' },
    })).rejects.toThrow(/endpoint.*private/i);
    expect(transportConstructed).toBe(false);
  });

  it('rejects an excessive or malformed tool catalog before registry projection', async () => {
    const tooMany = Array.from({ length: 1_025 }, (_, index) => ({
      name: `read_${index}`, description: 'Read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
    }));
    const excessive = createMcpClient(new ToolRegistry(), {
      log: () => {}, stdioFactory: () => new FixtureTransport(MCP_PROTOCOL_VERSION, tooMany),
      reconnect: { maxStartupAttempts: 0 },
    });
    await expect(excessive.connect({ name: 'many', type: 'stdio', stdio: { command: 'fixture', args: [] } }))
      .rejects.toThrow(/tool catalog.*limit/i);

    const malformed = createMcpClient(new ToolRegistry(), {
      log: () => {}, stdioFactory: () => new FixtureTransport(MCP_PROTOCOL_VERSION, [{
        name: 'x'.repeat(300), description: 'Read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
      }]),
      reconnect: { maxStartupAttempts: 0 },
    });
    await expect(malformed.connect({ name: 'malformed', type: 'stdio', stdio: { command: 'fixture', args: [] } }))
      .rejects.toThrow(/tool name.*limit/i);
  });

  it('revokes durable server trust and unregisters its projected tools', async () => {
    const registry = new ToolRegistry();
    const authority = createExternalAuthority({ db });
    const client = createMcpClient(registry, {
      log: () => {}, stdioFactory: () => new FixtureTransport(), externalAuthority: authority,
    });
    const server = await client.connect({ name: 'revoke', type: 'stdio', stdio: { command: 'fixture', args: [] } });
    client.approveCapabilities('revoke', 'local-user');

    const revoked = await client.revoke('revoke');
    expect(revoked.trustState).toBe('revoked');
    expect(authority.getIdentity(server.externalIdentityId!)?.trustState).toBe('revoked');
    expect(registry.get('mcp_revoke_read_file')).toBeUndefined();
    expect(registry.get('mcp_revoke_write_file')).toBeUndefined();
    expect(client.get('revoke')).toBeUndefined();
  });

  it('does not replay a possibly mutating request after session loss', async () => {
    let initializeCalls = 0;
    let toolCalls = 0;
    const fetchFn = (async (_url: string, init: { method?: string; body?: string }) => {
      if (init.method === 'GET') {
        return response(405, { error: 'push stream unsupported' }, { 'content-type': 'application/json' });
      }
      const envelope = JSON.parse(init.body ?? '{}') as { id?: number; method?: string };
      if (envelope.method === 'initialize') {
        initializeCalls += 1;
        return response(200, { jsonrpc: '2.0', id: envelope.id, result: {} }, {
          'content-type': 'application/json', 'mcp-session-id': `session-${initializeCalls}`,
        });
      }
      toolCalls += 1;
      return response(404, { error: 'session expired' }, { 'content-type': 'application/json' });
    }) as unknown as typeof fetch;
    const transport = new StreamableHttpTransport({ baseUrl: 'https://mcp.example.test', fetchFn });
    await transport.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION });
    await expect(transport.request('tools/call', { name: 'write' }, { retryOnSessionExpiry: false }))
      .rejects.toBeInstanceOf(McpUnknownOutcomeError);
    expect(toolCalls).toBe(1);
    expect(initializeCalls).toBe(1);
    await transport.close();
  });
});
