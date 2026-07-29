/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import type { SlashCommand } from '../commandRegistry';

export const session: SlashCommand = {
  name: 'session',
  description: 'Delete a stored conversation; durable Jobs and proof are preserved.',
  category: 'system',
  icon: '◇',
  handler: async (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    if (sub !== 'delete') {
      ctx.display.info('Usage: /session delete [session-id] --yes');
      return {};
    }
    if (!ctx.args.includes('--yes')) {
      ctx.display.warn('Session deletion requires confirmation.');
      ctx.display.dim('Run `/session delete [session-id] --yes`. Durable Jobs, Effects, and Proof are preserved.');
      return {};
    }
    if (!ctx.session?.deleteStoredSession) {
      ctx.display.warn('Stored-session deletion is unavailable in this runtime.');
      return {};
    }
    const requested = ctx.args.slice(1).find((arg) => arg !== '--yes');
    const result = ctx.session.deleteStoredSession(requested);
    if (!result) {
      ctx.display.warn(requested ? `Session not found: ${requested}` : 'The active session could not be deleted.');
      return {};
    }
    ctx.display.success(`Stored session deleted · ${result.deletedId}`);
    ctx.display.dim('Durable Jobs, Effects, and Proof remain available.');
    if (result.replacementId) ctx.display.dim(`New active session · ${result.replacementId}`);
    return { clearHistory: result.replacementId !== null };
  },
};
