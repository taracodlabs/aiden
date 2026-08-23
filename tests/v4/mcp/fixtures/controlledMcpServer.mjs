#!/usr/bin/env node
/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'aiden-controlled-mcp', version: '1.0.0' });

server.registerTool('read_fixture', {
  description: 'Read one controlled fixture value.',
  inputSchema: { key: z.string().max(128) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ key }) => ({
  content: [{ type: 'text', text: `controlled:${key}` }],
}));

server.registerTool('write_fixture', {
  description: 'Represent one controlled mutating fixture action.',
  inputSchema: { value: z.string().max(128) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ value }) => ({
  content: [{ type: 'text', text: `controlled-write:${value}` }],
}));

server.registerResource(
  'controlled-package',
  'fixture://repository/package.json',
  { description: 'Controlled repository metadata.', mimeType: 'application/json' },
  async () => ({
    contents: [{
      uri: 'fixture://repository/package.json',
      mimeType: 'application/json',
      text: JSON.stringify({ name: 'aiden-runtime', fixture: true }),
    }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try { await server.close(); } finally { process.exitCode = 0; }
};
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
