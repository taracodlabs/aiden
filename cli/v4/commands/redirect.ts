/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/redirect.ts — v4.12.1 Pillar 4 Slice 2b.
 *
 * `/redirect` — turn on REDIRECT mode: while a turn is running, type a nudge +
 * Enter and it's injected mid-turn as context (applied from the next step),
 * never as an out-of-order user message. This is the friendly name for
 * `/busy redirect`.
 *
 * (NB: the durable-task command `/adjust <task_id> …` is a SEPARATE, unrelated
 * feature — this is deliberately named `/redirect` so it never clobbers it.)
 */
import type { SlashCommand } from '../commandRegistry';

export const redirect: SlashCommand = {
  name: 'redirect',
  description: 'Redirect mode: type a nudge while a turn runs to adjust it mid-flight.',
  category: 'system',
  icon: '🧭',
  handler: async (ctx) => {
    const session = ctx.session;
    if (!session?.setBusyMode) {
      ctx.display.warn('Not available in this context.');
      return {};
    }
    session.setBusyMode('redirect');
    ctx.display.success(
      'Redirect mode ON — while a turn is running, type your nudge + Enter; it lands ' +
      'mid-turn as context (from the next step). Run /busy queue to turn it off.',
    );
    return {};
  },
};
