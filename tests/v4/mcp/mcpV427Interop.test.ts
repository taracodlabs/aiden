/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { createMcpClient } from '../../../core/v4/mcpClient';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { MCP_PROTOCOL_VERSION } from '../../../core/v4/mcp/protocol';

function createControlledServer(): McpServer {
  const server = new McpServer({ name: 'aiden-controlled-http-mcp', version: '1.0.0' });
  server.registerTool('read_fixture', {
    description: 'Read one controlled fixture value.',
    inputSchema: { key: z.string().max(128) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ key }) => ({ content: [{ type: 'text', text: `http-controlled:${key}` }] }));
  server.registerResource(
    'controlled-package',
    'fixture://repository/package.json',
    { mimeType: 'application/json' },
    async () => ({ contents: [{
      uri: 'fixture://repository/package.json',
      mimeType: 'application/json',
      text: JSON.stringify({ name: 'aiden-runtime', transport: 'streamable-http' }),
    }] }),
  );
  return server;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

describe('MCP 2025-11-25 controlled wire interoperability', () => {
  const httpServers: http.Server[] = [];
  const mcpServers: McpServer[] = [];
  const transports: StreamableHTTPServerTransport[] = [];

  afterEach(async () => {
    await Promise.all(httpServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(transports.splice(0).map((transport) => transport.close().catch(() => {})));
    await Promise.all(mcpServers.splice(0).map((server) => server.close().catch(() => {})));
  });

  it('negotiates and executes bounded tools/resources over real stdio framing', async () => {
    const registry = new ToolRegistry();
    const client = createMcpClient(registry, { log: () => {}, reconnect: { maxStartupAttempts: 0 } });
    const fixture = path.resolve(process.cwd(), 'tests/v4/mcp/fixtures/controlledMcpServer.mjs');

    const connected = await client.connect({
      name: 'controlled_stdio',
      type: 'stdio',
      stdio: { command: process.execPath, args: [fixture] },
      callTimeoutMs: 10_000,
    });
    try {
      expect(connected.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(connected.tools.map((tool) => tool.rawName)).toEqual(['read_fixture', 'write_fixture']);
      expect(registry.get('mcp_controlled_stdio_read_fixture')).toMatchObject({ mutates: false });
      expect(registry.get('mcp_controlled_stdio_write_fixture')).toMatchObject({ mutates: true });
      const read = await registry.get('mcp_controlled_stdio_read_fixture')!.execute({ key: 'package' }, {} as never);
      expect(read).toContain('controlled:package');

      expect(await client.listResources('controlled_stdio')).toEqual([{
        uri: 'fixture://repository/package.json',
        name: 'controlled-package',
        mimeType: 'application/json',
      }]);
      const resource = await client.readResource('controlled_stdio', 'fixture://repository/package.json');
      expect(resource.contents[0]).toMatchObject({ uri: 'fixture://repository/package.json' });
      expect(String(resource.contents[0]?.text)).toContain('aiden-runtime');
    } finally {
      await client.closeAll();
    }
  });

  it('negotiates and executes through the maintained Streamable HTTP server binding', async () => {
    const bySession = new Map<string, StreamableHTTPServerTransport>();
    const server = http.createServer((req, res) => {
      void (async () => {
        if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
        const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
        if (req.method === 'GET') {
          const transport = sessionId ? bySession.get(sessionId) : undefined;
          if (!transport) { res.writeHead(405).end(); return; }
          await transport.handleRequest(req, res);
          return;
        }
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        const body = await readJsonBody(req);
        let transport = sessionId ? bySession.get(sessionId) : undefined;
        if (!transport) {
          const protocolServer = createControlledServer();
          mcpServers.push(protocolServer);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => bySession.set(id, transport!),
            onsessionclosed: (id) => bySession.delete(id),
          });
          transports.push(transport);
          await protocolServer.connect(transport);
        }
        await transport.handleRequest(req, res, body);
      })().catch((error) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'fixture failure' }));
      });
    });
    httpServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('MCP HTTP fixture did not bind');

    const registry = new ToolRegistry();
    const client = createMcpClient(registry, {
      log: () => {},
      endpointPolicy: { check: async () => ({ blocked: false }) },
      reconnect: { maxStartupAttempts: 0 },
    });
    await client.connect({
      name: 'controlled_http',
      type: 'http',
      http: { baseUrl: `http://127.0.0.1:${address.port}/mcp`, transport: 'streamable', allowLoopbackHttp: true },
      callTimeoutMs: 10_000,
    });
    try {
      expect(client.get('controlled_http')?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      const read = await registry.get('mcp_controlled_http_read_fixture')!.execute({ key: 'package' }, {} as never);
      expect(read).toContain('http-controlled:package');
      const resource = await client.readResource('controlled_http', 'fixture://repository/package.json');
      expect(String(resource.contents[0]?.text)).toContain('streamable-http');
    } finally {
      await client.closeAll();
    }
  });
});
