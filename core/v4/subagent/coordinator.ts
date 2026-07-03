/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 4 — SubagentCoordinator.
 *
 * Runtime-owned orchestrator for every subagent batch. Replaces the
 * ad-hoc Promise.all + per-tool-handler controller wiring that lived
 * inside `spawnSubAgentTool` and `subagentFanout`. After this slice
 * those two tools are thin facades — every coordination concern lives
 * here:
 *
 *   1. ID minting:    fanoutId + per-task subagentRunId
 *   2. Cancellation:  per-task linked AbortController cascading from
 *                     parent turn signal AND external `cancelChild`
 *   3. Concurrency:   bounded — semaphore over `Promise.all`
 *   4. Aggregation:   ordered by `taskIndex` regardless of finish order
 *   5. Cost rollup:   pushes per-child usage into the parent's
 *                     TurnRuntimeContext.costAccumulator
 *   6. Trace emit:    fires lifecycle events through
 *                     `TurnRuntimeContext.traceEmitter` for the
 *                     run_events table
 *   7. Active registry: process-wide Map<subagentRunId, ChildRun> so
 *                       `listActiveChildren(parentTurnId)` can query
 *                       in-flight children from outside (operator
 *                       slash command, future supervisor surface)
 *
 * Wraps — does not replace — the existing `spawnSubAgent` primitive
 * at `./spawnSubAgent.ts`. The primitive still owns child-agent
 * construction (toolset intersection, ApprovalEngine auto-deny,
 * provider clone, internal timeout). The coordinator owns the
 * BATCH abstraction layered above.
 *
 * Policy: this slice ships ONE policy — `bestEffort`. Siblings do
 * NOT cancel each other on failure; the coordinator waits for every
 * task to settle and returns a partial result mixing statuses.
 * `failFast` / `firstN` are documented as future work — the policy
 * parameter is a type, not a runtime switch, so adding them later
 * is additive.
 */

import { randomUUID } from 'node:crypto';
import { spawnSubAgent, type SpawnSubAgentDeps } from './spawnSubAgent';
import type { TurnRuntimeContext } from '../turnRuntimeContext';
import { recordChildUsage } from '../turnRuntimeContext';
import type { TraceEvent } from './traceEvents';
import type { Logger } from '../logger/logger';
import { noopLogger } from '../logger/factory';

// ── Public types ─────────────────────────────────────────────────────────

/**
 * One unit of work the coordinator dispatches to a child. Mirrors the
 * subset of `SubAgentSpec` the model can vary per task. The
 * coordinator clamps + normalises before handing to `spawnSubAgent`.
 */
export interface SubagentTask {
  /** Imperative goal — the only required field. */
  goal: string;
  /** Optional plain-text background — not the parent's history. */
  context?: string;
  /** Restrict child toolsets (intersected with parent's). Omit → full set. */
  toolsets?: string[];
  /** Iteration cap (clamped [1,200] downstream). Omit → primitive default. */
  maxIterations?: number;
  /** Wall-clock cap (clamped [1s, 1h] downstream). Omit → primitive default. */
  timeoutMs?: number;
  /** Per-spawn provider override (must be in parent's pool). */
  provider?: string;
  /** Optional role tag — diagnostic only. */
  role?: string;
}

