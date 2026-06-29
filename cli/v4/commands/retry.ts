/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/retry.ts — v4.11 Slice C.
 *
 * `/retry` — revert the last turn (reusing /undo's snapshot stack) and
 * re-run that turn's user prompt for a fresh response. The revert is
 * in-memory only (same contract as /undo); the prompt is re-dispatched
 * by the REPL read loop via the `rerun` result signal.
 */
import type { SlashCommand } from '../commandRegistry';

export const retry: SlashCommand = {
  name: 'retry',
  description: 'Re-run your last prompt for a fresh response.',
  category: 'system',
  icon: '↻',
  handler: async (ctx) => {
    if (!ctx.session?.retryLastTurn) {
      ctx.display.warn('Retry is not available in this session.');
      return {};
    }
    const input = ctx.session.retryLastTurn();
    if (input === null) {
      ctx.display.dim('Nothing to retry — no prior prompt this session.');
      return {};
    }
    ctx.display.dim('Re-running your last prompt…');
    return { rerun: input };
  },
};
