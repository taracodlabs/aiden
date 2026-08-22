/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_MANIFEST_VERSION,
  CAPABILITY_PROTOCOL_VERSION,
  runCapabilityConformance,
  validateCapabilityManifest,
  validateJsonValue,
  type CapabilityManifest,
} from '../../../packages/capability-sdk/src';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function manifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    manifestVersion: CAPABILITY_MANIFEST_VERSION,
    id: 'dev.taracod.workspace-summary',
    version: '1.0.0',
    displayName: 'Workspace summary',
    description: 'Summarizes explicitly granted workspace files.',
    runtime: { kind: 'node', protocolVersion: CAPABILITY_PROTOCOL_VERSION },
    entrypoint: 'index.js',
    tools: [{
      name: 'workspace_summary',
      description: 'Summarize a workspace.',
      mutates: false,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { paths: { type: 'array', items: { type: 'string', maxLength: 260 }, maxItems: 20 } },
        required: ['paths'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { files: { type: 'integer', minimum: 0 } },
        required: ['files'],
      },
    }],
    permissions: [{ kind: 'filesystem.read', scope: { paths: ['**/*'] } }],
    effects: [],
    secretSlots: [],
    compatibility: {
      aiden: '>=4.20.0 <5.0.0',
      node: '>=20 <21 || >=22 <23',
      os: ['win32', 'linux', 'darwin'],
      architectures: ['x64', 'arm64'],
    },
    limits: {
      runtimeMs: 10_000,
      maxMessageBytes: 32_768,
      maxTotalOutputBytes: 262_144,
      maxBrokerRequests: 64,
      maxEvidenceClaims: 32,
    },
    digest: DIGEST,
    ...overrides,
  };
}

describe('Capability SDK contract', () => {
  it('accepts the narrow versioned Node manifest', () => {
    const result = validateCapabilityManifest(manifest());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects unknown fields and malformed immutable identity', () => {
    const value = { ...manifest(), ambientAuthority: true, id: '../escape', digest: 'not-a-digest' };
    const result = validateCapabilityManifest(value);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/unknown field.*ambientAuthority/i);
    expect(result.errors.join('\n')).toMatch(/capability id/i);
    expect(result.errors.join('\n')).toMatch(/digest/i);
  });

  it('rejects entrypoint traversal and unsupported executable runtimes', () => {
    const traversal = validateCapabilityManifest(manifest({ entrypoint: '../host.js' }));
    expect(traversal.ok).toBe(false);
    expect(traversal.errors.join('\n')).toMatch(/entrypoint/i);

    const python = validateCapabilityManifest(manifest({
      runtime: { kind: 'python' as 'node', protocolVersion: CAPABILITY_PROTOCOL_VERSION },
    }));
    expect(python.ok).toBe(false);
    expect(python.errors.join('\n')).toMatch(/runtime/i);
  });

  it('rejects schemas whose nesting exceeds the bounded contract', () => {
    let outputSchema: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 40; depth += 1) {
      outputSchema = { type: 'array', items: outputSchema };
    }
    const value = manifest({
      tools: [{ ...manifest().tools[0], outputSchema: outputSchema as CapabilityManifest['tools'][number]['outputSchema'] }],
    });
    const result = validateCapabilityManifest(value);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/schema.*depth|maximum depth/i);
  });

  it('validates invocation input and result output on the host side', () => {
    const inputSchema = manifest().tools[0].inputSchema;
    expect(validateJsonValue(inputSchema, { paths: ['package.json'] })).toEqual([]);
    expect(validateJsonValue(inputSchema, { paths: 'package.json' })).toContainEqual(
      expect.stringMatching(/array/i),
    );
    expect(validateJsonValue(inputSchema, { paths: [], extra: true })).toContainEqual(
      expect.stringMatching(/additional/i),
    );
  });

  it('runs a bounded author-facing conformance kit without host internals', () => {
    const result = runCapabilityConformance({
      manifest: manifest(),
      examples: [{ tool: 'workspace_summary', input: { paths: ['README.md'] }, output: { files: 1 } }],
    });
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      'manifest', 'example input:workspace_summary', 'example output:workspace_summary',
    ]));
    expect(JSON.stringify(result)).not.toMatch(/JobEngine|ActionAuthority|credential/i);
  });
});
