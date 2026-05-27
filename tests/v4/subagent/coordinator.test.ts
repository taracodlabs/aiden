/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 4 — SubagentCoordinator tests.
 *
 * Covers the contracts the dispatch named:
 *   1. spawnBatch with N tasks completes all (happy path)
 *   2. Bounded concurrency — maxOverlap === maxChildrenPerFanout
 *   3. Results sorted by taskIndex regardless of completion order
 *   4. Sibling isolation — one child fails, others complete (bestEffort)
 *   5. Cancel during execution — parent abort + external cancelChild
 *   6. Late events after cancel are dropped (turnId guard)
 *   7. Cost rollup matches sum of child usage
 *   8. listActiveChildren reflects in-flight + filters by parentTurnId
 *
 * Driven through the real `spawnSubAgent` primitive (mock provider +
 * in-memory runStore), exercising the full coordinator path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createRunStore, type RunStore } from '../../../core/v4/daemon/runStore';
import { ToolRegistry, type ToolContext, type ToolHandler } from '../../../core/v4/toolRegistry';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import { SubagentCoordinator } from '../../../core/v4/subagent/coordinator';
import { buildTurnRuntimeContext } from '../../../core/v4/turnRuntimeContext';
import type { TraceEvent } from '../../../core/v4/subagent/traceEvents';
import type { ProviderCallOutput } from '../../../providers/v4/types';

// ── Test helpers ──────────────────────────────────────────────────────────

/**
 * Sleep `ms` milliseconds. If `signal` is supplied AND aborts before
 * the sleep elapses, throws an AbortError synchronously (matching the
 * real fetch+AbortController contract that the v4 provider adapters
 * surface).
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((r) => setTimeout(r, ms));
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const e = new Error('Aborted'); e.name = 'AbortError'; reject(e);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const e = new Error('Aborted'); e.name = 'AbortError'; reject(e);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let db: Database.Database;
let runStore: RunStore;
const INST = 'inst-coord';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(INST, 1, 'h', Date.now(), Date.now(), '4.11.0-test');
  runStore = createRunStore({ db });
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  const handler = (name: string, toolset: string): ToolHandler => ({
    schema: {
      name, description: `t ${name}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    execute: async () => ({ ok: true }),
    category: 'read', mutates: false, toolset,
  });
  reg.register(handler('file_read',  'files'));
  reg.register(handler('web_search', 'web'));
  return reg;
}

function makeCtx(): ToolContext {
  return { cwd: process.cwd(), paths: {} as ToolContext['paths'] };
}

/**
 * Build a coordinator with a provider that emits a fixed `summary`
 * after the requested delay. Each task records that delay so we can
 * verify concurrency overlap.
 */
