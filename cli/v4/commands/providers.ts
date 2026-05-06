/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/providers.ts — Phase 16b.1
 *
 * `/providers` — render the configured fallback chain with per-slot
 * rate-limit state and the currently-active slot highlighted. Keys are
 * masked: only the last 4 chars are shown, prefixed with bullets.
 *
 * When no FallbackAdapter is wired (single-provider boot), the command
 * still works — it shows the active provider/model from the session and
 * notes that fallback is not active.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { getEnvSource } from '../envSources';

export const providers: SlashCommand = {
  name: 'providers',
  description: 'Show the provider fallback chain + rate-limit state.',
  category: 'system',
  icon: '🛟',
  handler: async (ctx: SlashCommandContext) => {
    const fallback = ctx.fallbackAdapter ?? null;

    if (!fallback) {
      // No fallback configured — fall back to a one-line summary.
      if (ctx.session) {
        ctx.display.info(
          `Active: ${ctx.session.getCurrentProvider()} · ${ctx.session.getCurrentModel()}`,
        );
      }
      ctx.display.dim(
        '(fallback chain not active — set GROQ_API_KEY_2 / GROQ_API_KEY_3 / GROQ_API_KEY_4 / TOGETHER_API_KEY to enable)',
      );
      return {};
    }

    const diag = fallback.getDiagnostics();
    ctx.display.info('Provider fallback chain:');
    for (const slot of diag.slots) {
      const marker = slot.active ? '→' : ' ';
      const keyDisplay = slot.keyPresent
        ? slot.keyTail
          ? `key ••••${slot.keyTail}`
          : 'key set'
        : 'key unset';
      // Phase 16b.3: cooldown takes precedence over the bare rate-limited
      // badge — once the slot has a cooldown deadline, the user wants to
      // see the countdown, not just "rate-limited".
      let stateBadge = '';
      if (slot.cooldownRemainingSec > 0) {
        stateBadge = ` [cooldown ${slot.cooldownRemainingSec}s]`;
      } else if (slot.state.rateLimited) {
        stateBadge = ' [rate-limited]';
      } else if (slot.keyPresent) {
        stateBadge = ' [ready]';
      }
      const stats = slot.keyPresent
        ? ` (${slot.state.successCount} ok, ${slot.state.rateLimitCount} 429)`
        : '';
      // Phase 16c.2: show which env var the slot reads + which file/source
      // the value came from. Resolves the "labels look swapped" confusion
      // when Windows User env vars layer over the aiden-managed `.env`.
      let sourceTag = '';
      if (slot.envVar) {
        const src = getEnvSource(slot.envVar);
        if (src === 'aiden-env') sourceTag = ` ← ${slot.envVar} (aiden .env)`;
        else if (src === 'preset') sourceTag = ` ← ${slot.envVar} (shell/system env)`;
        else sourceTag = ` ← ${slot.envVar} (unset)`;
      }
      ctx.display.write(
        `  ${marker} ${slot.id.padEnd(8)} ${slot.providerId}/${slot.modelId}  ${keyDisplay}${stateBadge}${stats}${sourceTag}\n`,
      );
    }
    if (diag.activeSlotId) {
      ctx.display.dim(`active: ${diag.activeSlotId}  ·  cooldown ${diag.cooldownSec}s`);
    } else {
      ctx.display.dim(
        `(no successful call yet — first user message will pick a slot · cooldown ${diag.cooldownSec}s)`,
      );
    }
    return {};
  },
};
