/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import http from 'node:http';
import { localAccessFixture } from '../helpers/localAccess';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createExternalAuthority } from '../../../core/v4/external/externalAuthority';
import { createMcpClient } from '../../../core/v4/mcpClient';
import { ToolRegistry } from '../../../core/v4/toolRegistry';

describe('MCP shared-authority revocation at egress', () => {
  let server: http.Server | undefined;
  const clients: ReturnType<typeof createMcpClient>[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.closeAll()));
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it.each(['identity', 'grant', 'expiry'])('blocks every new request from a retained peer client after %s revocation', async (mode) => {
    let requests = 0;
    let connections = 0;
    let toolCalls = 0;
    server = http.createServer(async (request, response) => {
      requests++;
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw) as { id?: number; method?: string };
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      let result: unknown = {};
      if (message.method === 'initialize') result = {
        protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'owned', version: '1' },
      };
      if (message.method === 'tools/list') result = { tools: [{
        name: 'read_marker', description: 'Read owned test marker', inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      }] };
      if (message.method === 'tools/call') {
        toolCalls++;
        result = { content: [{ type: 'text', text: 'owned-marker' }], isError: false };
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    server.on('connection', () => connections++);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('owned MCP fixture did not bind');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    try {
      const authority = createExternalAuthority({ db });
      const makeClient = () => {
        const client = createMcpClient(new ToolRegistry(), {
          externalAuthority: authority,
          log: () => {},
          reconnect: { maxStartupAttempts: 0, maxPostReadyAttempts: 0 },
        });
        clients.push(client);
        return client;
      };
      const endpoint = `http://127.0.0.1:${address.port}`;
      const grant = localAccessFixture(endpoint, ['mcp:initialize', 'mcp:notifications/initialized', 'mcp:tools/list', 'mcp:tools/call:read_marker']);
      try { await grant.run(async () => {
      const config = { name: 'owned', type: 'http' as const,
        http: { baseUrl: endpoint, transport: 'sse' as const, allowLoopbackHttp: true } };
      const clientA = makeClient();
      const clientB = makeClient();
      const connectedA = await clientA.connect(structuredClone(config));
      const connectedB = await clientB.connect(structuredClone(config));
      expect(connectedA.externalIdentityId).toBe(connectedB.externalIdentityId);

      expect(String(await clientB.callTool('owned', 'read_marker', {}, 'read_only'))).toContain('owned-marker');
      expect(toolCalls).toBe(1);
      const before = { requests, connections, toolCalls };
      if (mode === 'identity') {
        await clientA.revoke('owned');
        expect(authority.getIdentity(connectedB.externalIdentityId!)?.trustState).toBe('revoked');
      } else if (mode === 'grant') {
        expect(grant.actions.authorizeExecution(grant.binding).authorized).toBe(true);
        grant.actions.invalidate(grant.binding.approvalId, 'owner revoked');
      } else { grant.db.prepare('UPDATE approvals SET expires_at = 1').run(); }
      await expect(clientB.callTool('owned', 'read_marker', {}, 'read_only'))
        .rejects.toThrow(/revoked|expired/i);
      expect({ requests, connections, toolCalls }).toEqual(before);
      console.log(JSON.stringify({ gate: `mcp-${mode}`, positiveToolCalls: before.toolCalls,
        forbiddenRequests: requests - before.requests, forbiddenConnections: connections - before.connections,
        forbiddenToolCalls: toolCalls - before.toolCalls }));
      expect(clientB.get('owned')?.status).toBe('ready');
      }); } finally { grant.close(); }
    } finally {
      db.close();
    }
  });
});
