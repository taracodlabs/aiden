/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/eventCategories.ts — v4.10 Slice 10.2b.
 *
 * Single source of truth for the (category, kind) tags that
 * `run_events` rows carry. The schema split lets queries filter
 * cheaply at the index level (`idx_run_events_category_ts`,
 * `idx_run_events_run_kind_seq`) instead of LIKE-scanning a flat
 * kind string.
 *
 * Two emission surfaces consume this:
 *   - REPL ui_* events (model-emitted via the ui_task_update /
 *     ui_command_result / ui_approval_request / ui_toast /
 *     ui_artifact_created tools at tools/v4/index.ts)
 *   - daemon-internal events (tool_call_started, tool_call_completed,
 *     dispatcher:invoked, approval_decision, budget_warning, plus the
 *     subagent child events from childBuilder)
 *
 * Both call `categorizeEvent(name)` and pass the result into
 * `runStore.emitEventRich`. New emission sites that don't fit any
 * existing category land in `'legacy'` until a follow-up adds them
 * — never silently mis-categorize.
 *
 * Kind strings are dot-namespaced (`task.update`, `dispatcher.invoked`)
 * matching the v4.10 trace ledger contract. The first segment IS
 * the category; encoding it twice (column + prefix) is intentional
 * — the column drives the index, the prefix keeps human readability
 * in /trace recent output.
 */

export interface EventTags {
  category: string;
  kind:     string;
}

/**
 * Map an event name (the literal string passed to emitEvent) to its
 * (category, kind) pair. Names that don't match any known prefix or
 * exact value fall through to `{ category: 'legacy', kind: <name> }`
 * — preserving the pre-v4.10-Slice-10.2b behaviour for unknown
 * emissions until they get a proper mapping.
 *
 * Pure — no I/O, deterministic from input. Production sites + tests
 * call this directly.
 */
export function categorizeEvent(name: string): EventTags {
  switch (name) {
    // ── REPL ui_* tools (model-facing emission surface) ────────────
    case 'ui_task_update':       return { category: 'task',       kind: 'task.update'       };
    case 'ui_task_done':         return { category: 'task',       kind: 'task.done'         };

    // ── Slice 10.8 Task-lite lifecycle (runtime-emitted, NOT model) ──
    // Distinct kinds from ui_task_* so trace consumers can tell apart
    // "model wants to surface progress" (task.update / task.done) from
    // "runtime durable Task row changed state" (task.created /
    // task.cancelled). Both share category='task' so /trace recent
    // filtering by category surfaces the full conversation arc.
    case 'task_created':         return { category: 'task',       kind: 'task.created'      };
    case 'task_cancelled':       return { category: 'task',       kind: 'task.cancelled'    };
    case 'ui_command_result':    return { category: 'command',    kind: 'command.completed' };
    case 'ui_test_result':       return { category: 'command',    kind: 'command.test'      };
    case 'ui_approval_request':  return { category: 'approval',   kind: 'approval.requested'};
    case 'ui_toast':             return { category: 'status',     kind: 'status.update'     };
    case 'ui_artifact_created':  return { category: 'artifact',   kind: 'artifact.created'  };

    // ── Daemon tool-dispatch markers ───────────────────────────────
    case 'tool_call_started':    return { category: 'tool',       kind: 'tool.call.started'   };
    case 'tool_call_completed':  return { category: 'tool',       kind: 'tool.call.completed' };

    // ── Daemon dispatcher lifecycle ────────────────────────────────
    case 'dispatcher:invoked':   return { category: 'dispatcher', kind: 'dispatcher.invoked'   };
    case 'dispatcher:completed': return { category: 'dispatcher', kind: 'dispatcher.completed' };
    case 'dispatcher:rejected':  return { category: 'dispatcher', kind: 'dispatcher.rejected'  };
    case 'dispatcher:builder_failed': return { category: 'dispatcher', kind: 'dispatcher.builder_failed' };
    case 'budget_warning':       return { category: 'dispatcher', kind: 'dispatcher.budget_warning' };

    // ── Approval flow ──────────────────────────────────────────────
    case 'approval_decision':    return { category: 'approval',   kind: 'approval.decided' };

    // ── Trigger-event delivery ─────────────────────────────────────
    case 'delivered':            return { category: 'dispatcher', kind: 'dispatcher.delivered' };

    // ── v4.12.1 Pillar 4 Slice 1 — the Pillar 1/2/3 surfaces as events,
    //    so the glass dashboard renders ONE stream (no DB round-trip; these
    //    fire through the same live onUiEvent / emitEventRich seam). ────────
    case 'artifact_verified':    return { category: 'artifact',   kind: 'artifact.verified' };        // Pillar 3 verdict
    case 'needs_confirmation':   return { category: 'approval',   kind: 'approval.needs_confirmation' }; // Pillar 1 ledger
    case 'autonomy_changed':     return { category: 'status',     kind: 'status.autonomy' };           // Pillar 2 dial
    case 'subagent_escalation':  return { category: 'subagent',   kind: 'subagent.escalation' };       // Pillar 2/3 escalate-to-parent
    case 'cost_updated':         return { category: 'status',     kind: 'status.cost' };               // throttled cost tick
  }

  // Subagent child events from childBuilder.ts — both names share a
  // category, kind preserves the action verb.
  if (name === 'subagent_invoked' || name === 'subagent_completed' || name === 'subagent_failed') {
    return { category: 'subagent', kind: name.replace('_', '.') };
  }

  // Unknown name — preserve raw kind, flag as legacy so a follow-up
  // slice can backfill a proper mapping if the emission becomes
  // common. Never silently drop into an existing category — the
  // `legacy` bucket makes orphans visible in trace queries.
  return { category: 'legacy', kind: name };
}

/**
 * Visibility levels for run_events rows. Drives what user-facing
 * tools (trace_query, /trace recent) surface vs what stays
 * daemon-internal. Default for ui_* events: 'model'. Daemon
 * dispatcher events: 'system'. User-typed slash commands (future):
 * 'user'.
 */
export type EventVisibility = 'model' | 'user' | 'system';

/**
 * Source labels for the `source` column. Helps trace consumers
 * distinguish "the REPL fired this" from "the daemon fired this"
 * without having to JOIN through runs + instance metadata.
 */
export type EventSource = 'repl' | 'daemon' | 'subagent' | 'mcp';
