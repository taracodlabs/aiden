/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 perf — responseCache wired into v4 buildExecutor.
 *
 * Pre-fix: the v4 hot path (`ToolRegistry.buildExecutor`) called
 * `handler.execute` directly with no cache lookup. The legacy v3
 * `executeTool` already had cache wiring — this slice mirrors that
 * pattern into the v4 path so repeated tool calls in a research
 * workflow short-circuit instead of re-firing network requests.
 *
 * Tests:
 *   1. Second call to a cached-eligible tool (web_search) returns
 *      cached output WITHOUT re-invoking the handler.
 *   2. Calls to a NO_CACHE_TOOLS member (shell_exec, file_write)
 *      always re-invoke the handler.
 *   3. Calls to a tool with NO TTL config (handler succeeds but
 *      result isn't cacheable) always re-invoke.
 *   4. Failed calls (error result) DON'T populate the cache.
 *   5. Different argument shapes produce distinct cache keys.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { responseCache } from '../../../core/responseCache';

function makeTool(
  name:    string,
  execute: ToolHandler['execute'],
  opts:    Partial<Pick<ToolHandler, 'category' | 'mutates' | 'toolset'>> = {},
): ToolHandler {
  return {
    schema: {
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    execute,
    category: opts.category ?? 'read',
    mutates:  opts.mutates  ?? false,
    toolset:  opts.toolset  ?? 'test',
  };
}

describe('v4 toolRegistry responseCache wire (v4.11 perf)', () => {
  beforeEach(() => {
    // Wipe the singleton cache so each test starts clean. The
    // singleton persists across tests by design (in-process REPL
    // cache); the test-only reset gives us isolation.
    responseCache.clear();
  });

  it('1. second call to a TTL-eligible tool returns cached result (no re-invocation)', async () => {
    const reg = new ToolRegistry();
    let invocations = 0;
    reg.register(makeTool('web_search', async (args) => {
      invocations += 1;
      return `result for ${JSON.stringify(args)} — call #${invocations}`;
    }));
    const exec = reg.buildExecutor({});

    const r1 = await exec({ id: 'c1', name: 'web_search', arguments: { query: 'tokyo' } });
    expect(invocations).toBe(1);
    expect(r1.result).toContain('call #1');

    const r2 = await exec({ id: 'c2', name: 'web_search', arguments: { query: 'tokyo' } });
    // Handler NOT re-invoked — cached output returned.
    expect(invocations).toBe(1);
    // Cached output matches the first call's result verbatim
    // (responseCache stores strings; v4 wire returns the cached
    // string in result field).
    expect(r2.result).toBe(r1.result);
  });

  it('2. NO_CACHE_TOOLS member always re-invokes handler', async () => {
    const reg = new ToolRegistry();
    let invocations = 0;
    reg.register(makeTool('shell_exec', async (args) => {
      invocations += 1;
      return `shell output ${invocations} for ${JSON.stringify(args)}`;
    }, { mutates: true }));
    const exec = reg.buildExecutor({});

    await exec({ id: 'c1', name: 'shell_exec', arguments: { command: 'ls' } });
    await exec({ id: 'c2', name: 'shell_exec', arguments: { command: 'ls' } });
    // Both calls invoked the handler; cache bypassed via NO_CACHE_TOOLS.
    expect(invocations).toBe(2);
  });

  it('3. tool with no TTL config does not poison the cache', async () => {
    const reg = new ToolRegistry();
    let invocations = 0;
    // 'no_ttl_tool' isn't in responseCache's TOOL_TTL table → never
    // cached even on success. Second call re-invokes normally.
    reg.register(makeTool('no_ttl_tool', async () => {
      invocations += 1;
      return `output ${invocations}`;
    }));
    const exec = reg.buildExecutor({});

    await exec({ id: 'c1', name: 'no_ttl_tool', arguments: {} });
    await exec({ id: 'c2', name: 'no_ttl_tool', arguments: {} });
    expect(invocations).toBe(2);
  });

  it('4. failed call does NOT populate cache', async () => {
    const reg = new ToolRegistry();
    let invocations = 0;
    reg.register(makeTool('web_search', async () => {
      invocations += 1;
      throw new Error('network down');
    }));
    const exec = reg.buildExecutor({});

    const r1 = await exec({ id: 'c1', name: 'web_search', arguments: { query: 'x' } });
    expect(r1.error).toBeTruthy();
    expect(invocations).toBe(1);
    // Second call should re-invoke since the error wasn't cached.
    const r2 = await exec({ id: 'c2', name: 'web_search', arguments: { query: 'x' } });
    expect(r2.error).toBeTruthy();
    expect(invocations).toBe(2);
  });

  it('5. different args produce distinct cache keys', async () => {
    const reg = new ToolRegistry();
    let invocations = 0;
    reg.register(makeTool('web_search', async (args) => {
      invocations += 1;
      return `result for ${JSON.stringify(args)}`;
    }));
    const exec = reg.buildExecutor({});

    await exec({ id: 'c1', name: 'web_search', arguments: { query: 'tokyo' } });
    await exec({ id: 'c2', name: 'web_search', arguments: { query: 'osaka' } });
    // Different queries → different cache keys → both invoke handler.
    expect(invocations).toBe(2);
    // Re-running each returns its own cached result.
    const r3 = await exec({ id: 'c3', name: 'web_search', arguments: { query: 'tokyo' } });
    const r4 = await exec({ id: 'c4', name: 'web_search', arguments: { query: 'osaka' } });
    expect(invocations).toBe(2);
    expect(r3.result).toContain('tokyo');
    expect(r4.result).toContain('osaka');
  });
});
