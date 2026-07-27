/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import type { SlashCommand } from '../commandRegistry';

export const cls: SlashCommand = {
  name: 'cls',
  aliases: ['redraw'],
  description: 'Repaint only the terminal; session and durable state are unchanged.',
  category: 'system',
  icon: '◇',
  handler: async (ctx) => {
    ctx.display.clearScreen();
    return { suppressSeparator: true };
  },
};
