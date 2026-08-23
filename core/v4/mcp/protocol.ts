/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Stable MCP protocol and capability normalization boundary.
 */

import { createHash } from 'node:crypto';

import type { ToolSchema } from '../../../providers/v4/types';

export const MCP_PROTOCOL_VERSION = '2025-11-25' as const;

/** Revisions for which Aiden keeps an explicit compatibility contract. */
export const MCP_COMPATIBLE_PROTOCOL_VERSIONS = Object.freeze([
  MCP_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const);

export type McpProtocolVersion = typeof MCP_COMPATIBLE_PROTOCOL_VERSIONS[number];

const COMPATIBLE = new Set<string>(MCP_COMPATIBLE_PROTOCOL_VERSIONS);

export function negotiateMcpProtocol(version: unknown): McpProtocolVersion {
  if (typeof version !== 'string' || !COMPATIBLE.has(version)) {
    throw new Error(
      `Unsupported MCP protocol version ${JSON.stringify(version)}; `
      + `supported revisions: ${MCP_COMPATIBLE_PROTOCOL_VERSIONS.join(', ')}`,
    );
  }
  return version as McpProtocolVersion;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
    idempotentHint?: unknown;
    openWorldHint?: unknown;
    [key: string]: unknown;
  };
}

export type McpToolEffectClassification =
  | { effect: 'read_only'; reason: 'server_read_only_annotation' }
  | { effect: 'mutating'; reason: 'missing_or_untrusted_annotation' };

/**
 * MCP annotations are hints, not proof. Aiden may use an exact boolean
 * readOnlyHint to reduce approval friction; every absent, malformed, or false
 * value remains mutating and therefore flows through ActionAuthority.
 */
export function classifyMcpTool(tool: Pick<McpToolDescriptor, 'annotations'>): McpToolEffectClassification {
  return tool.annotations?.readOnlyHint === true
    ? { effect: 'read_only', reason: 'server_read_only_annotation' }
    : { effect: 'mutating', reason: 'missing_or_untrusted_annotation' };
}

export type McpToolSchema = ToolSchema['inputSchema'] & Record<string, unknown>;

const MAX_SCHEMA_DEPTH = 24;
const MAX_SCHEMA_KEYS = 4_096;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function cloneBounded(value: unknown, depth: number, budget: { keys: number }): unknown {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('MCP tool schema exceeds the maximum nesting depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SCHEMA_KEYS) throw new Error('MCP tool schema array is too large');
    return value.map((entry) => cloneBounded(entry, depth + 1, budget));
  }
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) continue;
    budget.keys += 1;
    if (budget.keys > MAX_SCHEMA_KEYS) throw new Error('MCP tool schema contains too many fields');
    out[key] = cloneBounded(entry, depth + 1, budget);
  }
  return out;
}

/** Preserve the server's JSON Schema semantics while enforcing a bounded object root. */
export function normalizeMcpToolSchema(schema: unknown): McpToolSchema {
  const cloned = cloneBounded(schema, 0, { keys: 0 });
  const record = cloned && typeof cloned === 'object' && !Array.isArray(cloned)
    ? cloned as Record<string, unknown>
    : {};
  const properties = record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
    ? record.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(record.required)
    ? record.required.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  return {
    ...record,
    type: 'object',
    properties,
    ...(required === undefined ? {} : { required }),
    ...(typeof record.additionalProperties === 'boolean'
      ? { additionalProperties: record.additionalProperties }
      : {}),
  } as McpToolSchema;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

export function digestMcpCapabilities(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
