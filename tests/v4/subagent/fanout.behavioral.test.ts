/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/subagent/fanout.behavioral.test.ts — v4.6 Phase 2Q-A.
 *
 * Behavioral coverage for `runFanout` after the Phase 2Q refactor:
 * the orchestrator now routes each child through the
 * `spawn_sub_agent` primitive (`spawnSubAgent`) instead of the
 * legacy `runChild` closure. Cases here verify the integration —
 * what changes are observable from the outside (per-child run rows
 * persisted with lineage, provider rotation honoured at the
 * spawn-spec layer, wall-clock cap still fires, parent abort still
 * cascades, merger inputs still adapt from the envelope shape).
 *
 * Test plan (10 cases):
 *
 *   1. Ensemble happy path — N completed envelopes → N SubagentResults
 *      with provider/model preserved; merger receives the right input.
 *   2. Partition happy path — per-task goals threaded into spec.goal;
 *      child rows present in DB with distinct sessionIds.
 *   3. Each child gets its own runs row with `spawned_from_run_id`
 *      pointing to the parent (when parentRunId is supplied).
 *   4. Provider rotation: per-child `spec.provider` is set from
 *      assignments[i].providerId (consumed by spawnSubAgent's
 *      override path; failure here is observable as
 *      exitReason: 'provider_not_found' downstream).
 *   5. Per-child timeout — child that exceeds `timeoutMs` ships
 *      a 'timeout' envelope, surfaced as `error` on SubagentResult.
 *   6. Parent abort cascade — aborting `parentAbort` before launch
 *      results in all children failing/interrupted via the
 *      wall-controller signal cascading into spawnSubAgent's ctx.
 *   7. One child fails — siblings unaffected; failed child has
 *      empty `output` + error; merger still runs with mixed results.
 *   8. Merge='all' — raw N results returned, no aggregator call.
 *   9. Public schema unchanged — `subagent_fanout` tool's
 *      inputSchema before/after refactor is byte-equivalent for
 *      every named field. Regression for "we accidentally broke
 *      the model-facing surface".
 *   10. Aggregator strategies still flow through (smoke for
 *       'combine'): aggregator adapter is called once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import type { RunStore } from '../../../core/v4/daemon/runStore';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { ToolContext, ToolHandler } from '../../../core/v4/toolRegistry';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import { FallbackAdapter } from '../../../core/v4/providerFallback';
import { runFanout, type FanoutOptions } from '../../../core/v4/subagent/fanout';
import type { SpawnSubAgentDeps } from '../../../core/v4/subagent/spawnSubAgent';
import type { ProviderOption } from '../../../core/v4/subagent/providerRotation';
import type {
  ProviderAdapter,
  ProviderCallOutput,
} from '../../../providers/v4/types';
import { makeSubagentFanoutTool } from '../../../tools/v4/subagent/subagentFanout';
import { SubagentCoordinator } from '../../../core/v4/subagent/coordinator';
import { buildTurnRuntimeContext } from '../../../core/v4/turnRuntimeContext';

// ── Fixtures ─────────────────────────────────────────────────────────────

let db: Database.Database;
let runStore: RunStore;
const INST = 'inst-fanout-2q';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(INST, 1, 'h', Date.now(), Date.now(), '4.6.0-test');
  runStore = createRunStore({ db });
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

function makeFakeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  const noopExec = async () => ({ ok: true });
  const handler = (name: string, toolset: string): ToolHandler => ({
    schema: {
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    execute: noopExec,
    category: 'read',
    mutates:  false,
    toolset,
  });
  reg.register(handler('file_read',  'files'));
  reg.register(handler('web_search', 'web'));
  return reg;
}

function makeFakeCtx(): ToolContext {
  return { cwd: process.cwd(), paths: {} as ToolContext['paths'] };
}

/**
 * Build a real FallbackAdapter wired with mock slots so the spawn
 * primitive's `instanceof FallbackAdapter` guard succeeds and per-spawn
 * provider override resolves cleanly.
 */
function buildFanoutFallback(providerIds: string[], stops: string[] = []): FallbackAdapter {
  type Slot = {
    id: string;
    providerId: string;
    modelId: string;
    keyPresent: boolean;
    keyTail: string | null;
    build: () => ProviderAdapter;
  };
  const slots: Slot[] = providerIds.map((pid, i) => ({
    id:         `${pid}-${i}`,
    providerId: pid,
    modelId:    'mock-model',
    keyPresent: true,
    keyTail:    null,
    build:      () => new MockProviderAdapter([
      MockProviderAdapter.stop(stops[i] ?? `child via ${pid}`),
    ]),
  }));
  return new FallbackAdapter({
    apiMode:    'chat_completions',
    slots:      slots as never,
    cooldownMs: 60_000,
  });
}

