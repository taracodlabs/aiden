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

  it('8b. getSchemas() excludeToolsets removes named toolsets (v4.11)', () => {
    registry.register(makeHandler('a', { toolset: 'web' }));
    registry.register(makeHandler('u1', { toolset: 'ui' }));
    registry.register(makeHandler('b', { toolset: 'files' }));
    registry.register(makeHandler('u2', { toolset: 'ui' }));
    // Exclude wins even with NO include filter (the `full` profile case).
    expect(registry.getSchemas(undefined, undefined, ['ui']).map((s) => s.name))
      .toEqual(['a', 'b']);
    // Exclude composes with an include filter.
    expect(registry.getSchemas(['web', 'ui'], undefined, ['ui']).map((s) => s.name))
      .toEqual(['a']);
    // Empty / omitted exclude is a no-op (back-compat).
    expect(registry.getSchemas(undefined, undefined, []).map((s) => s.name))
      .toEqual(['a', 'u1', 'b', 'u2']);
    expect(registry.getSchemas().map((s) => s.name))
      .toEqual(['a', 'u1', 'b', 'u2']);
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

  // ── v4.1.3-repl-polish: degraded-outcome lift ─────────────────────────
  //
  // buildExecutor must surface `degraded` / `degradedReason` from the
  // inner handler result up to the outer ToolCallResult. Without this
  // lift the CLI trail-row renderer (callbacks.ts → display.toolRow)
  // would never see the partial-yellow state — the flags would sit on
  // `out.result.degraded` instead of `out.degraded`.

  it('12. degraded=true on inner result is lifted to outer ToolCallResult', async () => {
    registry.register(
      makeHandler('partial', {
        async execute() {
          return {
            success: true,
            data: 'something',
            degraded: true,
            degradedReason: 'used cached fallback',
          };
        },
      }),
    );
    const exec = registry.buildExecutor(makeContext());
    const res = await exec(call('partial'));
    expect(res.degraded).toBe(true);
    expect(res.degradedReason).toBe('used cached fallback');
    // Inner result preserved unchanged — the model still sees the full
    // handler payload, including the (now-also-lifted) flag fields.
    expect(res.result).toEqual({
      success: true,
      data: 'something',
      degraded: true,
      degradedReason: 'used cached fallback',
    });
    expect(res.error).toBeUndefined();
  });

  it('13. degraded=false is NOT promoted (treated as ordinary success)', async () => {
    registry.register(
      makeHandler('clean', {
        async execute() {
          return { success: true, degraded: false };
        },
      }),
    );
    const exec = registry.buildExecutor(makeContext());
    const res = await exec(call('clean'));
    expect(res.degraded).toBeUndefined();
    expect(res.degradedReason).toBeUndefined();
  });

  it('14. wrong-shape degraded values are ignored (string, number, object)', async () => {
    const shapes: Array<unknown> = ['true', 1, { nested: true }, null];
    for (const bad of shapes) {
      registry.register(
        makeHandler(`weird-${typeof bad}-${String(bad)}`, {
          async execute() {
            return { success: true, degraded: bad };
          },
        }),
      );
      const exec = registry.buildExecutor(makeContext());
      const res = await exec(call(`weird-${typeof bad}-${String(bad)}`));
      expect(res.degraded).toBeUndefined();
      expect(res.degradedReason).toBeUndefined();
    }
  });

  it('15. degraded=true with non-string reason: flag lifted, reason dropped', async () => {
    registry.register(
      makeHandler('reasonless', {
        async execute() {
          return { success: true, degraded: true, degradedReason: 42 };
        },
      }),
    );
    const exec = registry.buildExecutor(makeContext());
    const res = await exec(call('reasonless'));
    expect(res.degraded).toBe(true);
    expect(res.degradedReason).toBeUndefined();
  });

  it('16. handler returning a primitive (string) does not crash the lift', async () => {
    registry.register(
      makeHandler('plain', {
        async execute() {
          return 'just a string';
        },
      }),
    );
    const exec = registry.buildExecutor(makeContext());
    const res = await exec(call('plain'));
    expect(res.result).toBe('just a string');
    expect(res.degraded).toBeUndefined();
    expect(res.error).toBeUndefined();
  });

  it('17. handler returning null does not crash the lift', async () => {
    registry.register(
      makeHandler('nullish', {
        async execute() {
          return null;
        },
      }),
    );
    const exec = registry.buildExecutor(makeContext());
    const res = await exec(call('nullish'));
    expect(res.result).toBeNull();
    expect(res.degraded).toBeUndefined();
    expect(res.error).toBeUndefined();
  });
});
