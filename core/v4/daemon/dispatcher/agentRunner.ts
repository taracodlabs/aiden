/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/agentRunner.ts — v4.5 Phase 5a.
 *
 * The seam between the dispatcher's claim/markDone loop and an
 * AidenAgent invocation. Keeps the dispatcher testable without
 * dragging in the full agent / provider / tool stack.
 *
 * Two responsibilities:
 *   1. Define the `DaemonAgentRunner` interface (one `invoke` method).
 *   2. Define `DaemonAgentInput` / `DaemonAgentResult` so the
 *      dispatcher and bootstrap-side wiring agree on shape.
 *
 * Bootstrap is responsible for building a runner that holds the
 * AidenAgent + provider + toolExecutor + plumbing. Tests pass a
 * stub runner.
 *
 * Two pure helpers also live here:
 *   - `buildInitialHistory(input)` — turns a `DaemonAgentInput`
 *     into the `Message[]` the agent's `runConversation` expects.
 *     Used by both the real runner and integration tests that
 *     assert the dispatched message shape.
 *   - `deliverOnlyStub(input, runStore, instanceId)` — the
 *     deliver-only short-circuit. Q-P5-4(a): logs delivery via
 *     a run_event row and returns immediately without invoking
 *     the agent. Channel-adapter integration (Telegram, Discord,
 *     etc.) is deferred to a future phase.
 *
 * The runner returns the `runId` written into `runs`. The
 * dispatcher passes that to `triggerBus.markDone(eventId,
 * claimToken, runId)` so the link FK is populated.
 */

import type { Message } from '../../../../providers/v4/types';
import type { TriggerSource } from '../types';
import type { RunStore } from '../runStore';
// v4.10 Slice 10.2b — shared event taxonomy.
import { categorizeEvent } from '../eventCategories';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Structured context the dispatcher hands to the runner.
 * Fields mirror what RecoveryReport.triggerContext surfaces.
 */
export interface TriggerInvocationContext {
  triggerId:      string;
  source:         TriggerSource;
  sourceKey:      string;
  fireReason:     string;
  eventId:        number;
  attempt:        number;
  maxAttempts:    number;
  promptTemplate: string | null;
}

/** What the dispatcher passes per-claim. */
export interface DaemonAgentInput {
  sessionId:        string;
  instanceId:       string;
  triggerEventId:   number;
  triggerContext:   TriggerInvocationContext;
  /** Rendered initial message (already template-substituted). */
  initialMessage:   string;
  /**
   * When `true`, skip the agent loop entirely. Currently only
   * the run_event log is written + the run is marked completed
   * (per Q-P5-4(a) stub). Future phases wire channel adapters.
   */
  deliverOnly:      boolean;
  /**
   * v4.13 Gap 4 — set when this invocation RESUMES a dead run. The
   * runner reuses the existing task row (the job-card accumulates
   * across attempts) instead of creating a fresh one. Parsed by the
   * dispatcher from the resume trigger event's payload.
   */
  resume?: {
    taskId:  string;
    ofRunId: number;
    attempt: number;
  };
}

/** What the runner returns to the dispatcher. */
export interface DaemonAgentResult {
  /** Created via runStore.create() — passed to triggerBus.markDone(eventId, …, runId). */
  runId:        number;
  finishReason: 'stop' | 'tool_loop' | 'budget_exhausted' | 'error' | 'delivered';
  /** Optional total-token count (when the provider reports it). */
  totalTokens?: number;
  /** Populated when finishReason === 'error'. */
  error?:       string;
}

/** The function-shaped agent invocation seam. */
export interface DaemonAgentRunner {
  invoke(input: DaemonAgentInput): Promise<DaemonAgentResult>;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Construct the initial `Message[]` history fed to
 * `AidenAgent.runConversation`. Single user message carrying
 * the rendered initial message. The system prompt is layered
 * on by the agent itself.
 *
 * Pure — no side effects, deterministic per input.
 */
export function buildInitialHistory(input: DaemonAgentInput): Message[] {
  return [
    {
      role:    'user',
      content: input.initialMessage,
    },
  ];
}

/**
 * Q-P5-4(a) deliver-only short-circuit.
 *
 * Creates a `runs` row with status `completed`, emits a
 * `delivered` run_event capturing the rendered message, and
 * returns a `DaemonAgentResult` with finishReason='delivered'.
 *
 * Channel-adapter integration (Telegram / Discord / Slack
 * webhook target / etc.) is deferred. The stub records that
 * "delivery" happened (logs only) so operators can verify the
 * code path via run_events without yet wiring a transport.
 */
export function deliverOnlyStub(
  input: DaemonAgentInput,
  runStore: RunStore,
): DaemonAgentResult {
  const runId = runStore.create({
    sessionId:      input.sessionId,
    instanceId:     input.instanceId,
    triggerEventId: input.triggerEventId,
    status:         'running',
  });
  // v4.10 Slice 10.2b — rich emission. 'delivered' maps to dispatcher
  // category via the shared categoriser; status='ok' since this stub
  // always succeeds.
  const tags = categorizeEvent('delivered');
  runStore.emitEventRich({
    runId,
    category:  tags.category,
    kind:      tags.kind,
    name:      'delivered',
    sessionId: input.sessionId,
    status:    'ok',
    summary:   `delivered ${input.triggerContext.source}/${input.triggerContext.triggerId}`,
    payload: {
      source:        input.triggerContext.source,
      triggerId:     input.triggerContext.triggerId,
      eventId:       input.triggerEventId,
      messageBytes:  input.initialMessage.length,
      deliverOnly:   true,
      /* future: target channel, adapter, response */
    },
    visibility:'system',
    source:    'daemon',
  });
  runStore.setStatus(runId, 'completed', { finishReason: 'delivered' });
  return { runId, finishReason: 'delivered' };
}

/**
 * Wrap a function-shaped invocation into the `DaemonAgentRunner`
 * interface. Convenience for tests + simple wiring.
 *
 *   const runner = makeRunner(async (input) => ({ runId, finishReason: 'stop' }));
 */
export function makeRunner(
  invoke: (input: DaemonAgentInput) => Promise<DaemonAgentResult>,
): DaemonAgentRunner {
  return { invoke };
}
