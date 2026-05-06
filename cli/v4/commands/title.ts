/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/title.ts — Phase 14b
 * `/title <text>` — set the session title. Errors when text is empty.
 */
import type { SlashCommand } from '../commandRegistry';

export const title: SlashCommand = {
  name: 'title',
  description: 'Rename the current session.',
  category: 'system',
  icon: '📝',
  handler: async (ctx) => {
    const newTitle = ctx.rawArgs.trim();
    if (!newTitle) {
      ctx.display.printError('Title cannot be empty.', 'Usage: /title <text>');
      return {};
    }
    const sm = ctx.sessionManager;
    const sessionId = ctx.session?.getSessionId?.();
    if (!sm || !sessionId) {
      ctx.display.warn('No active session to rename.');
      return {};
    }
    const ok = sm.setSessionTitle(sessionId, newTitle);
    if (!ok) {
      ctx.display.printError(`Session ${sessionId} not found.`);
      return {};
    }
    ctx.display.success(`Renamed to "${newTitle}"`);
    return {};
  },
};