/** Single-child result envelope. Discriminant: `status`. */
export interface SubagentResultEnvelope {
  taskIndex:      number;
  subagentRunId:  string;
  conversationId: string;
  status:         'completed' | 'failed' | 'timeout' | 'cancelled';
  summary:        string;          // empty string on failure paths
  error?:         string;
  exitReason:     string;
  startedAt:      number;
  endedAt:        number;
  durationMs:     number;
  provider:       string;
  model:          string;
  usage: {
    inputTokens:      number;
    outputTokens:     number;
    totalTokens:      number;
    estimatedCostUSD: number;
  };
  /**
   * Compact per-call tool trace. v4.11 ships an empty array — the
   * child's per-tool events already land in `run_events` keyed on
   * `subagentRunId` (via `childBuilder`'s onToolCall). Surfacing
   * inline into the envelope is a follow-up if the parent's LLM
   * needs them for synthesis.
   */
  toolTrace:      CompactToolTraceEntry[];
  /** Optional verified artifact references — also follow-up. */
  artifactRefs?:  string[];
  // ── v4.12.1 Pillar 3 — evidence-required reporting (threaded from the
  //    spawnSubAgent primitive; surfaced to the parent by the tool layer) ──
  /** Verify-before-done verdict over the child's trace after handle re-check. */
  verdict?:       'completed' | 'completed_unverified' | 'verification_failed' | null;
  /** True only when concrete proof handles backed the claim AND re-checked. */
  verified?:      boolean;
  /** True when the child did no mutating work — advisory, not verified-fact. */
  reasoningOnly?: boolean;
  /** The concrete proof handles that survived the parent-side re-check. */
  handles?:       Array<{ tool: string; kind: string; value: string | number }>;
}

/** Placeholder compact trace shape — reserved for follow-up wiring. */
export interface CompactToolTraceEntry {
  toolName:   string;
  ok:         boolean;
  durationMs: number;
}

/**
 * Batch result. `status` reflects the worst child outcome under the
 * `bestEffort` policy:
 *   - all children completed → 'completed'
 *   - some completed, some failed/timeout/cancelled → 'partial'
 *   - none completed → 'failed' (every child failed)
 *                    OR 'cancelled' (parent abort during batch)
 *                    OR 'timeout' (every child timed out)
 */
export interface FanoutResult {
  fanoutId:        string;
  status:          'completed' | 'partial' | 'failed' | 'cancelled' | 'timeout';
  results:         SubagentResultEnvelope[];  // sorted by taskIndex
  aggregateUsage:  {
    inputTokens:      number;
    outputTokens:     number;
    totalTokens:      number;
    estimatedCostUSD: number;
  };
  traceId:         string;
  startedAt:       number;
  endedAt:         number;
  durationMs:      number;
}

/**
 * Coordinator-level policy. Phase B ships ONE: `bestEffort`. Field is
 * a string union so additive policies (`failFast`, `firstN`) land
 * without breaking signatures.
 */
export type FanoutPolicy = 'bestEffort';

/**
 * Internal child-run record kept in the active registry. Exposed via
 * `listActiveChildren` so an operator surface (future) can inspect
 * in-flight work; mutated via `cancelChild`.
 */
export interface ChildRun {
  subagentRunId:  string;
  fanoutId:       string;
  taskIndex:      number;
  parentTurnId:   number;
  goal:           string;
  startedAt:      number;
  /** Aborted via the coordinator's own controller for this child. */
  controller:     AbortController;
  /** Set true the moment the coordinator decides this child is done. */
  settled:        boolean;
  /** Tracks whether cancellation was requested (parent or external). */
  cancelRequested: boolean;
  /** Last known reason — populated on cancel. */
  cancelReason:   'parent_cancel' | 'external_cancel' | null;
}

/** Coordinator construction deps — wired once at REPL boot. */
export interface SubagentCoordinatorOptions {
  /** Shared spawn deps — same as the v4.6 `SpawnSubAgentDeps`. */
  spawnDeps: SpawnSubAgentDeps;
  /** Default concurrency cap per fanout. */
  maxChildrenPerFanout?: number;
  /** Optional logger — defaults to noop. */
  logger?: Logger;
  /**
   * v4.11 regression patch — display surface for per-child
   * `ui_task_update` / `ui_task_done` events. Wired once at REPL
   * boot to the SAME closure the spawn_sub_agent factory used pre-
   * Slice-4 (route through `display.renderUiEvent` + tee into
   * `runStore.emitEventRich` on the parent's runId).
   *
   * Before this restore, the coordinator's introduction (Slice 4)
   * silently dropped per-child UI events for `subagent_fanout`,
   * removing the gutter-indented trail rows users saw during
   * fanouts pre-Slice-4. Single-child `spawn_sub_agent` kept its
   * pair only because the facade emitted them directly; we now
   * remove that duplicate emission so the coordinator is the
   * single source of truth for subagent UI events (one pair per
   * child, regardless of which facade dispatched).
   *
   * Optional — tests + MCP paths that don't expose a display
   * surface pass undefined and the emission is silently dropped.
   */
  onUiEvent?: (name: string, args: Record<string, unknown>) => void;
}

