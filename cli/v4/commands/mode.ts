/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/mode.ts — v4.14 the friendly trust-level surface.
 *
 * `/mode` (no args) shows the current level + all options in PLAIN language.
 * `/mode <level>` switches and PERSISTS (survives restart). Accepts friendly
 * aliases (safe / auto / observer) as well as the canonical dial names. This is
 * a viewer/switcher over the same autonomy dial `/autonomy` and `/auto` drive —
 * they share `applyAndPersistAutonomy`, so a level set here is durable and the
 * three can never drift.
 *
 * FLOORS ARE ABSOLUTE AT EVERY LEVEL and are NOT touched here: destructive,
 * spend, external-send, shell, and out-of-workspace writes still ASK — even in
 * `auto` (Partner) — and the hard-block set still DENIES. `/mode` only moves the
 * dial between Observer < Assistant (safe, default) < Partner (auto).
 */
import type { SlashCommand } from '../commandRegistry';
import { type AutonomyLevel, AUTONOMY_LEVELS } from '../../../moat/autonomy';
import { applyAndPersistAutonomy } from './autonomy';
import { parseUsageMode } from '../../../core/v4/usagePolicy';

/** Friendly aliases → the canonical dial level. */
const ALIASES: Readonly<Record<string, AutonomyLevel>> = {
  observer: 'Observer', 'read-only': 'Observer', readonly: 'Observer', ro: 'Observer', look: 'Observer',
  assistant: 'Assistant', safe: 'Assistant', ask: 'Assistant', cautious: 'Assistant',
  partner: 'Partner', auto: 'Partner', autopilot: 'Partner', full: 'Partner',
};

/** Plain-language, one-line description of what each level does. */
const PLAIN: Readonly<Record<AutonomyLevel, string>> = {
  Observer:  'read-only — looks, never changes anything.',
  Assistant: 'safe — acts, but asks before each write (the default).',
  Partner:   'auto — acts freely in this folder; still asks for destructive / spend / send / out-of-folder.',
};

/** The persistent, plain-language current-mode line (also used at boot/status). */
export function modeStatusLine(level: AutonomyLevel): string {
  const short = level === 'Partner' ? 'auto' : level === 'Assistant' ? 'safe' : 'observer';
  return `Trust: ${short} — ${PLAIN[level]}`;
}

export const mode: SlashCommand = {
  name: 'mode',
  description: 'Show or set trust or token-usage behavior. Persists.',
  category: 'system',
  icon: '🎚️',
  handler: async (ctx) => {
    const arg = (ctx.args[0] ?? '').trim().toLowerCase();
    const usageMode = parseUsageMode(ctx.config?.getValue<string>('usage.mode', 'balanced')) ?? 'balanced';
    const requestedUsageMode = parseUsageMode(arg);
    if (requestedUsageMode) {
      try {
        ctx.config?.set('usage.mode', requestedUsageMode);
        await ctx.config?.save();
      } catch {
        ctx.display.warn('Usage mode could not be persisted.');
        return {};
      }
      ctx.display.success(`Usage mode: ${requestedUsageMode} (applies on the next provider request).`);
      return {};
    }

    const engine = ctx.approvalEngine;
    if (!engine) { ctx.display.warn('Approval engine not wired in this context.'); return {}; }
    const current = engine.getAutonomyPolicy()?.level ?? 'Assistant';
    if (!arg) {
      // View: current + all options, active one marked, in plain language.
      ctx.display.info(modeStatusLine(current));
      ctx.display.info(`Usage: ${usageMode} (economy | balanced | thorough).`);
      for (const lvl of AUTONOMY_LEVELS) {
        ctx.display.dim(`  ${lvl === current ? '●' : '○'} ${lvl} — ${PLAIN[lvl]}`);
      }
      ctx.display.dim('Switch: /mode safe · /mode auto · /mode observer  (/auto is the same as /mode auto). Floors — destructive / spend / send / out-of-folder — always ask, even in auto.');
      return {};
    }

    const level = ALIASES[arg] ?? AUTONOMY_LEVELS.find((l) => l.toLowerCase() === arg);
    if (!level) {
      ctx.display.warn(`Unknown mode "${arg}". Try: safe | auto | observer | economy | balanced | thorough.`);
      return {};
    }

    const { applied, persisted } = await applyAndPersistAutonomy(ctx, level);
    if (!applied) {
      ctx.display.warn('Mode change was not applied (blocked by the approval floor).');
      return {};
    }
    ctx.display.success(
      `${modeStatusLine(level)}${persisted ? ' · persisted across restarts.' : ' · session only.'}`,
    );
    return {};
  },
};
