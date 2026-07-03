/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/frame/interruptControls.ts — v4.12.1 Pillar 4 Slice 1, Phase 3.
 *
 * Thin operator surface over the EXISTING interrupt plumbing — no new
 * machinery. `esc = cancel turn` wires to the turn-scoped AbortController
 * (which already survives the runtime); `cancel one subagent` lists the
 * coordinator's active children and cancels exactly one via `cancelChild`,
 * WITHOUT cascading to its siblings (that is the coordinator's bestEffort
 * contract — a single child's abort doesn't touch the others).
 */

/**
 * Trigger the turn-scoped cancel over the EXISTING per-turn AbortController
 * (the same one Ctrl+C uses). Aborting the turn's signal unwinds the agent
 * loop cleanly and the REPL survives — no runtime kill. Returns whether it
 * fired (false if already aborted / absent). The esc KEY capture during a
 * running turn is the persistent input handler — Slice 2; this is the
 * mechanism it (and today's Ctrl+C) drives.
 */
export function requestTurnCancel(ctrl: AbortController | null | undefined): boolean {
  if (!ctrl || ctrl.signal.aborted) return false;
  try { ctrl.abort(); return true; } catch { return false; }
}

/** The slice of the coordinator this surface needs (keeps it testable). */
export interface CancelableCoordinator {
  listActiveChildren(parentTurnId: number): Array<{ subagentRunId: string; goal: string; startedAt: number }>;
  cancelChild(subagentRunId: string): boolean;
}

export interface CancelableChild { subagentRunId: string; goal: string; startedAt: number; }

/** The in-flight subagents the operator could cancel, oldest first. */
export function listCancelableSubagents(coord: CancelableCoordinator, turnId: number): CancelableChild[] {
  return coord
    .listActiveChildren(turnId)
    .map((c) => ({ subagentRunId: c.subagentRunId, goal: c.goal, startedAt: c.startedAt }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

export interface CancelOneResult {
  cancelled: boolean;
  /** subagentRunId that was cancelled (when cancelled). */
  id?:       string;
  /** How many active children remain AFTER the cancel (siblings untouched). */
  remaining: number;
}

/**
 * Cancel ONE subagent by id (or the oldest, when no id is given). Returns
 * whether it fired and how many siblings remain — proving non-cascade at the
 * call site. Cancelling an unknown / already-settled id is a no-op.
 */
export function cancelOneSubagent(
  coord: CancelableCoordinator,
  turnId: number,
  id?: string,
): CancelOneResult {
  const active = listCancelableSubagents(coord, turnId);
  const target = id ? active.find((c) => c.subagentRunId === id) : active[0];
  if (!target) return { cancelled: false, remaining: active.length };
  const cancelled = coord.cancelChild(target.subagentRunId);
  const remaining = listCancelableSubagents(coord, turnId).length;
  return { cancelled, id: cancelled ? target.subagentRunId : undefined, remaining };
}