// ── Defaults ─────────────────────────────────────────────────────────────

/**
 * Default per-fanout concurrency cap. Matches the audit's
 * `DEFAULT_FANOUT_N` (3) so existing fanout behaviour is preserved
 * out-of-the-box. Override via constructor option;
 * `MAX_CHILDREN_GLOBAL` puts an upper bound on the env-driven cap to
 * keep a runaway config from flooding the provider rate limit.
 */
export const DEFAULT_MAX_CHILDREN_PER_FANOUT = 3;
export const MAX_CHILDREN_GLOBAL             = 10;

// ── Implementation ──────────────────────────────────────────────────────

/**
 * Runtime-owned coordinator. One instance per REPL agent (constructed
 * in `aidenCLI.ts` next to the tool registry wiring). Holds the
 * active-children registry across turns; queryable via
 * `listActiveChildren(parentTurnId)`.
 */
export class SubagentCoordinator {
  private readonly spawnDeps:            SpawnSubAgentDeps;
  private readonly maxChildrenPerFanout: number;
  private readonly logger:               Logger;
  /** v4.11 regression patch — display sink for per-child UI events. */
  private readonly onUiEvent?:           (name: string, args: Record<string, unknown>) => void;

  /**
   * Process-wide registry — keyed by subagentRunId. Survives across
   * turns because cancel surfaces (future supervisor, /adjust cancel
   * wire) may query from outside a turn boundary. Entries are deleted
   * in the `spawnBatch` finally so the map doesn't grow unbounded.
   */
  private readonly activeChildren: Map<string, ChildRun> = new Map();

  constructor(opts: SubagentCoordinatorOptions) {
    this.spawnDeps = opts.spawnDeps;
    this.maxChildrenPerFanout = clamp(
      opts.maxChildrenPerFanout ?? DEFAULT_MAX_CHILDREN_PER_FANOUT,
      1, MAX_CHILDREN_GLOBAL,
    );
    this.logger = opts.logger ?? noopLogger();
    this.onUiEvent = opts.onUiEvent;
  }

  /**
   * v4.11 regression patch — safe emitter for UI events. Swallows
   * any exception from the display sink so a buggy renderer can
   * never break dispatch. No-op when no `onUiEvent` was wired
   * (unit tests / MCP path).
   */
  private emitUi(name: string, args: Record<string, unknown>): void {
    if (!this.onUiEvent) return;
    try { this.onUiEvent(name, args); }
    catch { /* display sink exceptions must not propagate */ }
  }

