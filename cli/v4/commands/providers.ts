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
        '(fallback chain not active — set GROQ_API_KEY_2 / GROQ_API_KEY_3 / TOGETHER_API_KEY to enable)',
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
      const stateBadge = slot.state.rateLimited
        ? ' [rate-limited]'
        : slot.keyPresent
          ? ' [ready]'
          : '';
      const stats = slot.keyPresent
        ? ` (${slot.state.successCount} ok, ${slot.state.rateLimitCount} 429)`
        : '';
      ctx.display.write(
        `  ${marker} ${slot.id.padEnd(8)} ${slot.providerId}/${slot.modelId}  ${keyDisplay}${stateBadge}${stats}\n`,
      );
    }
    if (diag.activeSlotId) {
      ctx.display.dim(`active: ${diag.activeSlotId}`);
    } else {
      ctx.display.dim('(no successful call yet — first user message will pick a slot)');
    }
    return {};
  },
};
