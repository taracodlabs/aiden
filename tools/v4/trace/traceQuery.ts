/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/trace/traceQuery.ts — `trace_query` tool (v4.10 Slice 10.2 / 10.2b).
 *
 * Model-facing read-only query over the run_events stream. Backs the
 * model's introspection of "what happened" without dumping full
 * transcripts.
 *
 * Slice 10.2b — schema is now (category, kind, name) + status +
 * tool_call_id + duration_ms + summary + payload_truncated. The tool
 * exposes scope-aware queries:
 *
 *   - default scope = 'current_session' (resolves the REPL session id)
 *   - 'current_run' (the in-flight turn only) — most selective
 *   - 'last_hours' (recent across all sessions of the daemon)
 *   - explicit 'run_id' / 'session_id' (by-id queries)
 *
 * Filters compose with AND: category, kind, name, tool_call_id.
 *
 * Returned rows include the raw JSON payload string (capped at 4096
 * bytes inline; `truncated` flag + `payload_bytes` surface the
 * original size). The model knows the detail may be partial and can
 * narrow the query.
 *
 * Factory pattern matches spawn_sub_agent: dependencies injected at
 * registration time, captured in closure. No ToolContext changes —
 * trace_query is REPL-only by construction (the factory isn't wired
 * into daemon-fired agentBuilder paths).
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { RunStore, ListEventsScopedOptions } from '../../../core/v4/daemon/runStore';

export interface MakeTraceQueryOptions {
  runStore: RunStore;
  /**
   * Returns the current REPL chat session id, or null if no session
   * is active (between turns, before first turn). Matches the
   * resolveParentSessionId pattern at aidenCLI.ts:1951.
   */
  resolveSessionId: () => string | null;
  /**
   * Slice 10.2b — returns the in-flight runId for the current REPL
   * turn so the model can ask for `scope='current_run'`. Null when
   * no turn is in flight (between turns).
   */
  resolveRunId?:    () => number | null;
}

type Scope = 'current_run' | 'current_session' | 'run_id' | 'session_id' | 'last_hours' | 'all';