  /**
   * Dispatch a batch of subagent tasks. Returns when every child has
   * settled (bestEffort policy). NEVER throws — every failure path
   * (validation, spawn failure, sibling cancel) collapses into
   * envelope entries in the result.
   *
   * `tasks.length === 1` is the spawn_sub_agent path; `length > 1` is
   * the subagent_fanout path. Both share the same orchestration —
   * the coordinator doesn't branch on count.
   */
  async spawnBatch(
    turnContext: TurnRuntimeContext,
    tasks:       SubagentTask[],
    policy:      FanoutPolicy = 'bestEffort',
  ): Promise<FanoutResult> {
    if (policy !== 'bestEffort') {
      // Phase B ships one policy; the parameter is a future hook.
      // Treat any other value as bestEffort + log so a misconfigured
      // caller doesn't surface a hard error.
      this.logger.warn?.('subagent_coordinator: only bestEffort policy supported in v4.11', {
        requestedPolicy: policy,
      });
    }
    const fanoutId  = makeFanoutId();
    const startedAt = Date.now();
    if (tasks.length === 0) {
      return {
        fanoutId,
        status:         'completed',
        results:        [],
        aggregateUsage: zeroUsage(),
        traceId:        fanoutId,
        startedAt,
        endedAt:        startedAt,
        durationMs:     0,
      };
    }

    // v4.11 regression patch — resolve the env-var default ONCE per
    // batch. Pre-Slice-4 the legacy `runFanout` orchestrator read
    // `AIDEN_SUBAGENT_TIMEOUT_MS` via `resolveBudget`; Slice 4's
    // refactor silently dropped that path because the new facade
    // passes `args.timeoutMs` straight through. Users with the env
    // var in `.env` lost the override without warning. Restore the
    // precedence chain here so it applies UNIFORMLY to spawn_sub_agent
    // and subagent_fanout (the coordinator is the single dispatch
    // funnel for both).
    //
    // Precedence (highest first):
    //   1. explicit `task.timeoutMs` (model-supplied, per call)
    //   2. AIDEN_SUBAGENT_TIMEOUT_MS env var (operator-set, per process)
    //   3. undefined → spawnSubAgent primitive's DEFAULT_TIMEOUT_MS
    //      (600 000 ms / 10 min, clamped to [MIN, MAX])
    //
    // Same regex shape as the v4.1-subagent budget.ts parser so the
    // env-var contract is byte-equivalent to the pre-Slice-4 wire.
    const envTimeoutRaw = process.env.AIDEN_SUBAGENT_TIMEOUT_MS;
    const envTimeoutMs  = envTimeoutRaw && /^\d+$/.test(envTimeoutRaw)
      ? Number.parseInt(envTimeoutRaw, 10)
      : undefined;

    // Mint per-task subagentRunIds up-front so trace events can carry
    // a stable id from `spawned` onward.
    const taskRecords = tasks.map((task, taskIndex) => ({
      // v4.11 regression patch — normalise the task's effective
      // timeoutMs in-place so the registry / spawn primitive both
      // see the resolved value (not undefined fallback).
      task: { ...task, timeoutMs: task.timeoutMs ?? envTimeoutMs },
      taskIndex,
      subagentRunId: makeSubagentRunId(fanoutId, taskIndex),
      conversationId: randomUUID(),
    }));

    // Emit `spawned` events up-front so trace consumers can see the
    // batch shape even if cancellation fires mid-launch.
    for (const r of taskRecords) {
      this.emit(turnContext, {
        eventType:      'subagent.spawned',
        fanoutId,
        subagentRunId:  r.subagentRunId,
        taskIndex:      r.taskIndex,
        parentTurnId:   turnContext.turnId,
        timestamp:      Date.now(),
        goal:           r.task.goal,
      });
    }

    // Bounded concurrency: at most `maxChildrenPerFanout` children
    // in flight at any time. Result map keyed by taskIndex so the
    // final ordering is input order regardless of completion order.
    const resultMap = new Map<number, SubagentResultEnvelope>();
    const runOne = async (
      record: typeof taskRecords[number],
    ): Promise<void> => {
      const envelope = await this.runOneChild(turnContext, fanoutId, record);
      resultMap.set(record.taskIndex, envelope);
    };

    await runBounded(
      taskRecords.map((r) => () => runOne(r)),
      this.maxChildrenPerFanout,
    );

    // Sort results by taskIndex for the final return shape (Map
    // iteration order is insertion order, not numeric).
    const results: SubagentResultEnvelope[] = [];
    for (let i = 0; i < taskRecords.length; i += 1) {
      const env = resultMap.get(i);
      if (env) results.push(env);
    }

    const aggregateUsage = aggregateUsageFrom(results);
    const endedAt = Date.now();
    const status  = classifyBatchStatus(results);

    return {
      fanoutId,
      status,
      results,
      aggregateUsage,
      traceId:    fanoutId,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
    };
  }

