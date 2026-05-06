/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/yolo.ts — Phase 14b
 *
 * `/yolo` — toggle Phase 9's ApprovalEngine between `off` and the previous
 * mode. We remember the previous mode in a module-level map keyed by the
 * engine instance so re-entering yolo restores the prior state.
 */
import type { SlashCommand } from '../commandRegistry';
import { ApprovalEngine, type ApprovalMode } from '../../../moat/approvalEngine';

const previousMode = new WeakMap<ApprovalEngine, ApprovalMode>();

export const yolo: SlashCommand = {
  name: 'yolo',
  description: 'Toggle YOLO mode (auto-allow every tool, no prompts).',
  category: 'system',
  icon: '🚀',
  handler: async (ctx) => {
    const engine = ctx.approvalEngine;
    if (!engine) {
      ctx.display.warn('Approval engine not wired in this context.');
      return {};
    }
    const current = engine.getMode();
    if (current === 'off') {
      const restore = previousMode.get(engine) ?? 'manual';
      engine.setMode(restore);
      ctx.display.success(`YOLO disabled — back to ${restore} approval mode.`);
    } else {
      previousMode.set(engine, current);
      engine.setMode('off');
      ctx.display.warn(
        'YOLO enabled — every tool auto-allows. /yolo again to disable.',
      );
    }
    return {};
  },
};