/** Aggregator adapter stub that emits a recognizable string. */
function makeAggregatorAdapter(label = '[aggregated]'): ProviderAdapter & { callCount: () => number } {
  let calls = 0;
  return {
    apiMode: 'chat_completions',
    async call(): Promise<ProviderCallOutput> {
      calls += 1;
      return {
        content:      label,
        toolCalls:    [],
        finishReason: 'stop',
        usage:        { inputTokens: 5, outputTokens: 5 },
      };
    },
    callCount: () => calls,
  } as ProviderAdapter & { callCount: () => number };
}

function makeSpawnDeps(fallback: FallbackAdapter): SpawnSubAgentDeps {
  return {
    toolRegistry:      makeFakeRegistry(),
    parentToolContext: makeFakeCtx(),
    parentProvider:    fallback as unknown as ProviderAdapter,
    parentProviderId:  'fallback',
    parentModelId:     'mock-model',
    runStore,
    instanceId:        INST,
  };
}

function makeProviderOptions(providerIds: string[]): ProviderOption[] {
  return providerIds.map((pid, i) => ({
    providerId: pid,
    modelId:    'mock-model',
    label:      `${pid}-${i}`,
  }));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('runFanout — v4.6 Phase 2Q behavioral (routes through spawnSubAgent)', () => {

  it('1. ensemble happy path: N envelopes → N SubagentResults with provider preserved', async () => {
    const fb = buildFanoutFallback(['groq', 'openrouter'], ['from-groq', 'from-openrouter']);
    const agg = makeAggregatorAdapter('[combined]');
    const opts: FanoutOptions = {
      mode:               'ensemble',
      query:              'what is 2+2',
      n:                  2,
      merge:              'all',     // skip aggregator for this case
      providers:          makeProviderOptions(['groq', 'openrouter']),
      spawnDeps:          makeSpawnDeps(fb),
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'groq', modelId: 'mock-model' },
    };
    const result = await runFanout(opts);
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.providerId).sort())
      .toEqual(['groq', 'openrouter']);
    // SubagentResult adapter mapped envelope.summary → output verbatim.
    expect(result.results.find((r) => r.providerId === 'groq')?.output).toBe('from-groq');
    expect(result.results.find((r) => r.providerId === 'openrouter')?.output).toBe('from-openrouter');
    expect(result.diagnostics.succeeded).toBe(2);
    expect(result.diagnostics.failed).toBe(0);
  });

  it('2. partition happy path: per-task goals threaded into spawn spec; child rows distinct', async () => {
    const fb = buildFanoutFallback(['groq', 'openrouter'], ['ans-1', 'ans-2']);
    const agg = makeAggregatorAdapter();
    const result = await runFanout({
      mode:  'partition',
      tasks: [
        { goal: 'task-A goal', role: 'analyst' },
        { goal: 'task-B goal', role: 'critic'  },
      ],
      n:                  2,
      merge:              'all',
      providers:          makeProviderOptions(['groq', 'openrouter']),
      spawnDeps:          makeSpawnDeps(fb),
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'groq', modelId: 'mock-model' },
    });
    expect(result.results).toHaveLength(2);
    // Two distinct child runs persisted.
    const childRows = db.prepare(
      `SELECT session_id, status FROM runs WHERE instance_id = ?`,
    ).all(INST) as Array<{ session_id: string; status: string }>;
    expect(childRows).toHaveLength(2);
    const sessionIds = new Set(childRows.map((r) => r.session_id));
    expect(sessionIds.size).toBe(2);
    for (const r of childRows) {
      expect(r.status).toBe('completed');
    }
  });

  it('3. children link to parent via spawned_from_run_id when parentRunId supplied', async () => {
    const fb = buildFanoutFallback(['groq', 'openrouter']);
    const agg = makeAggregatorAdapter();
    // Seed a synthetic parent runs row so children have something to link to.
    const parentRunId = runStore.create({
      sessionId:  'sess-parent-fanout',
      instanceId: INST,
      status:     'running',
    });
    await runFanout({
      mode:               'ensemble',
      query:              'q',
      n:                  2,
      merge:              'all',
      providers:          makeProviderOptions(['groq', 'openrouter']),
      spawnDeps:          makeSpawnDeps(fb),
      parentRunId,
      parentSessionId:    'sess-parent-fanout',
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'groq', modelId: 'mock-model' },
    });
    const childRows = db.prepare(
      `SELECT spawned_from_run_id, spawned_from_session_id FROM runs WHERE id != ?`,
    ).all(parentRunId) as Array<{
      spawned_from_run_id:     number | null;
      spawned_from_session_id: string | null;
    }>;
    expect(childRows.length).toBeGreaterThanOrEqual(2);
    for (const r of childRows) {
      expect(r.spawned_from_run_id).toBe(parentRunId);
      expect(r.spawned_from_session_id).toBe('sess-parent-fanout');
    }
  });

  it('4. provider rotation: per-child spec.provider matches rotation assignments', async () => {
    // Two providers, n=2 → one child per slot. If rotation didn't
    // propagate, both children would land on the same slot OR the
    // override resolver would emit provider_not_found.
    const fb = buildFanoutFallback(['groq', 'openrouter']);
    const agg = makeAggregatorAdapter();
    const result = await runFanout({
      mode:               'ensemble',
      query:              'q',
      n:                  2,
      merge:              'all',
      providers:          makeProviderOptions(['groq', 'openrouter']),
      spawnDeps:          makeSpawnDeps(fb),
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'groq', modelId: 'mock-model' },
    });
    // No provider_not_found surfaced — rotation went through cleanly.
    for (const r of result.results) {
      expect(r.error).toBeUndefined();
    }
    expect(result.diagnostics.providerDistribution.sort())
      .toEqual(['groq', 'openrouter']);
  });

  it('5. per-child timeout: slow child surfaces with error string', async () => {
    // Build a fallback where one slot's mock provider hangs forever.
    type Slot = {
      id: string;
      providerId: string;
      modelId: string;
      keyPresent: boolean;
      keyTail: string | null;
      build: () => ProviderAdapter;
    };
    const slowAdapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call(input): Promise<ProviderCallOutput> {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
    const slots: Slot[] = [
      {
        id:         'slow-0',
        providerId: 'slow',
        modelId:    'mock-model',
        keyPresent: true,
        keyTail:    null,
        build:      () => slowAdapter,
      },
      {
        id:         'fast-0',
        providerId: 'fast',
        modelId:    'mock-model',
        keyPresent: true,
        keyTail:    null,
        build:      () => new MockProviderAdapter([MockProviderAdapter.stop('fast-done')]),
      },
    ];
    const fb = new FallbackAdapter({
      apiMode:    'chat_completions',
      slots:      slots as never,
      cooldownMs: 60_000,
    });
    const agg = makeAggregatorAdapter();
    const result = await runFanout({
      mode:               'ensemble',
      query:              'q',
      n:                  2,
      merge:              'all',
      providers:          makeProviderOptions(['slow', 'fast']),
      spawnDeps:          makeSpawnDeps(fb),
      timeoutMs:          150,   // per-child cap = 150ms
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'fast', modelId: 'mock-model' },
    });
    const slow = result.results.find((r) => r.providerId === 'slow');
    const fast = result.results.find((r) => r.providerId === 'fast');
    expect(slow).toBeDefined();
    expect(fast).toBeDefined();
    // Fast child completed normally; slow child surfaced an error.
    expect(fast!.error).toBeUndefined();
    expect(fast!.output).toBe('fast-done');
    expect(slow!.error).toBeDefined();
    expect(slow!.output).toBe('');
  }, 10_000);

  it('6. parent abort cascades into every child via wall-controller signal', async () => {
    // Slow adapter so the parent abort is observable mid-flight.
    const slowAdapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call(input): Promise<ProviderCallOutput> {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
    type Slot = {
      id: string; providerId: string; modelId: string;
      keyPresent: boolean; keyTail: string | null;
      build: () => ProviderAdapter;
    };
    const slots: Slot[] = ['p1', 'p2'].map((pid, i) => ({
      id: `${pid}-${i}`, providerId: pid, modelId: 'mock-model',
      keyPresent: true, keyTail: null, build: () => slowAdapter,
    }));
    const fb = new FallbackAdapter({
      apiMode: 'chat_completions', slots: slots as never, cooldownMs: 60_000,
    });
    const parentCtrl = new AbortController();
    // Abort immediately so the wall signal is aborted before launch.
    parentCtrl.abort();
    const agg = makeAggregatorAdapter();
    const result = await runFanout({
      mode:               'ensemble',
      query:              'q',
      n:                  2,
      merge:              'all',
      providers:          makeProviderOptions(['p1', 'p2']),
      spawnDeps:          makeSpawnDeps(fb),
      parentAbort:        parentCtrl.signal,
      timeoutMs:          5000,
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'p1', modelId: 'mock-model' },
    });
    // Both children short-circuited (either interrupted or empty).
    for (const r of result.results) {
      expect(r.output).toBe('');
    }
    expect(result.diagnostics.failed).toBe(2);
  }, 10_000);

  it('7. one child fails: siblings unaffected, mixed results flow to merger', async () => {
    // First slot's mock provider returns immediately; second throws.
    type Slot = {
      id: string; providerId: string; modelId: string;
      keyPresent: boolean; keyTail: string | null;
      build: () => ProviderAdapter;
    };
    const throwingAdapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call(): Promise<ProviderCallOutput> {
        throw new Error('synthetic provider failure');
      },
    };
    const slots: Slot[] = [
      {
        id: 'good-0', providerId: 'good', modelId: 'mock-model',
        keyPresent: true, keyTail: null,
        build: () => new MockProviderAdapter([MockProviderAdapter.stop('ok-output')]),
      },
      {
        id: 'bad-0', providerId: 'bad', modelId: 'mock-model',
        keyPresent: true, keyTail: null,
        build: () => throwingAdapter,
      },
    ];
    const fb = new FallbackAdapter({
      apiMode: 'chat_completions', slots: slots as never, cooldownMs: 60_000,
    });
    const agg = makeAggregatorAdapter();
    const result = await runFanout({
      mode:               'ensemble',
      query:              'q',
      n:                  2,
      merge:              'all',
      providers:          makeProviderOptions(['good', 'bad']),
      spawnDeps:          makeSpawnDeps(fb),
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'good', modelId: 'mock-model' },
    });
    const good = result.results.find((r) => r.providerId === 'good');
    const bad  = result.results.find((r) => r.providerId === 'bad');
    expect(good?.output).toBe('ok-output');
    expect(good?.error).toBeUndefined();
    expect(bad?.output).toBe('');
    expect(bad?.error).toBeDefined();
    expect(result.diagnostics.succeeded).toBe(1);
    expect(result.diagnostics.failed).toBe(1);
  });

  it('8. merge=\'all\': no aggregator call; raw results returned with merged=null', async () => {
    const fb = buildFanoutFallback(['groq', 'openrouter']);
    const agg = makeAggregatorAdapter();
    const result = await runFanout({
      mode:               'ensemble',
      query:              'q',
      n:                  2,
      merge:              'all',
      providers:          makeProviderOptions(['groq', 'openrouter']),
      spawnDeps:          makeSpawnDeps(fb),
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'groq', modelId: 'mock-model' },
    });
    expect(result.merged).toBeNull();
    expect(agg.callCount()).toBe(0);
  });

  it('9. public schema unchanged: subagent_fanout inputSchema fields are stable', () => {
    const tool = makeSubagentFanoutTool({
      resolveTurnContext:  () => undefined,
      coordinator:         {} as never,
      resolveProviders:    () => [],
      resolveActiveModel:  () => ({ providerId: 's', modelId: 's' }),
      aggregatorAdapter:   {} as never,
    });
    const input = tool.schema.inputSchema as Record<string, unknown>;
    expect(input.type).toBe('object');
    expect((input.required as string[])).toContain('mode');
    const props = input.properties as Record<string, { type?: string; enum?: string[] }>;
    // The exact named-field surface the LLM sees. If any field name
    // changes, this assertion fails — forcing a deliberate schema
    // review (back-compat for prompt-cached parents).
    expect(Object.keys(props).sort()).toEqual([
      'merge', 'mode', 'n', 'query', 'tasks', 'timeoutMs',
    ]);
    expect(props.mode!.enum).toEqual(['partition', 'ensemble']);
    expect(props.merge!.enum).toEqual(['all', 'vote', 'pick-best', 'combine']);
  });

  it('10. merge=\'combine\': aggregator called exactly once with merged text returned', async () => {
    const fb = buildFanoutFallback(['groq', 'openrouter'], ['piece-1', 'piece-2']);
    const agg = makeAggregatorAdapter('[combined-output]');
    const result = await runFanout({
      mode:               'ensemble',
      query:              'q',
      n:                  2,
      merge:              'combine',
      providers:          makeProviderOptions(['groq', 'openrouter']),
      spawnDeps:          makeSpawnDeps(fb),
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'groq', modelId: 'mock-model' },
    });
    expect(agg.callCount()).toBe(1);
    expect(result.merged).toBe('[combined-output]');
  });

  // ──────────────────────────────────────────────────────────────────────
  // v4.6 Phase 2Q-A-FIX — single-provider parent fanout regression
  // ──────────────────────────────────────────────────────────────────────
  //
  // Smoke caught: when the parent uses a non-FallbackAdapter (single
  // provider config) OR a FallbackAdapter with only one providerId
  // in its pool, `rotateProviders` returns assignments populated
  // with the SAME providerId for every slot and sets
  // `singleProviderWarning=true`. Pre-fix, the fanout layer
  // unconditionally set `SubAgentSpec.provider = assignment.providerId`,
  // which tripped 2P validation in `resolveChildProvider`:
  //   - non-FallbackAdapter parent → throws ProviderNotFoundError
  //     ("single-provider configuration")
  //   - FallbackAdapter with one provider → would resolve, but the
  //     override path is pointless overhead.
  // The fix: omit `spec.provider` when
  // `rotation.singleProviderWarning === true`. Children inherit the
  // parent's adapter — same effective behavior, no validation
  // collision.

  it('11. single-provider non-FallbackAdapter parent: all N children complete (regression for smoke bug)', async () => {
    // Parent is a plain MockProviderAdapter (NOT FallbackAdapter).
    // Pre-fix: every child fails with exitReason:'provider_not_found'.
    // Post-fix: every child completes inheriting the parent's adapter.
    const parentAdapter = new MockProviderAdapter([
      MockProviderAdapter.stop('child-1'),
      MockProviderAdapter.stop('child-2'),
      MockProviderAdapter.stop('child-3'),
    ]);
    const spawnDeps: SpawnSubAgentDeps = {
      toolRegistry:      makeFakeRegistry(),
      parentToolContext: makeFakeCtx(),
      parentProvider:    parentAdapter,
      parentProviderId:  'mock',
      parentModelId:     'mock-model',
      runStore,
      instanceId:        INST,
    };
    const agg = makeAggregatorAdapter();
    const result = await runFanout({
      mode:               'ensemble',
      query:              'q',
      n:                  3,
      merge:              'all',
      providers:          makeProviderOptions(['mock']),  // single entry
      spawnDeps,
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'mock', modelId: 'mock-model' },
    });
    // Every child completed successfully.
    expect(result.diagnostics.succeeded).toBe(3);
    expect(result.diagnostics.failed).toBe(0);
    // No child surfaces provider_not_found.
    for (const r of result.results) {
      expect(r.error).toBeUndefined();
      expect(r.output.length).toBeGreaterThan(0);
    }
    // Diagnostics still flag single-provider — the warning is correct
    // even though the children completed.
    expect(result.diagnostics.singleProviderWarning).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // v4.6 Phase 3A — operator kill-switch gate at fanout handler entry
  // ──────────────────────────────────────────────────────────────────────
  it('13. /spawn-pause on → subagent_fanout tool rejects entire call, no partial fanout', async () => {
    // Init pause + flip it on.
    const tmpHome = (await import('node:fs')).mkdtempSync(
      (await import('node:path')).join((await import('node:os')).tmpdir(), 'aiden-fanout-pause-'),
    );
    const { initSpawnPause, _resetSpawnPauseForTests } = await import('../../../core/v4/subagent/spawnPause');
    const state = initSpawnPause({ aidenHome: tmpHome });
    state.pause({ reason: 'integration-test', pausedBy: 'repl' });

    try {
      const fb = buildFanoutFallback(['groq', 'openrouter']);
      const agg = makeAggregatorAdapter();
      // v4.11 Slice 4 — facade now requires coordinator + turn ctx.
      // The pause-gate fires BEFORE coordinator is touched, so a
      // minimal wiring is sufficient for this test.
      const coord = new SubagentCoordinator({ spawnDeps: makeSpawnDeps(fb) });
      const tool = makeSubagentFanoutTool({
        coordinator:         coord,
        resolveTurnContext:  () => buildTurnRuntimeContext({
          turnId: 1, parentAgentId: 't', signal: new AbortController().signal,
        }),
        resolveProviders:    () => makeProviderOptions(['groq', 'openrouter']),
        resolveActiveModel:  () => ({ providerId: 'groq', modelId: 'mock-model' }),
        aggregatorAdapter:   agg as never,
      });
      const result = (await tool.execute(
        { mode: 'ensemble', query: 'q', n: 3, merge: 'all' },
        {} as never,
      )) as {
        success: boolean; errorCode?: string; message?: string;
        reason?: string | null; pausedBy?: string | null;
      };
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SUBAGENT_SPAWN_PAUSED');
      expect(result.message).toMatch(/subagent_fanout: spawning is paused/i);
      expect(result.reason).toBe('integration-test');
      expect(result.pausedBy).toBe('repl');
      // Aggregator was NOT invoked — no partial fanout.
      expect(agg.callCount()).toBe(0);
      // No child runs created.
      const childRows = db
        .prepare(`SELECT COUNT(*) AS c FROM runs WHERE instance_id = ?`)
        .get(INST) as { c: number };
      expect(childRows.c).toBe(0);
    } finally {
      state.resume();
      _resetSpawnPauseForTests();
      try { (await import('node:fs')).rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  it('14. /spawn-pause off → next subagent_fanout call proceeds normally', async () => {
    const tmpHome = (await import('node:fs')).mkdtempSync(
      (await import('node:path')).join((await import('node:os')).tmpdir(), 'aiden-fanout-pause-resumed-'),
    );
    const { initSpawnPause, _resetSpawnPauseForTests } = await import('../../../core/v4/subagent/spawnPause');
    const state = initSpawnPause({ aidenHome: tmpHome });
    state.pause({ pausedBy: 'repl' });
    state.resume();

    try {
      const fb = buildFanoutFallback(['groq', 'openrouter'], ['a', 'b']);
      const agg = makeAggregatorAdapter();
      const coord = new SubagentCoordinator({ spawnDeps: makeSpawnDeps(fb) });
      const tool = makeSubagentFanoutTool({
        coordinator:         coord,
        resolveTurnContext:  () => buildTurnRuntimeContext({
          turnId: 2, parentAgentId: 't', signal: new AbortController().signal,
        }),
        resolveProviders:    () => makeProviderOptions(['groq', 'openrouter']),
        resolveActiveModel:  () => ({ providerId: 'groq', modelId: 'mock-model' }),
        aggregatorAdapter:   agg as never,
      });
      const result = (await tool.execute(
        { mode: 'ensemble', query: 'q', n: 2, merge: 'all' },
        {} as never,
      )) as { success: boolean; errorCode?: string; results?: unknown[]; diagnostics?: { succeeded: number } };
      // Tool proceeded — NOT a SUBAGENT_SPAWN_PAUSED rejection.
      expect(result.errorCode).not.toBe('SUBAGENT_SPAWN_PAUSED');
      expect(result.success).toBe(true);
      expect(result.diagnostics?.succeeded).toBe(2);
    } finally {
      _resetSpawnPauseForTests();
      try { (await import('node:fs')).rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  it('12. single-provider FallbackAdapter parent: all N children complete; no override path triggered', async () => {
    // Parent IS a FallbackAdapter but with only one providerId in
    // its pool. The override would technically resolve, but the
    // fix path omits it anyway because rotation sets
    // singleProviderWarning=true. Verifies the fix doesn't break
    // this edge case.
    const fb = buildFanoutFallback(['solo', 'solo'], ['a', 'b']);  // same id twice → single providerId in pool
    const spawnDeps = makeSpawnDeps(fb);
    const agg = makeAggregatorAdapter();
    const result = await runFanout({
      mode:               'ensemble',
      query:              'q',
      n:                  2,
      merge:              'all',
      providers:          makeProviderOptions(['solo']),  // distinct.size === 1
      spawnDeps,
      aggregatorAdapter:  agg,
      aggregatorModel:    { providerId: 'solo', modelId: 'mock-model' },
    });
    expect(result.diagnostics.succeeded).toBe(2);
    expect(result.diagnostics.failed).toBe(0);
    for (const r of result.results) {
      expect(r.error).toBeUndefined();
    }
    expect(result.diagnostics.singleProviderWarning).toBe(true);
  });
});