  /**
   * Cancel a specific in-flight child. Returns true if the
   * subagentRunId was found AND not yet settled (the abort call
   * actually fired); false otherwise. The abort cascades through
   * `spawnSubAgent`'s linked controller into the child's loop.
   *
   * Marked `cancelReason: 'external_cancel'` so the envelope mapper
   * distinguishes from parent_cancel for diagnostic purposes.
   */
  cancelChild(subagentRunId: string): boolean {
    const child = this.activeChildren.get(subagentRunId);
    if (!child || child.settled) return false;
    child.cancelRequested = true;
    child.cancelReason    = 'external_cancel';
    try {
      child.controller.abort();
    } catch { /* AbortController.abort() can't throw; defensive */ }
    return true;
  }

  /**
   * Snapshot of every in-flight child whose `parentTurnId` matches.
   * Returns a defensive copy — caller mutations don't affect the
   * registry. Settled children are filtered out at read time.
   */
  listActiveChildren(parentTurnId: number): ChildRun[] {
    const out: ChildRun[] = [];
    for (const child of this.activeChildren.values()) {
      if (child.parentTurnId === parentTurnId && !child.settled) {
        out.push({ ...child });
      }
    }
    return out;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Run a single child task end-to-end. Owns the per-task linked
   * AbortController, the registry insert/remove, and the envelope
   * mapping from `spawnSubAgent`'s output to `SubagentResultEnvelope`.
   */
  private async runOneChild(
    turnContext: TurnRuntimeContext,
    fanoutId:    string,
    record:      {
      task:           SubagentTask;
      taskIndex:      number;
      subagentRunId:  string;
      conversationId: string;
    },
  ): Promise<SubagentResultEnvelope> {
    const startedAt = Date.now();

    // ── Per-child linked AbortController ────────────────────────────────
    // Parent → child cascade is wired here, NOT inside spawnSubAgent
    // (the primitive sees `ctx.signal` and treats it as "the abort
    // source"). The coordinator's controller IS that source.
    //
    // Cancellation reasons we want to distinguish in the envelope:
    //   - parent turn aborted (chatSession's currentAbortController)
    //   - external cancelChild() (operator surface, future supervisor)
    //   - timeout (handled INSIDE spawnSubAgent — distinct envelope path)
    const controller = new AbortController();
    let parentCascade: (() => void) | null = null;
    const parentSignal = turnContext.signal;
    const child: ChildRun = {
      subagentRunId:   record.subagentRunId,
      fanoutId,
      taskIndex:       record.taskIndex,
      parentTurnId:    turnContext.turnId,
      goal:            record.task.goal,
      startedAt,
      controller,
      settled:         false,
      cancelRequested: false,
      cancelReason:    null,
    };
    this.activeChildren.set(record.subagentRunId, child);

    if (parentSignal.aborted) {
      // Parent already aborted before we got here — short-circuit
      // with a cancelled envelope WITHOUT calling the spawn primitive
      // (saves a child build + run row).
      child.cancelRequested = true;
      child.cancelReason    = 'parent_cancel';
      child.settled         = true;
      controller.abort();
      this.activeChildren.delete(record.subagentRunId);
      const endedAt = Date.now();
      const env: SubagentResultEnvelope = {
        taskIndex:      record.taskIndex,
        subagentRunId:  record.subagentRunId,
        conversationId: record.conversationId,
        status:         'cancelled',
        summary:        '',
        error:          'Parent turn aborted before subagent could start',
        exitReason:     'cancelled',
        startedAt, endedAt,
        durationMs:     endedAt - startedAt,
        provider:       this.spawnDeps.parentProviderId,
        model:          this.spawnDeps.parentModelId,
        usage:          zeroUsage(),
        toolTrace:      [],
      };
      this.emit(turnContext, {
        eventType:      'subagent.cancelled',
        fanoutId,
        subagentRunId:  record.subagentRunId,
        taskIndex:      record.taskIndex,
        parentTurnId:   turnContext.turnId,
        timestamp:      endedAt,
        durationMs:     env.durationMs,
        provider:       env.provider,
        model:          env.model,
        inputTokens:    0,
        outputTokens:   0,
        reason:         'parent_cancel',
      });
      // v4.11 regression patch — even on the pre-abort short-circuit,
      // surface a single ui_task_done so the display's gutter trail
      // reflects "this child never started". We skip the ui_task_update
      // pair entry here because there was no running window — Display's
      // renderUiTaskDone tolerates a `done` without a preceding `update`.
      this.emitUiDone(record, env);
      return env;
    }
    parentCascade = () => {
      child.cancelRequested = true;
      child.cancelReason    = 'parent_cancel';
      try { controller.abort(); } catch { /* defensive */ }
    };
    parentSignal.addEventListener('abort', parentCascade, { once: true });

    // ── Emit `started` event (provider/model known at this point) ──────
    this.emit(turnContext, {
      eventType:      'subagent.started',
      fanoutId,
      subagentRunId:  record.subagentRunId,
      taskIndex:      record.taskIndex,
      parentTurnId:   turnContext.turnId,
      timestamp:      Date.now(),
      provider:       record.task.provider ?? this.spawnDeps.parentProviderId,
      model:          this.spawnDeps.parentModelId,
    });

    // v4.11 regression patch — emit the display-facing `ui_task_update`
    // so the user sees a gutter-indented `[task] <goal> · running…` row
    // for THIS child. Mirrors the v4.6 spawn_sub_agent emission shape
    // (`task_id`, `label`, `status: 'running'`, `kind: 'subagent'`,
    // `depth: 1`) so the existing display.renderUiTaskUpdate path
    // handles it without any rendering-side change.
    this.emitUi('ui_task_update', {
      task_id: record.subagentRunId,
      label:   goalPreview(record.task.goal),
      status:  'running',
      kind:    'subagent',
      depth:   1,
    });

    // ── Dispatch the primitive ─────────────────────────────────────────
    let envelope: SubagentResultEnvelope;
    try {
      const result = await spawnSubAgent(
        {
          goal:          record.task.goal,
          context:       record.task.context,
          toolsets:      record.task.toolsets,
          maxIterations: record.task.maxIterations,
          timeoutMs:     record.task.timeoutMs,
          provider:      record.task.provider,
        },
        this.spawnDeps,
        {
          signal:          controller.signal,
          parentRunId:     undefined, // populated by the tool wrapper layer
          parentSessionId: undefined,
        },
      );
      const endedAt    = Date.now();
      const durationMs = endedAt - startedAt;
      const provider   = record.task.provider ?? this.spawnDeps.parentProviderId;
      const model      = this.spawnDeps.parentModelId;

      // Map primitive status → coordinator envelope status. The
      // primitive uses 'interrupted' for cancel-caused finish; the
      // coordinator normalises that to 'cancelled' (envelope spec).
      const status: SubagentResultEnvelope['status'] =
        result.status === 'completed'   ? 'completed'
        : result.status === 'timeout'   ? 'timeout'
        : result.status === 'interrupted' ? 'cancelled'
        : 'failed';
      envelope = {
        taskIndex:      record.taskIndex,
        subagentRunId:  record.subagentRunId,
        conversationId: record.conversationId,
        status,
        summary:        result.summary ?? '',
        error:          result.error ?? undefined,
        exitReason:     result.exitReason,
        startedAt, endedAt, durationMs,
        provider,
        model,
        usage: {
          inputTokens:      result.metrics.tokensIn,
          outputTokens:     result.metrics.tokensOut,
          totalTokens:      result.metrics.tokensIn + result.metrics.tokensOut,
          estimatedCostUSD: 0,  // priced by future wiring; contract anchor
        },
        toolTrace:      [],
        // v4.12.1 Pillar 3 — carry the primitive's evidence up to the tool layer.
        verdict:        result.verdict,
        verified:       result.verified,
        reasoningOnly:  result.reasoningOnly,
        handles:        result.handles,
        artifactRefs:   result.handles.map((h) => `${h.kind}:${String(h.value)}`),
      };

      // Cost rollup into the parent's accumulator.
      recordChildUsage(turnContext.costAccumulator, {
        subagentRunId: envelope.subagentRunId,
        fanoutId,
        model:         envelope.model,
        inputTokens:   envelope.usage.inputTokens,
        outputTokens:  envelope.usage.outputTokens,
      });

      // Emit terminal event matching the envelope status.
      this.emitTerminal(turnContext, fanoutId, record, envelope, child);
      // v4.11 regression patch — display-facing close-out.
      this.emitUiDone(record, envelope);
    } catch (err) {
      // spawnSubAgent contract says it never throws — defensive only.
      const endedAt    = Date.now();
      const durationMs = endedAt - startedAt;
      const message    = err instanceof Error ? err.message : String(err);
      envelope = {
        taskIndex:      record.taskIndex,
        subagentRunId:  record.subagentRunId,
        conversationId: record.conversationId,
        status:         'failed',
        summary:        '',
        error:          `spawnSubAgent threw: ${message}`,
        exitReason:     'error',
        startedAt, endedAt, durationMs,
        provider:       record.task.provider ?? this.spawnDeps.parentProviderId,
        model:          this.spawnDeps.parentModelId,
        usage:          zeroUsage(),
        toolTrace:      [],
      };
      this.emit(turnContext, {
        eventType:      'subagent.failed',
        fanoutId,
        subagentRunId:  record.subagentRunId,
        taskIndex:      record.taskIndex,
        parentTurnId:   turnContext.turnId,
        timestamp:      endedAt,
        durationMs,
        provider:       envelope.provider,
        model:          envelope.model,
        inputTokens:    0,
        outputTokens:   0,
        error:          envelope.error ?? message,
        exitReason:     envelope.exitReason,
      });
      // v4.11 regression patch — even on the rare primitive-throw path
      // the user sees the gutter trail close.
      this.emitUiDone(record, envelope);
    } finally {
      child.settled = true;
      if (parentCascade) {
        try { parentSignal.removeEventListener('abort', parentCascade); }
        catch { /* defensive */ }
      }
      this.activeChildren.delete(record.subagentRunId);
    }

    return envelope;
  }

  /**
   * Fan the envelope's terminal status to the matching trace event.
   * Pulled out of `runOneChild` so the body of that method stays
   * readable.
   */
  private emitTerminal(
    turnContext: TurnRuntimeContext,
    fanoutId:    string,
    record:      { subagentRunId: string; taskIndex: number },
    envelope:    SubagentResultEnvelope,
    child:       ChildRun,
  ): void {
    const base = {
      fanoutId,
      subagentRunId:  record.subagentRunId,
      taskIndex:      record.taskIndex,
      parentTurnId:   turnContext.turnId,
      timestamp:      envelope.endedAt,
      durationMs:     envelope.durationMs,
      provider:       envelope.provider,
      model:          envelope.model,
      inputTokens:    envelope.usage.inputTokens,
      outputTokens:   envelope.usage.outputTokens,
    } as const;
    switch (envelope.status) {
      case 'completed':
        this.emit(turnContext, {
          ...base,
          eventType: 'subagent.completed',
          summary:   envelope.summary,
        });
        return;
      case 'timeout':
        this.emit(turnContext, { ...base, eventType: 'subagent.timeout' });
        return;
      case 'cancelled': {
        // Prefer the explicit cancel reason we tracked; fall back when
        // the primitive returned 'interrupted' without our marker
        // (shouldn't happen, but defensive).
        const reason = child.cancelReason ?? 'unknown';
        this.emit(turnContext, {
          ...base,
          eventType: 'subagent.cancelled',
          reason,
        });
        return;
      }
      case 'failed':
        this.emit(turnContext, {
          ...base,
          eventType:  'subagent.failed',
          error:      envelope.error ?? 'unknown',
          exitReason: envelope.exitReason,
        });
        return;
    }
  }

  /** Safe emitter wrapper — swallows exceptions from a buggy listener. */
  private emit(ctx: TurnRuntimeContext, event: TraceEvent): void {
    if (!ctx.traceEmitter) return;
    try { ctx.traceEmitter(event); }
    catch { /* emitter exceptions must not propagate */ }
  }

  /**
   * v4.11 regression patch — emit the display-facing `ui_task_done`
   * for a child whose envelope has settled. Centralised so the three
   * terminal paths (success, primitive-throw, pre-abort short-circuit)
   * stay in sync. Status mapping mirrors what the v4.6 spawn_sub_agent
   * facade emitted — `'success' | 'failure' | 'blocked'` — so the
   * display renderer needs no awareness of the new envelope vocabulary.
   */
  private emitUiDone(
    record:   { subagentRunId: string },
    envelope: SubagentResultEnvelope,
  ): void {
    const status: 'success' | 'failure' | 'blocked' =
      envelope.status === 'completed' ? 'success' :
      envelope.status === 'cancelled' ? 'blocked' :
      envelope.status === 'timeout'   ? 'blocked' : 'failure';
    this.emitUi('ui_task_done', {
      task_id: record.subagentRunId,
      status,
      summary: `${envelope.usage.totalTokens} tokens · ${envelope.exitReason}`,
    });
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Bounded-concurrency runner. Spawns up to `maxConcurrent` workers,
 * each pulling the next task from a shared index. Resolves when every
 * task has completed (no early-exit short-circuit — bestEffort means
 * we wait for stragglers). Tasks must NEVER throw (the coordinator
 * wraps each child to envelope failures); this helper preserves any
 * thrown error by failing the whole Promise.all if a worker rejects.
 */
async function runBounded<T>(
  tasks:          Array<() => Promise<T>>,
  maxConcurrent:  number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;
  const workerCount = Math.min(maxConcurrent, tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = nextIdx;
      nextIdx += 1;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}

/** Sum every envelope's usage into an aggregate. */
function aggregateUsageFrom(results: SubagentResultEnvelope[]): FanoutResult['aggregateUsage'] {
  let inT = 0, outT = 0, cost = 0;
  for (const r of results) {
    inT  += r.usage.inputTokens;
    outT += r.usage.outputTokens;
    cost += r.usage.estimatedCostUSD;
  }
  return {
    inputTokens:      inT,
    outputTokens:     outT,
    totalTokens:      inT + outT,
    estimatedCostUSD: cost,
  };
}

/** Worst-status-wins classifier for the batch. */
function classifyBatchStatus(results: SubagentResultEnvelope[]): FanoutResult['status'] {
  if (results.length === 0) return 'completed';
  let completed = 0, failed = 0, cancelled = 0, timeout = 0;
  for (const r of results) {
    switch (r.status) {
      case 'completed': completed += 1; break;
      case 'failed':    failed    += 1; break;
      case 'cancelled': cancelled += 1; break;
      case 'timeout':   timeout   += 1; break;
    }
  }
  if (completed === results.length) return 'completed';
  if (completed > 0)                return 'partial';
  // No completions — classify by the dominant terminal reason.
  if (cancelled >= failed && cancelled >= timeout) return 'cancelled';
  if (timeout   >= failed)                          return 'timeout';
  return 'failed';
}

function zeroUsage(): SubagentResultEnvelope['usage'] {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0 };
}

/** `f-<8char>`. Random short id for trace grouping. */
function makeFanoutId(): string {
  return `f-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** `sa-<fanoutId>-<taskIdx>-<8char>` — locked id format from the design spec. */
function makeSubagentRunId(fanoutId: string, taskIndex: number): string {
  return `sa-${fanoutId}-${taskIndex}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/**
 * v4.11 regression patch — short label shown in the gutter
 * `ui_task_update` row. Mirrors the pre-Slice-4 spawn_sub_agent
 * goal-truncation rule (cap at 200 chars + ellipsis) so display
 * output reads identically to v4.6 for single-child spawns and now
 * extends the same surface to fanout children.
 */
function goalPreview(goal: string): string {
  return goal.length > 200 ? goal.slice(0, 200) + '…' : goal;
}
