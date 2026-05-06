/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/save.ts — Phase 14b
 *
 * `/save [title]` — re-titles the current session. Empty title falls back
 * to an ISO timestamp so users can save quickly without naming.
 */
import type { SlashCommand } from '../commandRegistry';

export const save: SlashCommand = {
  name: 'save',
  description: 'Save the current session with an optional title.',
  category: 'system',
  icon: '💾',
  handler: async (ctx) => {
    const sm = ctx.sessionManager;
    const sessionId = ctx.session?.getSessionId?.();
    if (!sm || !sessionId) {
      ctx.display.warn('No active session to save.');
      return {};
    }
    const title = ctx.rawArgs.trim() || new Date().toISOString();
    const ok = sm.setSessionTitle(sessionId, title);
    if (!ok) {
      ctx.display.printError(`Session ${sessionId} not found in store.`);
      return {};
    }
    ctx.display.success(`Saved as "${title}"`);
    return {};
  },
};
