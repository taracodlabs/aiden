/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 4 — TurnRuntimeContext.
 *
 * Per-turn runtime envelope threaded from `chatSession.runAgentTurn`
 * through `agent.runConversation` down to any tool whose handler needs
 * the live turn's signal, id, or cost accumulator.
 *
 * Pure types + helpers. The actual `_currentTurnContext` storage
 * lives on `AidenAgent` (Flag 1 pattern — instance-scoped, set at
 * loop entry, cleared at exit) so tool handlers read it via
 * `factory.parentAgent.getCurrentTurnContext()` at dispatch time
 * without widening the executor signature.
 *
 * Design discipline: this module owns no state. It defines the
 * shape, the cost-accumulator math, and a builder helper —
 * nothing else.
 */

import type { TraceEvent } from './subagent/traceEvents';

/**
 * Mutable per-turn cost accumulator. The SubagentCoordinator adds to
 * this when child runs complete; `chatSession.runAgentTurn` reads
 * it after the parent turn settles so the parent's totalUsage line
 * (`provider · model │ ctx-bar │ elapsed`) reflects child token spend.
 *
 * Child token costs are NOT estimated here today — `estimatedCostUSD`
 * stays at 0.0 unless a future slice wires a pricing table. The field
 * is a contract anchor: emit events / display lines should reference
 * it so wiring a real estimator later is a one-place edit.
 */
export interface CostAccumulator {
  inputTokens:       number;
  outputTokens:      number;
  totalTokens:       number;
  estimatedCostUSD:  number;
  /**
   * Per-child contribution log — preserves order, enables
   * `aiden runs show <parentRunId>` to surface "this parent turn
   * spawned N children that together cost X tokens, breakdown:".
   */
  perChild: Array<{
    subagentRunId: string;
    fanoutId:      string;
    model:         string;
    inputTokens:   number;
    outputTokens:  number;
    totalTokens:   number;
  }>;
}

/**
 * Construct an empty cost accumulator. Always returns a fresh object —
 * the parent turn owns its accumulator and never shares with sibling
 * turns. The coordinator mutates it in place during `spawnBatch`.
 */
export function makeCostAccumulator(): CostAccumulator {
  return {
    inputTokens:      0,
    outputTokens:     0,
    totalTokens:      0,
    estimatedCostUSD: 0,
    perChild:         [],
  };
}

/**
 * Add a child run's usage to the accumulator. Pure mutation — the
 * coordinator calls this after each child envelope resolves so the
 * parent has a running total even if the coordinator's `spawnBatch`
 * returns partial results (best-effort policy).
 *
 * `model` is the child's provider:model label — useful when a fanout
 * rotated providers per-child and the parent wants to surface "you
 * spent X on groq, Y on together".
 */
export function recordChildUsage(
  acc:    CostAccumulator,
  child:  {
    subagentRunId: string;
    fanoutId:      string;
    model:         string;
    inputTokens:   number;
    outputTokens:  number;
  },
): void {
  const total = child.inputTokens + child.outputTokens;
  acc.inputTokens  += child.inputTokens;
  acc.outputTokens += child.outputTokens;
  acc.totalTokens  += total;
  acc.perChild.push({
    subagentRunId: child.subagentRunId,
    fanoutId:      child.fanoutId,
    model:         child.model,
    inputTokens:   child.inputTokens,
    outputTokens:  child.outputTokens,
    totalTokens:   total,
  });
}

/**
 * Trace-event emitter signature. The coordinator fires lifecycle
 * events through this callback; the implementation (set by the
 * runtime — REPL / daemon / MCP) routes to `runStore.emitEventRich`
 * with the correct (category, kind) tags. Pure function — emitter
 * exceptions must be swallowed by the implementation, never
 * propagate into the coordinator's control flow.
 */
export type TurnTraceEmitter = (event: TraceEvent) => void;

/**
 * Per-turn runtime envelope. Built fresh in
 * `chatSession.runAgentTurn` at the top of each turn; stored on the
 * `AidenAgent` instance via `setCurrentTurnContext` (Flag 1 pattern,
 * same shape as `_currentSignal`). Cleared in the runAgentTurn
 * finally block so a stray tool dispatch between turns sees
 * `undefined` and routes through the legacy non-context path.
 *
 * Threaded into `RunConversationOptions.turnContext` so the
 * `runTurnLoop` can also store it on the agent instance — both
 * read paths (`getCurrentTurnContext()` for tool handlers, the
 * loop-local reference for any future agent-internal use) resolve
 * to the same object.
 */
export interface TurnRuntimeContext {
  /**
   * Monotonic per-turn id minted by chatSession. Same value as the
   * R1 callback-token from Slice 3 (`activeTurnId`) so late events
   * can correlate against it without a separate id.
   */
  turnId: number;
  /**
   * Stable identifier for the parent agent. Today: literal `'repl-parent'`
   * for the REPL agent. Daemon agents pass their own runner id. Used in
   * event emission + child lineage tracking — never mutated within a
   * turn.
   */
  parentAgentId: string;
  /**
   * Parent turn's AbortSignal — owned by `chatSession`'s per-turn
   * AbortController (added in Slice 3). The SubagentCoordinator
   * wires it as the cascade source for each child's linked controller.
   */
  signal: AbortSignal;
  /**
   * Mutable cost accumulator. Coordinator adds per-child usage as
   * children complete; chatSession reads it after the turn settles.
   */
  costAccumulator: CostAccumulator;
  /**
   * Optional trace emitter. When wired, coordinator fires lifecycle
   * events here; when omitted, lifecycle events are dropped silently
   * (unit tests / standalone harnesses don't need the daemon DB).
   */
  traceEmitter?: TurnTraceEmitter;
}

/**
 * Builder for the runtime context. Centralised so the chatSession +
 * any future surface (daemon-agent driver, batch CLI) construct the
 * same shape. The `signal` argument is required — a turn without an
 * abort surface is a regression we want to fail-loud on rather than
 * silently bypass cancellation.
 */
export function buildTurnRuntimeContext(opts: {
  turnId:         number;
  parentAgentId:  string;
  signal:         AbortSignal;
  traceEmitter?:  TurnTraceEmitter;
}): TurnRuntimeContext {
  return {
    turnId:           opts.turnId,
    parentAgentId:    opts.parentAgentId,
    signal:           opts.signal,
    costAccumulator:  makeCostAccumulator(),
    traceEmitter:     opts.traceEmitter,
  };
}
