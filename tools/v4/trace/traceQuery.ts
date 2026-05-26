/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/trace/traceQuery.ts — `trace_query` tool (v4.10 Slice 10.2).
 *
 * Model-facing read-only query over the current REPL session's
 * run_events stream. Backs the model's introspection of "what
 * happened this conversation" without dumping the full chat history.
 *
 * Scope: CURRENT REPL SESSION ONLY (per Phase B Q2). Cross-session
 * queries deferred to v4.11.
 *
 * Returned rows include the raw JSON payload string (capped at 4096
 * chars by runStore.emitEvent on write). A `truncated` flag surfaces
 * when the payload was clipped — so the model knows the event detail
 * may be partial.
 *
 * Factory pattern matches spawn_sub_agent (cli/v4/aidenCLI.ts:1914):
 * dependencies injected at registration time, captured in closure.
 * No ToolContext changes — trace_query is REPL-only by construction
 * (the factory isn't called from daemon-fired agentBuilder paths).
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { RunStore } from '../../../core/v4/daemon/runStore';

/** Hard cap on payload bytes that runStore.emitEvent enforces. */
const PAYLOAD_CAP_BYTES = 4096;

export interface MakeTraceQueryOptions {
  runStore: RunStore;
  /**
   * Returns the current REPL chat session id, or null if no session
   * is active (between turns, before first turn). Matches the
   * resolveParentSessionId pattern at aidenCLI.ts:1951.
   */
  resolveSessionId: () => string | null;
}

export function makeTraceQueryTool(opts: MakeTraceQueryOptions): ToolHandler {
  return {
    schema: {
      name: 'trace_query',
      description:
        'Query recent events from the current REPL session. Returns ui_* emissions, tool dispatch markers, and dispatcher decisions — anything written to run_events during this conversation. Newest first. Use this to recall "what happened in the last N minutes of this chat" without re-reading the whole transcript.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description: 'Human-relative timestamp (e.g. "5min", "30s", "1h"). Omit for last 100 events regardless of age.',
          },
          kind_prefix: {
            type: 'string',
            description: 'Event kind prefix filter (e.g. "ui_" for all UI events, "ui_task_" for task-only, "tool_call_" for dispatch markers).',
          },
          limit: {
            type: 'number',
            description: 'Max rows (default 50, hard cap 500).',
          },
        },
      },
    },
    category: 'read',
    mutates: false,
    toolset: 'trace',
    riskTier: 'safe',
    async execute(args) {
      const sessionId = opts.resolveSessionId();
      if (!sessionId) {
        return {
          success: false,
          error: 'No active REPL session — trace_query is REPL-only and requires a session in flight.',
        };
      }
      const limit = Math.max(1, Math.min(Number(args.limit ?? 50) || 50, 500));
      const kindPrefix = typeof args.kind_prefix === 'string' ? args.kind_prefix : undefined;
      const sinceMs = parseSince(args.since);

      let rows;
      try {
        rows = opts.runStore.listEventsForSession({
          sessionId,
          ...(kindPrefix !== undefined ? { kindPrefix } : {}),
          ...(sinceMs    !== undefined ? { sinceMs    } : {}),
          limit,
        });
      } catch (e) {
        return {
          success: false,
          error: `trace_query failed: ${(e as Error).message}`,
        };
      }

      return {
        success: true,
        count: rows.length,
        events: rows.map((r) => {
          const truncated = r.payload.length >= PAYLOAD_CAP_BYTES;
          return {
            run_id:    r.runId,
            ts:        r.ts,
            kind:      r.kind,
            // Pass raw JSON string — the model can JSON.parse if it
            // needs structured access. Cheaper than re-parsing here
            // and re-stringifying for transport.
            payload:   r.payload,
            truncated,
          };
        }),
        // Surface the filters echoed back so the model can reason
        // about whether to widen the query.
        filters: {
          session_id:  sessionId,
          kind_prefix: kindPrefix ?? null,
          since_ms:    sinceMs    ?? null,
          limit,
        },
      };
    },
  };
}

/**
 * Parse a human-relative timestamp arg into an absolute epoch-ms
 * cutoff. Accepts `<N>s` / `<N>min` / `<N>m` / `<N>h` / `<N>d`.
 * Returns undefined for unrecognized input — treated as "no time
 * filter" by the caller rather than erroring out (the model often
 * passes garbage in optional fields).
 */
function parseSince(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = raw.trim().match(/^(\d+)\s*(s|sec|secs|min|m|h|hr|hrs|d|day|days)?$/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = (m[2] ?? 's').toLowerCase();
  let multiplier = 1000;
  if (unit === 'min' || unit === 'm')       multiplier = 60_000;
  else if (unit === 'h' || unit === 'hr' || unit === 'hrs') multiplier = 3_600_000;
  else if (unit === 'd' || unit === 'day' || unit === 'days') multiplier = 86_400_000;
  return Date.now() - (n * multiplier);
}
