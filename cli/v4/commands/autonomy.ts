/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/autonomy.ts — v4.12.1 Pillar 2.
 *
 * `/autonomy <level>` — set the session's autonomy dial:
 *
 *   Observer  — read-only, never mutates.
 *   Assistant — acts, asks at risk boundaries (the default).
 *   Partner   — acts freely inside the workspace; destructive / external /
 *               out-of-scope still ask.
 *
 * This is the ONLY user-facing raise path: it calls `setAutonomyPolicy` with
 * `{ userInitiated: true }`, so it works after the SH.1 freeze — but
 * in-process / prompt-injected code (no userInitiated) can NEVER raise the
 * level. `--yolo` stays a separate dev bypass, not a dial level.
 */
import type { SlashCommand } from '../commandRegistry';
import { isAutonomyLevel, resolveAutonomyPolicy, AUTONOMY_LEVELS } from '../../../moat/autonomy';

export const autonomy: SlashCommand = {
  name: 'autonomy',
  description: 'Set the autonomy dial: Observer | Assistant | Partner.',
  category: 'system',
  icon: '🎚️',
  handler: async (ctx) => {
    const engine = ctx.approvalEngine;
    if (!engine) {
      ctx.display.warn('Approval engine not wired in this context.');
      return {};
    }
    const current = engine.getAutonomyPolicy()?.level ?? 'Assistant';

    const arg = (ctx.args[0] ?? '').trim();
    if (!arg) {
      ctx.display.info(
        `Autonomy: ${current}. Levels: ${AUTONOMY_LEVELS.join(' | ')}. ` +
        `Usage: /autonomy <level>.`,
      );
      return {};
    }
    // Case-insensitive match to the canonical capitalised level.
    const level = AUTONOMY_LEVELS.find((l) => l.toLowerCase() === arg.toLowerCase());
    if (!level || !isAutonomyLevel(level)) {
      ctx.display.warn(
        `Unknown level "${arg}". Choose one of: ${AUTONOMY_LEVELS.join(', ')}.`,
      );
      return {};
    }

    const policy = resolveAutonomyPolicy(level, { workspaceRoots: [process.cwd()] });
    // ★ userInitiated — the ONLY sanctioned raise path; respects SH.1 freeze.
    const applied = engine.setAutonomyPolicy(policy, { userInitiated: true });
    if (!applied) {
      ctx.display.warn('Autonomy change was not applied (blocked by the approval floor).');
      return {};
    }
    const note =
      level === 'Observer'  ? 'read-only — no mutations will run.'
      : level === 'Partner' ? `acts freely under ${process.cwd()} — destructive / external / out-of-scope still ask.`
      : 'acts, asks at each risk boundary.';
    ctx.display.success(`Autonomy set to ${level} — ${note}`);
    return {};
  },
};
