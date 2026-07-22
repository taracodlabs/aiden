/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/budget.ts — v4.12 BE.1.
 *
 * `/budget` — show this session's token usage vs the per-session token cap
 * (config `budget.session_token_cap`). `/budget <n>` sets the cap for THIS
 * session (config.yaml persists the durable default). 0 / unset = no cap.
 *
 * The cap is enforced money-safely at the provider-call boundary (see
 * aidenAgent BE.1): a call that would exceed it is never made.
 */

import type { SlashCommand } from '../commandRegistry';
import { currentProviderAttemptLedger } from '../../../providers/v4/providerAttemptAccounting';
import { classifyBudgetState } from '../../../core/v4/usagePolicy';

export const budget: SlashCommand = {
  name: 'budget',
  description: 'Show session token usage vs cap; `/budget <n>` sets it (0 = off).',
  category: 'system',
  icon: '💰',
  handler: async (ctx) => {
    const cap = ctx.config?.getValue<number>('budget.session_token_cap', 0) ?? 0;
    const costCap = ctx.config?.getValue<number>('budget.session_cost_cap_usd', 0) ?? 0;
    const arg = (ctx.args[0] ?? '').trim();
    const asJson = ctx.args.includes('--json');

    if (/^cost$/i.test(arg)) {
      const raw = (ctx.args[1] ?? '').trim();
      if (!raw) {
        ctx.display.info(costCap > 0
          ? `Estimated-cost cap: $${costCap.toFixed(4)} per session.`
          : 'Estimated-cost cap: off.');
        return {};
      }
      const amount = /^off$/i.test(raw) ? 0 : Number(raw);
      if (!Number.isFinite(amount) || amount < 0) {
        ctx.display.printError('Usage: /budget cost <usd | off>');
        return {};
      }
      try {
        ctx.config?.set('budget.session_cost_cap_usd', amount);
        await ctx.config?.save();
      } catch { /* best-effort */ }
      ctx.display.success(amount === 0
        ? 'Session estimated-cost cap disabled.'
        : `Session estimated-cost cap set to $${amount.toFixed(4)}. Applies to new sessions.`);
      return {};
    }

    // Set path — `/budget <n>` (or `/budget off`).
    if (arg && arg !== '--json') {
      const raw = /^tokens$/i.test(arg) ? (ctx.args[1] ?? '') : arg;
      const n = /^off$/i.test(raw) ? 0 : Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        ctx.display.printError('Usage: /budget [<max_tokens> | off | cost <usd | off>]');
        return {};
      }
      try { ctx.config?.set('budget.session_token_cap', n); await ctx.config?.save(); } catch { /* best-effort */ }
      ctx.display.success(
        n === 0
          ? 'Session token cap disabled (no budget enforcement).'
          : `Session token cap set to ${n.toLocaleString()} tokens. Applies to new sessions (restart to re-arm the running agent).`,
      );
      return {};
    }

    // View path.
    const id = ctx.session?.getSessionId?.();
    const ledger = currentProviderAttemptLedger();
    const projection = id && ledger ? ledger.project({ sessionId: id }) : null;
    const used = projection
      ? (projection.providerInputTokens + projection.providerOutputTokens
        || projection.estimatedInputTokens + projection.estimatedOutputTokens)
      : id && ctx.sessionManager ? ctx.sessionManager.getSessionTokens(id) : 0;
    const state = classifyBudgetState(used, cap);
    if (asJson) {
      ctx.display.write(`${JSON.stringify({
        sessionId: id ?? null,
        usedTokens: used,
        tokenBudget: cap || null,
        estimatedCostBudget: costCap || null,
        state,
        cost: projection ? {
          knownAmount: projection.knownCostAmount,
          currency: projection.costCurrency,
          unknownAttempts: projection.unknownCostAttempts,
        } : null,
      })}\n`);
      return {};
    }
    if (cap > 0) {
      const pct = Math.round((used / cap) * 100);
      ctx.display.info(`Budget: ${used.toLocaleString()} / ${cap.toLocaleString()} tokens (${pct}%) this session.`);
      ctx.display.info(`  State: ${state}`);
      if (pct >= 100) ctx.display.warn('  Budget reached. Optional exploration and new expensive branches are blocked.');
      else if (pct >= 80) ctx.display.warn('  Budget warning. Optional exploration is disabled; required safety and verification continue.');
      ctx.display.info('  Set with `/budget <max_tokens>` or config `budget.session_token_cap`; `/budget off` to disable.');
    } else {
      ctx.display.info(`Budget: ${used.toLocaleString()} tokens used this session — no cap set.`);
      ctx.display.info('  Set a cap with `/budget <max_tokens>` (money-safety: stops before overspending).');
    }
    if (projection) {
      const costState = projection.unknownCostAttempts > 0
        ? 'unknown'
        : classifyBudgetState(projection.knownCostAmount, costCap);
      ctx.display.info(costCap > 0
        ? `  Estimated cost: $${projection.knownCostAmount.toFixed(4)} / $${costCap.toFixed(4)} (${costState}).`
        : `  Known estimated cost: $${projection.knownCostAmount.toFixed(4)} (no cost cap).`);
      if (projection.unknownCostAttempts > 0) {
        ctx.display.warn(`  Cost remains unknown for ${projection.unknownCostAttempts} attempt(s).`);
      }
    }
    return {};
  },
};
