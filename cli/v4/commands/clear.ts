/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/clear.ts — Phase 14b
 * `/clear` — drops conversation history; chat REPL handles the actual reset.
 */
import type { SlashCommand } from '../commandRegistry';

export const clear: SlashCommand = {
  name: 'clear',
  description: 'Start a clean conversation; durable Jobs and proof remain available.',
  category: 'system',
  icon: '*',
  handler: async (ctx) => {
    const id = ctx.session?.startNewSession?.() ?? null;
    if (id) {
      ctx.display.clearScreen();
      ctx.display.success(`New chat started · ${id}`);
      ctx.display.dim('Previous Jobs and proof remain available through /jobs and /trace.');
      ctx.display.dim('History cleared.');
      return { clearHistory: true };
    }
    if (ctx.session) ctx.session.clearHistory();
    ctx.display.dim('History cleared. Persisted session switching is unavailable in this runtime.');
    return { clearHistory: true };
  },
};
