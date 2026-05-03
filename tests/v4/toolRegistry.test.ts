import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  ToolRegistry,
  type ToolContext,
  type ToolHandler,
} from '../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../core/v4/paths';
import type {
  ToolCallRequest,
  ToolSchema,
} from '../../providers/v4/types';

const makeSchema = (name: string, extra: Partial<ToolSchema> = {}): ToolSchema => ({
  name,
  description: extra.description ?? `${name} description`,
  inputSchema: extra.inputSchema ?? {
    type: 'object',
    properties: {},
  },
});

const makeHandler = (
  name: string,
  overrides: Partial<ToolHandler> = {},
): ToolHandler => ({
  schema: makeSchema(name),
  category: 'read',
  mutates: false,
  toolset: 'misc',
  async execute(args) {
    return { echoed: args };
  },
  ...overrides,
});

const makeContext = (): ToolContext => ({
  cwd: process.cwd(),
  paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-test-root' }),
});

const call = (name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({
  id: `call-${name}`,
  name,
  arguments: args,
});

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('1. register/get round-trip returns the same handler', () => {
    const h = makeHandler('alpha');
    registry.register(h);
    expect(registry.get('alpha')).toBe(h);
  });

  it('2. unregister removes the handler from get/list', () => {
    registry.register(makeHandler('alpha'));
    registry.unregister('alpha');
    expect(registry.get('alpha')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('3. buildExecutor returns a callable function', async () => {
    registry.register(makeHandler('alpha'));
    const exec = registry.buildExecutor(makeContext());
    expect(typeof exec).toBe('function');
    const res = await exec(call('alpha', { x: 1 }));
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ echoed: { x: 1 } });
    expect(res.id).toBe('call-alpha');
    expect(res.name).toBe('alpha');
  });

  it('4. buildExecutor returns an error result for an unknown tool (does not throw)', async () => {
    const exec = registry.buildExecutor(makeContext());
    const res = await exec(call('nope'));
    expect(res.error).toMatch(/not registered/);
    expect(res.result).toBeNull();
    expect(res.id).toBe('call-nope');
  });

  it('5. buildExecutor catches handler throws and surfaces them as errors', async () => {
    registry.register(
      makeHandler('boom', {
        async execute() {
          throw new Error('kaboom');
        },
      }),
    );
    const exec = registry.buildExecutor(makeContext());
    const res = await exec(call('boom'));
    expect(res.error).toBe('kaboom');
    expect(res.result).toBeNull();
  });

  it('6. buildExecutor passes the context object through to the handler', async () => {
    const seen = vi.fn();
    registry.register(
      makeHandler('peek', {
        async execute(_args, ctx) {
          seen(ctx);
          return 'ok';
        },
      }),
    );
    const ctx = makeContext();
    const exec = registry.buildExecutor(ctx);
    await exec(call('peek'));
    expect(seen).toHaveBeenCalledWith(ctx);
  });

  it('7. getSchemas() with no filter returns all schemas in insertion order', () => {
    registry.register(makeHandler('a', { toolset: 'web' }));
    registry.register(makeHandler('b', { toolset: 'files' }));
    registry.register(makeHandler('c', { toolset: 'web' }));
    expect(registry.getSchemas().map((s) => s.name)).toEqual(['a', 'b', 'c']);
  });

  it('8. getSchemas() filtered by toolset returns only matching tools', () => {
    registry.register(makeHandler('a', { toolset: 'web' }));
    registry.register(makeHandler('b', { toolset: 'files' }));
    registry.register(makeHandler('c', { toolset: 'web' }));
    expect(registry.getSchemas(['web']).map((s) => s.name)).toEqual(['a', 'c']);
    expect(registry.getSchemas(['files']).map((s) => s.name)).toEqual(['b']);
    expect(registry.getSchemas(['none'])).toEqual([]);
  });

  it('9. byCategory returns handlers matching the requested category', () => {
    registry.register(makeHandler('r1', { category: 'read' }));
    registry.register(makeHandler('w1', { category: 'write', mutates: true }));
    registry.register(makeHandler('r2', { category: 'read' }));
    const reads = registry.byCategory('read');
    expect(reads.map((h) => h.schema.name).sort()).toEqual(['r1', 'r2']);
    const writes = registry.byCategory('write');
    expect(writes.map((h) => h.schema.name)).toEqual(['w1']);
    expect(registry.byCategory('execute')).toEqual([]);
  });

  it('10. registering the same name twice overwrites the prior handler', async () => {
    registry.register(
      makeHandler('alpha', {
        async execute() {
          return 'first';
        },
      }),
    );
    registry.register(
      makeHandler('alpha', {
        async execute() {
          return 'second';
        },
      }),
    );
    expect(registry.list()).toEqual(['alpha']);
    const exec = registry.buildExecutor(makeContext());
    const res = await exec(call('alpha'));
    expect(res.result).toBe('second');
  });

  it('11. arguments default to {} when call.arguments is undefined', async () => {
    const seen = vi.fn();
    registry.register(
      makeHandler('peek', {
        async execute(args) {
          seen(args);
          return 'ok';
        },
      }),
    );
    const exec = registry.buildExecutor(makeContext());
    await exec({ id: 'x', name: 'peek', arguments: undefined as unknown as Record<string, unknown> });
    expect(seen).toHaveBeenCalledWith({});
  });
});
