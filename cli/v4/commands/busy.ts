/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/busy.ts — v4.12.1 Pillar 4 Slice 2a.
 *
 * `/busy <queue|interrupt|redirect>` — set what pressing Enter does WHILE a turn
 * is running. `queue` (default) appends to the type-next queue; `interrupt`
 * cancels the turn; `redirect` injects a mid-turn nudge as context (Slice 2b —
 * see also `/redirect`). `esc` always cancels the turn regardless of mode. No
 * arg → show the current mode.
 */
import type { SlashCommand } from '../commandRegistry';

const NOTE: Record<'queue' | 'interrupt' | 'redirect', string> = {
  queue:     'Enter-while-busy → QUEUE: your message waits and runs after the turn.',
  interrupt: 'Enter-while-busy → INTERRUPT: Enter cancels the running turn.',
  redirect:  'Enter-while-busy → REDIRECT: your message nudges the turn mid-flight (applies from the next step).',
};

export const busy: SlashCommand = {
  name: 'busy',
  description: 'Set Enter-while-busy behaviour: queue (default) | interrupt | redirect.',
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
      ctx.display.info(`Enter-while-busy mode: ${session.getBusyMode()} (options: queue | interrupt | redirect).`);
      return {};
    }
    if (arg !== 'queue' && arg !== 'interrupt' && arg !== 'redirect') {
      ctx.display.warn(`Unknown mode "${arg}". Choose: queue | interrupt | redirect.`);
      return {};
    }
    session.setBusyMode(arg);
    ctx.display.success(NOTE[arg]);
    return {};
  },
};