export function makeTraceQueryTool(opts: MakeTraceQueryOptions): ToolHandler {
  return {
    schema: {
      name: 'trace_query',
      description:
        'Query recent events from the run_events ledger. Returns ui_* emissions, tool dispatch markers, dispatcher decisions, approval audit rows. Newest first. Default scope is the current REPL session; pass scope="current_run" for the in-flight turn only, or scope="last_hours" + hours=N for recent activity across all sessions. Filters: category (task|tool|dispatcher|approval|...), kind (e.g. tool.call.completed), name (raw emission name), tool_call_id.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['current_run', 'current_session', 'run_id', 'session_id', 'last_hours', 'all'],
            description: 'Query scope. Defaults to "current_session" when omitted.',
          },
          run_id: {
            type: 'number',
            description: 'Required when scope="run_id".',
          },
          session_id: {
            type: 'string',
            description: 'Required when scope="session_id".',
          },
          hours: {
            type: 'number',
            description: 'Required when scope="last_hours". Window size in hours.',
          },
          category: {
            type: 'string',
            description: 'Filter by category. Common values: task, command, approval, status, artifact, tool, dispatcher, subagent.',
          },
          kind: {
            type: 'string',
            description: 'Filter by exact kind (e.g. "task.update", "tool.call.completed", "dispatcher.invoked").',
          },
          name: {
            type: 'string',
            description: 'Filter by the original emission name (e.g. "ui_task_update", "tool_call_started").',
          },
          tool_call_id: {
            type: 'string',
            description: 'Filter to events linked to a specific tool_call frame id.',
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
      const limit = Math.max(1, Math.min(Number(args.limit ?? 50) || 50, 500));
      const scope: Scope = (typeof args.scope === 'string' && isScope(args.scope))
        ? args.scope
        : 'current_session';

      // Build the discriminated query options based on scope.
      let query: ListEventsScopedOptions;
      switch (scope) {
        case 'current_run': {
          const rid = opts.resolveRunId?.() ?? null;
          if (rid === null) {
            return {
              success: false,
              error: 'scope="current_run" requested but no REPL turn is in flight.',
            };
          }
          query = { scope: 'current_run', runId: rid, limit };
          break;
        }
        case 'current_session': {
          // v4.10 Slice 10.2c — resolveSessionId returns the long-lived
          // REPL chat session id, populated at ChatSession.run() init
          // and stable until the REPL exits. Pre-10.2c read the
          // turn-scoped mirror which got nulled between turns,
          // returning "no session" mid-conversation. The defensive
          // null guard remains for the post-/quit edge.
          const sid = opts.resolveSessionId();
          if (!sid) {
            return {
              success: false,
              error: 'No REPL session active — trace_query default scope requires a chat session. Pass scope="last_hours" or scope="all" to query without one.',
            };
          }
          query = { scope: 'current_session', sessionId: sid, limit };
          break;
        }
        case 'run_id': {
          const rid = Number(args.run_id);
          if (!Number.isFinite(rid)) {
            return { success: false, error: 'scope="run_id" requires a numeric run_id argument.' };
          }
          query = { scope: 'run_id', runId: rid, limit };
          break;
        }
        case 'session_id': {
          const sid = typeof args.session_id === 'string' ? args.session_id : '';
          if (!sid) {
            return { success: false, error: 'scope="session_id" requires a session_id string argument.' };
          }
          query = { scope: 'session_id', sessionId: sid, limit };
          break;
        }
        case 'last_hours': {
          const h = Number(args.hours);
          if (!Number.isFinite(h) || h <= 0) {
            return { success: false, error: 'scope="last_hours" requires a positive numeric hours argument.' };
          }
          query = { scope: 'last_hours', hours: h, limit };
          break;
        }
        case 'all': {
          query = { scope: 'all', limit };
          break;
        }
      }

      // Apply optional filters (mutating the discriminated object
      // is fine — the shared filter fields exist on every variant).
      const q = query as ListEventsScopedOptions & {
        category?:   string;
        kind?:       string;
        name?:       string;
        toolCallId?: string;
      };
      if (typeof args.category === 'string')      q.category   = args.category;
      if (typeof args.kind === 'string')          q.kind       = args.kind;
      if (typeof args.name === 'string')          q.name       = args.name;
      if (typeof args.tool_call_id === 'string')  q.toolCallId = args.tool_call_id;

      let rows;
      try {
        rows = opts.runStore.listEventsScoped(q);
      } catch (e) {
        return {
          success: false,
          error: `trace_query failed: ${(e as Error).message}`,
        };
      }

      return {
        success: true,
        count: rows.length,
        events: rows.map((r) => ({
          id:               r.id,
          run_id:           r.runId,
          session_id:       r.sessionId,
          ts:               r.ts,
          seq:              r.seq,
          category:         r.category,
          kind:             r.kind,
          name:             r.name,
          tool_call_id:     r.toolCallId,
          status:           r.status,
          duration_ms:      r.durationMs,
          summary:          r.summary,
          // Pass raw JSON string — the model can JSON.parse if it
          // needs structured access. Cheaper than re-parsing here
          // and re-stringifying for transport.
          payload:          r.payload,
          payload_truncated: r.payloadTruncated,
          payload_bytes:    r.payloadBytes,
          visibility:       r.visibility,
          source:           r.source,
        })),
        // Echo filters back so the model can reason about widening.
        filters: {
          scope,
          run_id:       (q.scope === 'current_run' || q.scope === 'run_id') ? q.runId : null,
          session_id:   (q.scope === 'current_session' || q.scope === 'session_id') ? q.sessionId : null,
          hours:        q.scope === 'last_hours' ? q.hours : null,
          category:     q.category   ?? null,
          kind:         q.kind       ?? null,
          name:         q.name       ?? null,
          tool_call_id: q.toolCallId ?? null,
          limit,
        },
      };
    },
  };
}

function isScope(s: string): s is Scope {
  return s === 'current_run' || s === 'current_session' || s === 'run_id'
      || s === 'session_id'  || s === 'last_hours'      || s === 'all';
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
