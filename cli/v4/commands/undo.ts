/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/undo.ts — v4.11 Slice B.
 *
 * `/undo` — revert the last turn from this session's working context by
 * restoring the history snapshot captured at the start of that turn.
 *
 * In-memory only: the persisted session (SessionManager.recordTurn) is
 * NOT reverted, so resuming a saved session restores full history. The
 * command output states this caveat explicitly.
 */
import type { SlashCommand } from '../commandRegistry';

export const undo: SlashCommand = {
  name: 'undo',
  description: "Revert the last turn from this session's working context.",
  category: 'system',
  icon: '↶',
  handler: async (ctx) => {
    if (!ctx.session?.undoLastTurn) {
      ctx.display.warn('Undo is not available in this session.');
      return {};
    }
    const reverted = ctx.session.undoLastTurn();
    if (!reverted) {
      ctx.display.dim('Nothing to undo — no prior turn this session.');
      return {};
    }
    ctx.display.success("Reverted the last turn's conversation context.");
    ctx.display.dim(
      'Note: this undoes one turn only — run /undo again to revert further back. ' +
      'Memory writes (USER.md / MEMORY.md) and the saved session are not reverted.',
    );
    return {};
  },
};
