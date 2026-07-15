import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApprovalEngine } from '../../moat/approvalEngine';

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

  it('records approval wait separately from actual handler execution', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      registry.register(makeHandler('timed-write', {
        category: 'write',
        mutates: true,
        async execute() {
          now += 6_000;
          return { ok: true };
        },
      }));
      const approvalEngine = new ApprovalEngine('manual', {
        promptUser: async () => {
          now += 8_000;
          return 'allow';
        },
      });
      const exec = registry.buildExecutor({ ...makeContext(), approvalEngine });

      const result = await exec(call('timed-write'));

      expect(result.activityTiming?.approvalStartedAt).toBe(1_000);
      expect(result.activityTiming?.approvalEndedAt).toBe(9_000);
      expect(result.activityTiming?.executionAttempts).toEqual([{
        attempt: 1,
        startedAt: 9_000,
        endedAt: 15_000,
        terminalResult: 'completed',
      }]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('records a delayed denial without fabricating handler execution', async () => {
    let now = 5_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const execute = vi.fn(async () => ({ ok: true }));
    try {
      registry.register(makeHandler('denied-write', { category: 'write', mutates: true, execute }));
      const approvalEngine = new ApprovalEngine('manual', {
        promptUser: async () => {
          now += 8_000;
          return 'deny';
        },
      });
      const exec = registry.buildExecutor({ ...makeContext(), approvalEngine });

      const result = await exec(call('denied-write'));

      expect(execute).not.toHaveBeenCalled();
      expect(result.activityTiming?.approvalEndedAt! - result.activityTiming?.approvalStartedAt!).toBe(8_000);
      expect(result.activityTiming?.executionAttempts).toEqual([]);
      expect(result.activityTiming?.terminalClassification).toBe('denied');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('cancellation during approval records no execution attempt', async () => {
    const controller = new AbortController();
    registry.register(makeHandler('cancelled-approval', { category: 'write', mutates: true }));
    const approvalEngine = new ApprovalEngine('manual', {
      promptUser: async () => {
        controller.abort();
        return 'interrupted';
      },
    });
    const result = await registry.buildExecutor({ ...makeContext(), approvalEngine })(
      call('cancelled-approval'), controller.signal,
    );
    expect(result.activityTiming?.executionAttempts).toEqual([]);
    expect(result.activityTiming?.terminalClassification).toBe('cancelled');
  });

  it('preserves approval interruption without requiring the turn signal to be aborted', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    registry.register(makeHandler('interrupted-approval', {
      category: 'write',
      mutates: true,
      execute,
    }));
    const approvalEngine = new ApprovalEngine('manual', {
      promptUser: async () => 'interrupted',
    });

    const result = await registry.buildExecutor({ ...makeContext(), approvalEngine })(
      call('interrupted-approval'),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.approvalDecision).toMatchObject({ state: 'interrupted', approved: false });
    expect(result.error).toMatch(/interrupted/i);
    expect(result.error).not.toMatch(/denied by approval engine/i);
    expect(result.activityTiming?.executionAttempts).toEqual([]);
    expect(result.activityTiming?.terminalClassification).toBe('cancelled');
  });

  it('preserves explicit denial as denied with no handler execution', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    registry.register(makeHandler('explicit-denial', {
      category: 'write',
      mutates: true,
      execute,
    }));
    const approvalEngine = new ApprovalEngine('manual', {
      promptUser: async () => 'deny',
    });

    const result = await registry.buildExecutor({ ...makeContext(), approvalEngine })(
      call('explicit-denial'),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.approvalDecision).toMatchObject({ state: 'denied', approved: false });
    expect({ ...result }.approvalDecision).toMatchObject({ state: 'denied', approved: false });
    expect(result.error).toMatch(/denied by approval engine/i);
    expect(result.activityTiming?.executionAttempts).toEqual([]);
    expect(result.activityTiming?.terminalClassification).toBe('denied');
  });

  it('keeps a hard security block distinct from denial and cancellation', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    registry.register(makeHandler('shell_exec', {
      category: 'execute',
      mutates: true,
      riskTier: 'dangerous',
      execute,
    }));
    const approvalEngine = new ApprovalEngine('off');

    const result = await registry.buildExecutor({ ...makeContext(), approvalEngine })(
      call('shell_exec', { command: 'rm -rf /' }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.approvalDecision).toMatchObject({ state: 'blocked', approved: false });
    expect(result.error).toMatch(/blocked/i);
    expect(result.error).not.toMatch(/you declined/i);
    expect(result.activityTiming?.terminalClassification).toBe('blocked');
  });

  it('cancellation during handler retains elapsed execution once', async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const controller = new AbortController();
    try {
      registry.register(makeHandler('cancelled-run', {
        async execute() {
          now = 2_500;
          controller.abort();
          throw new Error('interrupted');
        },
      }));
      const result = await registry.buildExecutor(makeContext())(call('cancelled-run'), controller.signal);
      expect(result.activityTiming?.executionDurationMs).toBe(2_500);
      expect(result.activityTiming?.executionAttempts).toHaveLength(1);
      expect(result.activityTiming?.terminalClassification).toBe('cancelled');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('timeout before handler records no execution duration', async () => {
    registry.register(makeHandler('approval-timeout', { category: 'write', mutates: true }));
    const approvalEngine = new ApprovalEngine('manual', {
      promptUser: async () => { throw new Error('approval timed out'); },
    });
    const result = await registry.buildExecutor({ ...makeContext(), approvalEngine })(call('approval-timeout'));
    expect(result.activityTiming?.executionAttempts).toEqual([]);
    expect(result.activityTiming?.executionDurationMs).toBe(0);
    expect(result.activityTiming?.terminalClassification).toBe('timed_out');
  });

  it('timeout during handler retains execution duration and one settlement', async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      registry.register(makeHandler('handler-timeout', {
        async execute() {
          now = 3_000;
          throw new Error('handler timeout');
        },
      }));
      const result = await registry.buildExecutor(makeContext())(call('handler-timeout'));
      expect(result.activityTiming?.executionDurationMs).toBe(3_000);
      expect(result.activityTiming?.executionAttempts).toHaveLength(1);
      expect(result.activityTiming?.terminalClassification).toBe('timed_out');
    } finally {
      nowSpy.mockRestore();
    }
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
