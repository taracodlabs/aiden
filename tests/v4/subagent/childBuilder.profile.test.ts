/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/subagent/childBuilder.profile.test.ts — v4.11 toolset grouping
 *
 * Child agents must inherit the parent's profile-narrowed toolset set
 * BEFORE the blocklist + requestedToolsets filters apply. The audit
 * locked this as invariant "subagent children inherit parent profile
 * + blocklist". This test exercises three cases:
 *
 *   1. parentProfileToolsets unset (legacy / `full` profile) — child
 *      sees every toolset the registry knows.
 *   2. parentProfileToolsets restricts to a subset — child sees only
 *      that subset (post-blocklist).
 *   3. requestedToolsets intersects with the profile, NEVER widens
 *      past it (so a `minimal` parent can't spawn a child with
 *      `subagent` tools by passing requestedToolsets: ['subagent']).
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { ToolContext, ToolHandler } from '../../../core/v4/toolRegistry';
import { buildChildAgent } from '../../../core/v4/subagent/childBuilder';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';

function tool(name: string, toolset: string): ToolHandler {
  return {
    schema:      { name, description: `t-${name}`, inputSchema: { type: 'object', properties: {}, required: [] } },
    execute:     async () => ({ ok: true }),
    category:    'read',
    mutates:     false,
    toolset,
  };
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(tool('file_read',   'files'));
  reg.register(tool('file_write',  'files'));
  reg.register(tool('web_search',  'web'));
  reg.register(tool('shell_exec',  'terminal'));
  reg.register(tool('browser_get', 'browser'));
  reg.register(tool('spawn_fake',  'subagent'));
  return reg;
}

function makeBaseDeps(registry: ToolRegistry) {
  const ctx: ToolContext = { cwd: process.cwd(), paths: {} as ToolContext['paths'] };
  return {
    toolRegistry:      registry,
    parentToolContext: ctx,
    parentProvider:    new MockProviderAdapter([MockProviderAdapter.stop('done')]),
    parentProviderId:  'mock',
    parentModelId:     'mock-model',
  };
}

describe('childBuilder — v4.11 parent-profile inheritance', () => {

  it('without parentProfileToolsets, child inherits every registered toolset', () => {
    const registry = makeRegistry();
    const { agent } = buildChildAgent(
      makeBaseDeps(registry),
      { sessionId: 's1', goal: 'g', maxIterations: 1 },
    );
    const names = new Set(
      (agent as unknown as { tools: { name: string }[] }).tools.map((t) => t.name),
    );
    // Every non-blocklisted tool from every toolset should be present.
    expect(names.has('file_read')).toBe(true);
    expect(names.has('web_search')).toBe(true);
    expect(names.has('browser_get')).toBe(true);
    expect(names.has('shell_exec')).toBe(true);
    // `spawn_*` group exists in registry; the blocklist only strips
    // `spawn_sub_agent` by exact name. `spawn_fake` survives.
    expect(names.has('spawn_fake')).toBe(true);
  });

  it('parentProfileToolsets narrows the child catalog to that profile', () => {
    const registry = makeRegistry();
    const { agent } = buildChildAgent(
      { ...makeBaseDeps(registry), parentProfileToolsets: ['files', 'terminal'] },
      { sessionId: 's2', goal: 'g', maxIterations: 1 },
    );
    const names = new Set(
      (agent as unknown as { tools: { name: string }[] }).tools.map((t) => t.name),
    );
    expect(names.has('file_read')).toBe(true);
    expect(names.has('shell_exec')).toBe(true);
    // web / browser / subagent toolsets were OUT of the parent profile.
    expect(names.has('web_search')).toBe(false);
    expect(names.has('browser_get')).toBe(false);
    expect(names.has('spawn_fake')).toBe(false);
  });

  it('requestedToolsets cannot widen past parentProfileToolsets', () => {
    const registry = makeRegistry();
    // Parent on a tight profile; model asks for a toolset OUTSIDE it.
    const { agent } = buildChildAgent(
      {
        ...makeBaseDeps(registry),
        parentProfileToolsets: ['files'],
      },
      {
        sessionId:          's3',
        goal:               'g',
        maxIterations:      1,
        // Request `web` — but `web` isn't in the parent's profile.
        // Strict intersection strips it → zero-tools fallback recovers
        // to the PARENT's profile (i.e. `files`), NOT to the registry.
        requestedToolsets:  ['web'],
      },
    );
    const names = new Set(
      (agent as unknown as { tools: { name: string }[] }).tools.map((t) => t.name),
    );
    // Fell back to parent profile (`files`); web tools must not appear.
    expect(names.has('file_read')).toBe(true);
    expect(names.has('web_search')).toBe(false);
    expect(names.has('browser_get')).toBe(false);
  });

  it('requestedToolsets intersects with parentProfileToolsets when valid', () => {
    const registry = makeRegistry();
    const { agent } = buildChildAgent(
      {
        ...makeBaseDeps(registry),
        parentProfileToolsets: ['files', 'web', 'terminal'],
      },
      {
        sessionId:         's4',
        goal:              'g',
        maxIterations:     1,
        requestedToolsets: ['web'],
      },
    );
    const names = new Set(
      (agent as unknown as { tools: { name: string }[] }).tools.map((t) => t.name),
    );
    // Intersection: { files, web, terminal } ∩ { web } = { web }
    expect(names.has('web_search')).toBe(true);
    expect(names.has('file_read')).toBe(false);
    expect(names.has('shell_exec')).toBe(false);
  });

  it('typo in parentProfileToolsets is silently filtered (not crash)', () => {
    const registry = makeRegistry();
    const { agent } = buildChildAgent(
      {
        ...makeBaseDeps(registry),
        // 'flles' is a typo; registry never had that toolset.
        parentProfileToolsets: ['files', 'flles', 'web'],
      },
      { sessionId: 's5', goal: 'g', maxIterations: 1 },
    );
    const names = new Set(
      (agent as unknown as { tools: { name: string }[] }).tools.map((t) => t.name),
    );
    // 'flles' is silently dropped; child still sees files+web.
    expect(names.has('file_read')).toBe(true);
    expect(names.has('web_search')).toBe(true);
    expect(names.has('shell_exec')).toBe(false);
  });
});
