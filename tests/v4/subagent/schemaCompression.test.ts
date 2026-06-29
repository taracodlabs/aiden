/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/subagent/schemaCompression.test.ts — v4.11 hi-budget fix
 *
 * Slice B trimmed `spawn_sub_agent` + `subagent_fanout` descriptions
 * from 1.4KB of design-doc prose to ~400B of operational facts.
 * These tests pin:
 *   - functional schema (required, types, enums) is UNCHANGED
 *   - top-level description is bounded (regression guard against
 *     someone re-inflating the prose later)
 *   - param names match the dispatch code's expectations
 */
import { describe, it, expect } from 'vitest';
import { SPAWN_SUB_AGENT_SCHEMA, makeSpawnSubAgentStub } from '../../../tools/v4/subagent/spawnSubAgentTool';
import { makeSubagentFanoutTool } from '../../../tools/v4/subagent/subagentFanout';

// Pin: post-trim descriptions stay under this cap. The pre-trim
// spawn_sub_agent description was ~1100 chars; trimmed target ~500.
// 700 is a comfortable ceiling that catches accidental re-inflation
// without forcing prose-golf in normal copyedits.
const MAX_TOP_LEVEL_DESC_CHARS = 700;

describe('spawn_sub_agent schema (post-v4.11 compression)', () => {
  it('top-level description stays compressed', () => {
    expect(SPAWN_SUB_AGENT_SCHEMA.description.length).toBeLessThan(MAX_TOP_LEVEL_DESC_CHARS);
  });

  it('preserves required functional fields', () => {
    expect(SPAWN_SUB_AGENT_SCHEMA.name).toBe('spawn_sub_agent');
    const schema = SPAWN_SUB_AGENT_SCHEMA.inputSchema as {
      type: string;
      required: string[];
      properties: Record<string, { type: string; items?: { enum?: string[] } }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['goal']);
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['context', 'goal', 'maxIterations', 'provider', 'timeoutMs', 'toolsets'].sort(),
    );
  });

  it('preserves toolsets enum (drives child intersection)', () => {
    const schema = SPAWN_SUB_AGENT_SCHEMA.inputSchema as {
      properties: { toolsets: { items: { enum: string[] } } };
    };
    const enumNames = schema.properties.toolsets.items.enum;
    // The dispatch code (childBuilder.ts) checks requested toolsets
    // against the live registry. If the model passes one of these
    // values, it MUST resolve to a real toolset — pin the full set.
    expect(enumNames).toContain('files');
    expect(enumNames).toContain('web');
    expect(enumNames).toContain('subagent');
    expect(enumNames).toContain('terminal');
    expect(enumNames.length).toBeGreaterThanOrEqual(12);
  });

  it('stub handler still produces the schema (post-compression)', () => {
    const stub = makeSpawnSubAgentStub();
    expect(stub.schema).toBe(SPAWN_SUB_AGENT_SCHEMA);
    expect(stub.toolset).toBe('subagent');
    expect(stub.contexts).toEqual(['repl']);
  });
});

describe('subagent_fanout schema (post-v4.11 compression)', () => {
  // Minimal factory stub — we only need the schema, not the runtime.
  const handler = makeSubagentFanoutTool({
    resolveTurnContext: () => undefined,
    coordinator:        {} as never,
    resolveProviders:   () => [],
    resolveActiveModel: () => ({ providerId: 'unset', modelId: 'unset' }),
    aggregatorAdapter:  {
      apiMode: 'chat_completions',
      async call() { throw new Error('test stub'); },
    } as never,
  });

  it('top-level description stays compressed', () => {
    expect(handler.schema.description.length).toBeLessThan(MAX_TOP_LEVEL_DESC_CHARS);
    // Verify the safety warning survived the trim — it's load-bearing.
    expect(handler.schema.description.toLowerCase()).toContain('verify');
  });

  it('preserves mode + merge enums (drive dispatch branches)', () => {
    const schema = handler.schema.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(['mode']);
    expect(schema.properties.mode.enum).toEqual(['partition', 'ensemble']);
    expect(schema.properties.merge.enum).toEqual(['all', 'vote', 'pick-best', 'combine']);
  });

  it('preserves all param names the runtime reads', () => {
    const schema = handler.schema.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['merge', 'mode', 'n', 'query', 'tasks', 'timeoutMs'].sort(),
    );
  });

  it('preserves tasks[].goal as required (partition-mode contract)', () => {
    const schema = handler.schema.inputSchema as {
      properties: { tasks: { items: { required: string[] } } };
    };
    expect(schema.properties.tasks.items.required).toEqual(['goal']);
  });
});