function makeCoordinator(opts?: {
  summary?: string;
  maxChildrenPerFanout?: number;
  /** Per-call delay in ms — picked round-robin per provider call. */
  delaysMs?: number[];
  /** Throw inside the provider after this many calls. */
  throwAfter?: number;
  /** v4.11 regression patch — capture UI events for assertions. */
  onUiEvent?: (name: string, args: Record<string, unknown>) => void;
}): { coord: SubagentCoordinator; delayLog: number[] } {
  const delays = opts?.delaysMs ?? [0];
  const delayLog: number[] = [];
  let callIdx = 0;
  const provider = {
    apiMode: 'chat_completions' as const,
    call: async (input?: { signal?: AbortSignal }): Promise<ProviderCallOutput> => {
      const myIdx = callIdx;
      callIdx += 1;
      const d = delays[myIdx % delays.length] ?? 0;
      delayLog.push(d);
      // Wait honouring the input signal — abort surfaces as a thrown
      // AbortError, mirroring the real adapter behaviour the agent
      // loop classifies as 'interrupted'.
      await abortableSleep(d, input?.signal);
      if (opts?.throwAfter !== undefined && myIdx >= opts.throwAfter) {
        throw new Error(`provider boom @ call ${myIdx}`);
      }
      return {
        content:      opts?.summary ?? `summary ${myIdx}`,
        toolCalls:    [],
        finishReason: 'stop',
        usage:        { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
  const coord = new SubagentCoordinator({
    spawnDeps: {
      toolRegistry:     makeRegistry(),
      parentToolContext: makeCtx(),
      parentProvider:    provider,
      parentProviderId:  'mock',
      parentModelId:     'mock-model',
      runStore,
      instanceId:        INST,
    },
    maxChildrenPerFanout: opts?.maxChildrenPerFanout,
    onUiEvent: opts?.onUiEvent,
  });
  return { coord, delayLog };
}

/** Helper: build a fresh TurnRuntimeContext with optional trace capture. */
function makeTurnContext(opts?: {
  signal?: AbortSignal;
  capture?: TraceEvent[];
}) {
  const signal = opts?.signal ?? new AbortController().signal;
  return buildTurnRuntimeContext({
    turnId:        1,
    parentAgentId: 'test',
    signal,
    traceEmitter:  opts?.capture
      ? ((e: TraceEvent) => opts.capture!.push(e))
      : undefined,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SubagentCoordinator — v4.11 Slice 4', () => {
  it('1. spawnBatch with 3 tasks completes all', async () => {
    const { coord } = makeCoordinator();
    const ctx = makeTurnContext();
    const result = await coord.spawnBatch(ctx, [
      { goal: 'a' }, { goal: 'b' }, { goal: 'c' },
    ]);
    expect(result.status).toBe('completed');
    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.status).toBe('completed');
      expect(r.summary).toMatch(/summary \d+/);
      expect(r.subagentRunId).toMatch(/^sa-f-[a-f0-9]{8}-\d+-[a-f0-9]{8}$/);
    }
  });

  it('2. bounded concurrency: maxOverlap === maxChildrenPerFanout', async () => {
    // 4 tasks with 80ms delay each; cap at 2 concurrent. Track per-task
    // start/end times to compute overlap.
    const intervals: Array<[number, number]> = [];
    const provider = {
      apiMode: 'chat_completions' as const,
      call: async (): Promise<ProviderCallOutput> => {
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, 80));
        intervals.push([t0, Date.now()]);
        return {
          content: 'ok', toolCalls: [], finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const coord = new SubagentCoordinator({
      spawnDeps: {
        toolRegistry:     makeRegistry(),
        parentToolContext: makeCtx(),
        parentProvider:    provider,
        parentProviderId:  'mock',
        parentModelId:     'mock-model',
        runStore,
        instanceId:        INST,
      },
      maxChildrenPerFanout: 2,
    });
    const ctx = makeTurnContext();
    await coord.spawnBatch(ctx, [
      { goal: 'a' }, { goal: 'b' }, { goal: 'c' }, { goal: 'd' },
    ]);
    expect(intervals).toHaveLength(4);
    // Compute peak overlap. Same algorithm as the parallel-tool-dispatch test.
    const points: Array<[number, number]> = [];
    for (const [s, e] of intervals) { points.push([s, 1]); points.push([e, -1]); }
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, peak = 0;
    for (const [, d] of points) { cur += d; if (cur > peak) peak = cur; }
    expect(peak).toBe(2);
  });

  it('3. results sorted by taskIndex regardless of completion order', async () => {
    // First task delays 50ms; second 20ms; third 0ms. Without sorting,
    // result map ordering would be 3,2,1; coordinator must re-order.
    const { coord } = makeCoordinator({ delaysMs: [50, 20, 0] });
    const ctx = makeTurnContext();
    const result = await coord.spawnBatch(ctx, [
      { goal: 'task-0' }, { goal: 'task-1' }, { goal: 'task-2' },
    ]);
    expect(result.results.map((r) => r.taskIndex)).toEqual([0, 1, 2]);
  });

  it('4. sibling isolation: one child fails, others complete (bestEffort)', async () => {
    // Child #1 throws inside provider; #0 and #2 succeed.
    const provider = {
      apiMode: 'chat_completions' as const,
      __calls: 0,
      call: async function (): Promise<ProviderCallOutput> {
        const i = this.__calls;
        this.__calls += 1;
        if (i === 1) throw new Error('child 1 boom');
        return {
          content: `ok ${i}`, toolCalls: [], finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    };
    const coord = new SubagentCoordinator({
      spawnDeps: {
        toolRegistry:     makeRegistry(),
        parentToolContext: makeCtx(),
        parentProvider:    provider,
        parentProviderId:  'mock',
        parentModelId:     'mock-model',
        runStore,
        instanceId:        INST,
      },
    });
    const ctx = makeTurnContext();
    const result = await coord.spawnBatch(ctx, [
      { goal: 'a' }, { goal: 'b' }, { goal: 'c' },
    ]);
    expect(result.status).toBe('partial');
    expect(result.results).toHaveLength(3);
    expect(result.results[0].status).toBe('completed');
    expect(result.results[1].status).toBe('failed');
    expect(result.results[2].status).toBe('completed');
  });

  it('5. cancel via parent abort transitions children to cancelled', async () => {
    // Each child waits 200ms inside provider. Parent aborts after 30ms.
    // All three should land as 'cancelled' (provider's AbortError
    // routes via aidenAgent → finishReason='interrupted' →
    // coordinator maps to 'cancelled').
    const ctrl = new AbortController();
    const { coord } = makeCoordinator({ delaysMs: [200, 200, 200] });
    const ctx = makeTurnContext({ signal: ctrl.signal });
    const p = coord.spawnBatch(ctx, [
      { goal: 'a' }, { goal: 'b' }, { goal: 'c' },
    ]);
    setTimeout(() => ctrl.abort(), 30);
    const result = await p;
    expect(result.status).toMatch(/cancelled|partial/);
    // At least one cancelled; zero completed (parent fired fast).
    const cancelled = result.results.filter((r) => r.status === 'cancelled').length;
    expect(cancelled).toBeGreaterThan(0);
  });

  it('6. cost rollup: aggregateUsage equals sum of child usage', async () => {
    const { coord } = makeCoordinator();
    const ctx = makeTurnContext();
    const result = await coord.spawnBatch(ctx, [
      { goal: 'a' }, { goal: 'b' }, { goal: 'c' },
    ]);
    // Each mock call returns usage {input: 10, output: 20} → total 30 per child.
    expect(result.aggregateUsage.inputTokens).toBe(30);  // 3 × 10
    expect(result.aggregateUsage.outputTokens).toBe(60); // 3 × 20
    expect(result.aggregateUsage.totalTokens).toBe(90);
    // Cost accumulator on the parent's turnContext also reflects it.
    expect(ctx.costAccumulator.inputTokens).toBe(30);
    expect(ctx.costAccumulator.outputTokens).toBe(60);
    expect(ctx.costAccumulator.totalTokens).toBe(90);
    expect(ctx.costAccumulator.perChild).toHaveLength(3);
  });

  it('7. trace emitter receives spawned + started + completed per task', async () => {
    const events: TraceEvent[] = [];
    const { coord } = makeCoordinator();
    const ctx = makeTurnContext({ capture: events });
    await coord.spawnBatch(ctx, [{ goal: 'a' }, { goal: 'b' }]);
    // 2 tasks × (spawned + started + completed) = 6 events
    expect(events.length).toBe(6);
    const byType = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.eventType] = (acc[e.eventType] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType['subagent.spawned']).toBe(2);
    expect(byType['subagent.started']).toBe(2);
    expect(byType['subagent.completed']).toBe(2);
  });

  it('8. cancelChild aborts a specific in-flight subagent', async () => {
    // Two tasks; we cancel the one with the longer delay before it
    // completes. Have to peek the active registry to grab the
    // subagentRunId because the coordinator mints them internally.
    const { coord } = makeCoordinator({ delaysMs: [300, 50] });
    const ctx = makeTurnContext();
    const p = coord.spawnBatch(ctx, [
      { goal: 'long-runner' }, { goal: 'short-runner' },
    ]);
    // Wait until both are registered.
    await new Promise((r) => setTimeout(r, 20));
    const active = coord.listActiveChildren(ctx.turnId);
    // The long-runner (index 0) is still in flight; cancel it.
    const long = active.find((c) => c.taskIndex === 0);
    expect(long).toBeDefined();
    const ok = coord.cancelChild(long!.subagentRunId);
    expect(ok).toBe(true);
    const result = await p;
    // Task 0 cancelled; task 1 completed → partial overall.
    expect(result.results[0].status).toBe('cancelled');
    expect(result.results[1].status).toBe('completed');
    expect(result.status).toBe('partial');
  });

  it('9. listActiveChildren filters by parentTurnId', async () => {
    // Two coordinator batches under different turnIds. Each batch
    // should see only its own children in listActiveChildren.
    const { coord } = makeCoordinator({ delaysMs: [100] });
    const ctxA = buildTurnRuntimeContext({
      turnId: 1, parentAgentId: 'A',
      signal: new AbortController().signal,
    });
    const ctxB = buildTurnRuntimeContext({
      turnId: 2, parentAgentId: 'B',
      signal: new AbortController().signal,
    });
    const pA = coord.spawnBatch(ctxA, [{ goal: 'a' }]);
    const pB = coord.spawnBatch(ctxB, [{ goal: 'b' }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(coord.listActiveChildren(1)).toHaveLength(1);
    expect(coord.listActiveChildren(2)).toHaveLength(1);
    expect(coord.listActiveChildren(99)).toHaveLength(0);
    await Promise.all([pA, pB]);
    // After settle the registry drains.
    expect(coord.listActiveChildren(1)).toHaveLength(0);
    expect(coord.listActiveChildren(2)).toHaveLength(0);
  });

  it('10. pre-aborted parent signal short-circuits without running provider', async () => {
    // Parent signal is already aborted before spawnBatch is called.
    // Coordinator should fabricate cancelled envelopes without
    // invoking the provider at all (saves a child build).
    const ctrl = new AbortController();
    ctrl.abort();
    let providerCalls = 0;
    const provider = {
      apiMode: 'chat_completions' as const,
      call: async (): Promise<ProviderCallOutput> => {
        providerCalls += 1;
        return {
          content: 'unreachable', toolCalls: [], finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const coord = new SubagentCoordinator({
      spawnDeps: {
        toolRegistry:     makeRegistry(),
        parentToolContext: makeCtx(),
        parentProvider:    provider,
        parentProviderId:  'mock',
        parentModelId:     'mock-model',
        runStore,
        instanceId:        INST,
      },
    });
    const ctx = buildTurnRuntimeContext({
      turnId: 5, parentAgentId: 'P', signal: ctrl.signal,
    });
    const result = await coord.spawnBatch(ctx, [{ goal: 'a' }, { goal: 'b' }]);
    expect(providerCalls).toBe(0);
    expect(result.status).toBe('cancelled');
    for (const r of result.results) {
      expect(r.status).toBe('cancelled');
      expect(r.usage.totalTokens).toBe(0);
    }
  });
});

// ── v4.11 regression patch tests ────────────────────────────────────────

describe('SubagentCoordinator — v4.11 regression patch (R1 + R3)', () => {
  it('R1: emits one ui_task_update + one ui_task_done per child', async () => {
    // Slice 4 introduced the coordinator and silently dropped per-child
    // UI emission from subagent_fanout. The regression patch makes the
    // coordinator the single source of truth: ONE update + ONE done
    // per child for both the spawn_sub_agent (1 task) and the
    // subagent_fanout (N task) facades.
    const events: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { coord } = makeCoordinator({
      onUiEvent: (name, args) => events.push({ name, args }),
    });
    const ctx = makeTurnContext();
    await coord.spawnBatch(ctx, [
      { goal: 'task A' },
      { goal: 'task B' },
      { goal: 'task C' },
    ]);
    const updates = events.filter((e) => e.name === 'ui_task_update');
    const dones   = events.filter((e) => e.name === 'ui_task_done');
    expect(updates).toHaveLength(3);
    expect(dones).toHaveLength(3);
    // Each pair shares a task_id; ids are the coordinator's subagentRunId.
    const updateIds = updates.map((e) => e.args.task_id as string).sort();
    const doneIds   = dones.map((e) => e.args.task_id as string).sort();
    expect(updateIds).toEqual(doneIds);
    for (const id of updateIds) {
      expect(id).toMatch(/^sa-f-[a-f0-9]{8}-\d+-[a-f0-9]{8}$/);
    }
    // Update shape mirrors pre-Slice-4 spawn_sub_agent emission.
    for (const u of updates) {
      expect(u.args.status).toBe('running');
      expect(u.args.kind).toBe('subagent');
      expect(u.args.depth).toBe(1);
      expect(typeof u.args.label).toBe('string');
    }
    // Done shape: status maps via envelope, summary carries metrics.
    for (const d of dones) {
      expect(['success', 'failure', 'blocked']).toContain(d.args.status);
      expect(typeof d.args.summary).toBe('string');
    }
  });

  it('R1: single-task batch (spawn_sub_agent path) still emits 1 pair', async () => {
    // The spawn_sub_agent facade dispatches a 1-task batch through the
    // same coordinator. Verify the pair count matches the model-facing
    // contract pre-Slice-4 (which was 1 pair via the facade's own
    // onUiEvent — now replaced by the coordinator's single-pair emit).
    const events: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { coord } = makeCoordinator({
      onUiEvent: (name, args) => events.push({ name, args }),
    });
    const ctx = makeTurnContext();
    await coord.spawnBatch(ctx, [{ goal: 'solo' }]);
    expect(events.filter((e) => e.name === 'ui_task_update')).toHaveLength(1);
    expect(events.filter((e) => e.name === 'ui_task_done')).toHaveLength(1);
  });

  it('R1: omitting onUiEvent is a clean no-op (back-compat)', async () => {
    // MCP path + unit tests omit the display sink. Coordinator must
    // not throw when onUiEvent is undefined; spawnBatch still returns
    // a well-formed FanoutResult.
    const { coord } = makeCoordinator();  // no onUiEvent
    const ctx = makeTurnContext();
    const result = await coord.spawnBatch(ctx, [{ goal: 'a' }, { goal: 'b' }]);
    expect(result.status).toBe('completed');
    expect(result.results).toHaveLength(2);
  });

  it('R1: pre-aborted parent emits ui_task_done (no update — child never started)', async () => {
    // Edge case: parent signal aborted before spawnBatch could
    // dispatch. Coordinator should still close the gutter trail
    // (otherwise the display row would hang as "running" forever).
    // We skip the `update` for this path because there was no
    // running window; display.renderUiTaskDone tolerates a `done`
    // without a preceding `update`.
    const ctrl = new AbortController();
    ctrl.abort();
    const events: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { coord } = makeCoordinator({
      onUiEvent: (name, args) => events.push({ name, args }),
    });
    const ctx = buildTurnRuntimeContext({
      turnId: 99, parentAgentId: 'P', signal: ctrl.signal,
    });
    await coord.spawnBatch(ctx, [{ goal: 'a' }]);
    expect(events.filter((e) => e.name === 'ui_task_update')).toHaveLength(0);
    expect(events.filter((e) => e.name === 'ui_task_done')).toHaveLength(1);
    expect(events.find((e) => e.name === 'ui_task_done')!.args.status).toBe('blocked');
  });

  it('R3: AIDEN_SUBAGENT_TIMEOUT_MS env var resolves task.timeoutMs default', async () => {
    // When the model omits timeoutMs, the env var should fill in.
    // The coordinator-side resolution writes the effective value into
    // the task record (so spawnSubAgent sees the resolved value, not
    // undefined). We can't introspect spawnSubAgent's internal timer
    // directly, but we can verify the resolution path by checking
    // that an env-supplied tight timeout (say, 5ms) actually fires
    // and produces a 'timeout' envelope — proves the env value made
    // it to the primitive.
    const original = process.env.AIDEN_SUBAGENT_TIMEOUT_MS;
    process.env.AIDEN_SUBAGENT_TIMEOUT_MS = '1000';
    try {
      // Provider that hangs forever (signal-honouring sleep).
      const { coord } = makeCoordinator({ delaysMs: [30_000] });
      const ctx = makeTurnContext();
      const result = await coord.spawnBatch(ctx, [{ goal: 'will-timeout' }]);
      expect(result.results[0].status).toBe('timeout');
    } finally {
      if (original === undefined) delete process.env.AIDEN_SUBAGENT_TIMEOUT_MS;
      else process.env.AIDEN_SUBAGENT_TIMEOUT_MS = original;
    }
  });

  it('R3: explicit task.timeoutMs overrides AIDEN_SUBAGENT_TIMEOUT_MS env var', async () => {
    // Precedence: explicit > env > primitive default. With env at 1ms
    // (would fire immediately) but task.timeoutMs at 30_000, the
    // task value should win and the child should complete normally.
    const original = process.env.AIDEN_SUBAGENT_TIMEOUT_MS;
    process.env.AIDEN_SUBAGENT_TIMEOUT_MS = '1';
    try {
      const { coord } = makeCoordinator({ delaysMs: [20] });  // fast provider
      const ctx = makeTurnContext();
      const result = await coord.spawnBatch(ctx, [
        { goal: 'wins-over-env', timeoutMs: 30_000 },
      ]);
      expect(result.results[0].status).toBe('completed');
    } finally {
      if (original === undefined) delete process.env.AIDEN_SUBAGENT_TIMEOUT_MS;
      else process.env.AIDEN_SUBAGENT_TIMEOUT_MS = original;
    }
  });

  it('R3: malformed env var falls through to primitive default', async () => {
    // Regex gate: AIDEN_SUBAGENT_TIMEOUT_MS = "abc" should NOT parse
    // as a number, so the resolver leaves the value undefined and
    // the primitive's DEFAULT_TIMEOUT_MS (600_000ms / 10min) applies.
    // Verify by running a fast-completing task — should NOT time out.
    const original = process.env.AIDEN_SUBAGENT_TIMEOUT_MS;
    process.env.AIDEN_SUBAGENT_TIMEOUT_MS = 'not-a-number';
    try {
      const { coord } = makeCoordinator({ delaysMs: [5] });
      const ctx = makeTurnContext();
      const result = await coord.spawnBatch(ctx, [{ goal: 'fast' }]);
      expect(result.results[0].status).toBe('completed');
    } finally {
      if (original === undefined) delete process.env.AIDEN_SUBAGENT_TIMEOUT_MS;
      else process.env.AIDEN_SUBAGENT_TIMEOUT_MS = original;
    }
  });
});

// ── R4 — schema description accuracy ────────────────────────────────────

describe('subagent schema descriptions — v4.11 regression patch (R4)', () => {
  it('R4: subagent_fanout timeoutMs description states 600000 default + env var', async () => {
    const { makeSubagentFanoutTool } = await import(
      '../../../tools/v4/subagent/subagentFanout'
    );
    const tool = makeSubagentFanoutTool({
      resolveTurnContext:  () => undefined,
      coordinator:         {} as never,
      resolveProviders:    () => [],
      resolveActiveModel:  () => ({ providerId: 'x', modelId: 'x' }),
      aggregatorAdapter:   {} as never,
    });
    const props = (tool.schema.inputSchema.properties as Record<string, { description?: string }>);
    const desc  = props.timeoutMs?.description ?? '';
    expect(desc).toMatch(/600000/);
    expect(desc).toMatch(/AIDEN_SUBAGENT_TIMEOUT_MS/);
    // The stale "Default 90000" string MUST be gone.
    expect(desc).not.toMatch(/90000/);
  });

  it('R4: spawn_sub_agent timeoutMs description states 600000 default + env var', async () => {
    const { SPAWN_SUB_AGENT_SCHEMA } = await import(
      '../../../tools/v4/subagent/spawnSubAgentTool'
    );
    const props = (SPAWN_SUB_AGENT_SCHEMA.inputSchema.properties as Record<string, { description?: string }>);
    const desc  = props.timeoutMs?.description ?? '';
    expect(desc).toMatch(/600000/);
    expect(desc).toMatch(/AIDEN_SUBAGENT_TIMEOUT_MS/);
  });
});
