/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/busy.ts — v4.12.1 Pillar 4 Slice 2a.
 *
 * `/busy <queue|interrupt|steer>` — set what pressing Enter does WHILE a turn
 * is running. `queue` (default) appends to the type-next queue; `interrupt`
 * cancels the turn; `steer` injects a mid-turn nudge as context (Slice 2b —
 * see also `/steer`). `esc` always cancels the turn regardless of mode. No arg
 * → show the current mode.
 */
import type { SlashCommand } from '../commandRegistry';

const NOTE: Record<'queue' | 'interrupt' | 'steer', string> = {
  queue:     'Enter-while-busy → QUEUE: your message waits and runs after the turn.',
  interrupt: 'Enter-while-busy → INTERRUPT: Enter cancels the running turn.',
  steer:     'Enter-while-busy → STEER: your message nudges the turn mid-flight (applies from the next step).',
};

export const busy: SlashCommand = {
  name: 'busy',
  description: 'Set Enter-while-busy behaviour: queue (default) | interrupt | steer.',
  category: 'system',
  icon: '⌨️',
  handler: async (ctx) => {
    const session = ctx.session;
    if (!session?.setBusyMode || !session.getBusyMode) {
      ctx.display.warn('Not available in this context.');
      return {};
    }
    const arg = (ctx.args[0] ?? '').trim().toLowerCase();
    if (!arg) {
      ctx.display.info(`Enter-while-busy mode: ${session.getBusyMode()} (options: queue | interrupt | steer).`);
      return {};
    }
    if (arg !== 'queue' && arg !== 'interrupt' && arg !== 'steer') {
      ctx.display.warn(`Unknown mode "${arg}". Choose: queue | interrupt | steer.`);
      return {};
    }
    session.setBusyMode(arg);
    ctx.display.success(NOTE[arg]);
    return {};
  },
};
