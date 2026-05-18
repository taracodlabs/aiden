/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/spawnPause.ts — v4.6 Phase 3A.
 *
 * `/spawn-pause on|off|status [reason...]` — operator kill-switch
 * for sub-agent spawning. Backed by a file marker at
 * `$aidenHome/spawn.paused` (see `core/v4/subagent/spawnPause.ts`)
 * so REPL + daemon + MCP server all coordinate via the same state.
 *
 *   /spawn-pause on                  — pause, no reason
 *   /spawn-pause on runaway-fanout   — pause, reason="runaway-fanout"
 *   /spawn-pause on deploy window    — pause, reason="deploy window"
 *   /spawn-pause off                 — resume
 *   /spawn-pause status              — current state + reason + duration
 *
 * Unlike `/planner-guard`, `/sandbox`, etc., this command does NOT
 * route through `runtimeToggles` — pause state is file-marker-
 * backed (cross-process visibility) with first-class
 * reason/pausedAt/pausedBy metadata that the boolean toggle surface
 * can't carry. Mirrors plannerGuard.ts's command shape; diverges
 * from `_runtimeToggleHelpers` because the storage backend is
 * different.
 *
 * Hard contract: in-flight children are NEVER cancelled by this
 * command. Pause affects only NEW spawns. Operators who want to
 * stop in-flight runs use `aiden runs interrupt <runId>` (the
 * existing per-run cancellation surface from v4.5 Phase 6).
 */

import type { SlashCommand } from '../commandRegistry';
import { getSpawnPause } from '../../../core/v4/subagent/spawnPause';

/** Format a duration in ms as a compact `Xs` / `Xm` / `Xh` string. */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export const spawnPause: SlashCommand = {
  name: 'spawn-pause',
  description: 'Pause/resume sub-agent spawning (in-flight children continue).',
  category: 'system',
  icon: '⏸',
  handler: async (ctx) => {
    const action = (ctx.args[0] ?? 'status').toLowerCase();
    const reasonArg = ctx.args.slice(1).join(' ').trim() || null;

    let state;
    try {
      state = getSpawnPause();
    } catch (e) {
      ctx.display.printError(
        'spawn-pause: not initialized — REPL boot did not wire the singleton.',
        e instanceof Error ? e.message : String(e),
      );
      return {};
    }

    if (action === 'on' || action === 'enable' || action === 'true' || action === '1') {
      state.pause({ reason: reasonArg, pausedBy: 'repl' });
      const s = state.status();
      const reasonLine = s.reason ? `   reason: ${s.reason}\n` : '';
      ctx.display.write(`spawn-pause: ON\n${reasonLine}`);
      ctx.display.dim(
        '  in-flight children continue. New spawn_sub_agent / subagent_fanout calls will reject.',
      );
      return {};
    }

    if (action === 'off' || action === 'disable' || action === 'false' || action === '0' || action === 'resume') {
      state.resume();
      ctx.display.write('spawn-pause: OFF (resumed)\n');
      return {};
    }

    if (action === 'status' || action === '') {
      const s = state.status();
      if (!s.paused) {
        ctx.display.write('spawn-pause: OFF\n');
        return {};
      }
      const reasonLine    = s.reason     ? `   reason:    ${s.reason}\n`                          : '';
      const durationLine  = s.durationMs !== undefined ? `   duration:  ${formatDuration(s.durationMs)}\n` : '';
      const pausedAtLine  = s.pausedAt   ? `   pausedAt:  ${new Date(s.pausedAt).toISOString()}\n` : '';
      const pausedByLine  = s.pausedBy   ? `   pausedBy:  ${s.pausedBy}\n`                          : '';
      ctx.display.write(
        `spawn-pause: ON\n${reasonLine}${durationLine}${pausedAtLine}${pausedByLine}`,
      );
      return {};
    }

    ctx.display.printError(
      'Usage: /spawn-pause on [reason...] | off | status',
    );
    return {};
  },
};
