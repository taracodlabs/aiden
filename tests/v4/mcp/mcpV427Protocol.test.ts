/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  MCP_PROTOCOL_VERSION,
  classifyMcpTool,
  digestMcpCapabilities,
  negotiateMcpProtocol,
  normalizeMcpToolSchema,
} from '../../../core/v4/mcp/protocol';

describe('MCP 2025-11-25 protocol authority', () => {
  it('advertises the pinned stable revision and accepts only deliberate compatibility revisions', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(negotiateMcpProtocol('2025-11-25')).toBe('2025-11-25');
    expect(negotiateMcpProtocol('2025-06-18')).toBe('2025-06-18');
    expect(negotiateMcpProtocol('2025-03-26')).toBe('2025-03-26');
    expect(negotiateMcpProtocol('2024-11-05')).toBe('2024-11-05');

    for (const unsupported of ['', '2024-10-07', '2026-01-01', 'draft']) {
      expect(() => negotiateMcpProtocol(unsupported)).toThrow(/unsupported MCP protocol/i);
    }
  });

  it('treats only an explicit read-only annotation as read-only', () => {
    expect(classifyMcpTool({ name: 'read_file', annotations: { readOnlyHint: true } })).toEqual({
      effect: 'read_only',
      reason: 'server_read_only_annotation',
    });
    expect(classifyMcpTool({ name: 'write_file', annotations: { readOnlyHint: false } }).effect).toBe('mutating');
    expect(classifyMcpTool({ name: 'unknown' }).effect).toBe('mutating');
    expect(classifyMcpTool({ name: 'misleading', annotations: { readOnlyHint: 'true' as never } }).effect).toBe('mutating');
  });

  it('preserves bounded JSON Schema semantics instead of dropping combinators', () => {
    const schema = normalizeMcpToolSchema({
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        mode: { enum: ['summary', 'full'] },
      },
      required: ['path'],
      additionalProperties: false,
      allOf: [{ properties: { path: { pattern: '^[^\\0]+$' } } }],
    });

    expect(schema).toMatchObject({
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      allOf: [{ properties: { path: { pattern: '^[^\\0]+$' } } }],
    });
  });

  it('produces one canonical digest regardless of object key ordering', () => {
    const first = digestMcpCapabilities({
      protocolVersion: '2025-11-25',
      capabilities: { resources: { subscribe: true }, tools: { listChanged: true } },
      tools: [{ name: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    });
    const reordered = digestMcpCapabilities({
      tools: [{ inputSchema: { properties: { path: { type: 'string' } }, type: 'object' }, name: 'read' }],
      capabilities: { tools: { listChanged: true }, resources: { subscribe: true } },
      protocolVersion: '2025-11-25',
    });
    const changed = digestMcpCapabilities({
      protocolVersion: '2025-11-25',
      capabilities: { resources: { subscribe: true }, tools: { listChanged: true } },
      tools: [{ name: 'write', inputSchema: { type: 'object' } }],
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
});
