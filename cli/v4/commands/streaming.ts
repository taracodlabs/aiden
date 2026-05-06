/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/streaming.ts — Phase 16c
 *
 * `/streaming`              show current state (on/off)
 * `/streaming on`           enable token-by-token streaming for this session
 *                           (also persisted to config.yaml)
 * `/streaming off`          disable
 *
 * Wire: `display.streaming` in config. Read at the top of every agent
 * turn in `chatSession.runAgentTurn`, so the toggle is effective on the
 * next message — no restart needed.
 *
 * Default for v4.0 launch is OFF (matches Hermes default; opt-in per the
 * Phase 16a "safe fallback first" discipline).
 */
import type { SlashCommand } from '../commandRegistry';

function parseFlag(arg: string): boolean | null {
  const lower = arg.toLowerCase().trim();
  if (lower === 'on' || lower === 'true' || lower === '1' || lower === 'yes') {
    return true;
  }
  if (lower === 'off' || lower === 'false' || lower === '0' || lower === 'no') {
    return false;
  }
  return null;
}

export const streaming: SlashCommand = {
  name: 'streaming',
  description: 'Toggle token-by-token streaming output (default off in v4.0).',
  category: 'system',
  icon: '⚡',
  handler: async (ctx) => {
    const cfg = ctx.config;
    if (!cfg) {
      ctx.display.warn('Config manager not wired in this context.');
      return {};
    }
    const arg = ctx.rawArgs.trim();
    const current =
      cfg.getValue<boolean>('display.streaming', false) === true;

    if (!arg || arg === 'show') {
      ctx.display.info(`Streaming is ${current ? 'on' : 'off'}.`);
      ctx.display.dim(
        '  Use `/streaming on` or `/streaming off`. Effective on the next message.',
      );
      return {};
    }

    const next = parseFlag(arg);
    if (next === null) {
      ctx.display.printError(
        `Unknown value '${arg}'.`,
        'Use: /streaming on | off | show',
      );
      return {};
    }
    if (next === current) {
      ctx.display.info(`Streaming already ${current ? 'on' : 'off'}.`);
      return {};
    }

    cfg.set('display.streaming', next);
    try {
      await cfg.save();
    } catch (err) {
      ctx.display.warn(
        `Saved in-memory but persisting failed: ${(err as Error).message}`,
      );
    }
    ctx.display.success(
      `Streaming ${next ? 'enabled' : 'disabled'} — effective on the next message.`,
    );
    return {};
  },
};
