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
  description: 'Clear conversation history.',
  category: 'system',
  icon: '🧹',
  handler: async (ctx) => {
    if (ctx.session) ctx.session.clearHistory();
    ctx.display.dim('History cleared.');
    return { clearHistory: true };
  },
};
