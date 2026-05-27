/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 4 — Subagent trace-event schema.
 *
 * Discriminated union for every lifecycle event the SubagentCoordinator
 * emits. The `TurnTraceEmitter` (set on `TurnRuntimeContext`) consumes
 * these and writes through `runStore.emitEventRich` with a fixed
 * `source: 'subagent'`. Schema decoupled from the persistence layer
 * so unit tests can capture events in-memory without a daemon DB.
 *
 * Every event carries:
 *   - eventType (discriminant)
 *   - fanoutId  — groups every event in one batch
 *   - subagentRunId — `sa-<fanoutId>-<taskIdx>-<8char>`
 *   - taskIndex — input-order slot the child occupies
 *   - parentTurnId — links back to the parent's TurnRuntimeContext
 *   - timestamp (epoch ms)
 *
 * Per-event extras live in the variant body. Provider / model land on
 * the `started` variant; usage / cost land on terminal variants
 * (completed / failed / cancelled / timeout). Tool events carry the
 * tool name + per-tool-call id so the trace UI can pair them.
 */

/** Common fields on every coordinator trace event. */
interface TraceEventBase {
  fanoutId:       string;
  subagentRunId:  string;
  taskIndex:      number;
  parentTurnId:   number;
  timestamp:      number;
}

/** Fired when the coordinator queues a child (pre-build). */
export interface TraceEventSpawned extends TraceEventBase {
  eventType: 'subagent.spawned';
  goal:      string;
}

/** Fired when the child agent actually starts executing (post-build). */
export interface TraceEventStarted extends TraceEventBase {
  eventType: 'subagent.started';
  provider:  string;
  model:     string;
}

/** Fired by the child agent at each tool dispatch. */
export interface TraceEventToolStarted extends TraceEventBase {
  eventType: 'subagent.tool_started';
  toolName:  string;
  toolCallId: string;
}

/** Fired by the child agent when a tool call returns. */
export interface TraceEventToolCompleted extends TraceEventBase {
  eventType:  'subagent.tool_completed';
  toolName:   string;
  toolCallId: string;
  durationMs: number;
  ok:         boolean;
  error?:     string;
}

/** Fired when the child finishes naturally (stop / max_iterations). */
export interface TraceEventCompleted extends TraceEventBase {
  eventType:    'subagent.completed';
  durationMs:   number;
  provider:     string;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
  summary:      string;
}

/** Fired when the child surfaces an error (envelope.ok === false). */
export interface TraceEventFailed extends TraceEventBase {
  eventType:    'subagent.failed';
  durationMs:   number;
  provider:     string;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
  error:        string;
  exitReason:   string;
}

/** Fired when cancellation fires (parent abort or external cancel). */
export interface TraceEventCancelled extends TraceEventBase {
  eventType:    'subagent.cancelled';
  durationMs:   number;
  provider:     string;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
  reason:       'parent_cancel' | 'external_cancel' | 'unknown';
}

/** Fired when the child hits its wall-clock timeout. */
export interface TraceEventTimeout extends TraceEventBase {
  eventType:    'subagent.timeout';
  durationMs:   number;
  provider:     string;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
}

/** Discriminated union of every event the coordinator emits. */
export type TraceEvent =
  | TraceEventSpawned
  | TraceEventStarted
  | TraceEventToolStarted
  | TraceEventToolCompleted
  | TraceEventCompleted
  | TraceEventFailed
  | TraceEventCancelled
  | TraceEventTimeout;
