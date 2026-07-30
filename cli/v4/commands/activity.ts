/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/activity.ts — v4.12 /commands slice.
 *
 * `/activity` — a thin single-screen roll-up that AGGREGATES existing sources;
 * it does NOT recompute or duplicate their logic. Each datum is read through
 * the same accessor the dedicated command uses:
 *
 *   - tokens (in/out)  ← ctx.session.getTotalUsage()      (the /usage source)
 *   - budget cap+used  ← config budget.session_token_cap + sessionManager
 *                        .getSessionTokens()               (the /budget source)
 *   - recent prompts   ← historyStore.loadRecent()         (the /history source)
 *   - durable tasks    ← replTaskStore.listRecent()        (the /tasks source)
 *   - artifacts        ← replArtifactStore.listRecent()    (the /artifacts source)
 *
 * Because the task/artifact stores are boot-local (like /tasks and /artifacts),
 * this command is registered INLINE in aidenCLI (not the barrel) via
 * `makeActivityCommand`, which is handed the live accessors. The factory shape
 * keeps the roll-up unit-testable: inject spy accessors, assert it reads them
 * and formats their values rather than recomputing.
 */

import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import type { ActivityPresentationMode } from '../semanticActivity';

/** Live accessors, supplied by the REPL boot. Each mirrors one command's source. */
export interface ActivitySources {
  /** Current REPL session id (replParentRunRef.chatSessionId); undefined pre-chat. */
  sessionId: () => string | undefined;
  /** config `budget.session_token_cap` (0 = no cap) — the /budget cap source. */
  getCap: () => number;
  /** sessionManager.getSessionTokens(id) — the /budget used-tokens source. */
  getUsedTokens: (sessionId: string) => number;
  /** loadRecent().length — the /history source (count of recent prompts). */
  getHistoryCount: () => number | Promise<number>;
  /** replTaskStore.listRecent({sessionId}) — the /tasks source (rows, for counting). */
  listTasks: (sessionId: string) => Array<{ status: string }>;
  /** replArtifactStore.listRecent({sessionId}) — the /artifacts source (rows, for counting). */
  listArtifacts: (sessionId: string) => unknown[];
  getPresentationMode?: () => ActivityPresentationMode;
  setPresentationMode?: (mode: ActivityPresentationMode) => void;
}

/** Build the inline `/activity` command over the supplied live accessors. */
export function makeActivityCommand(sources: ActivitySources): SlashCommand {
  return {
    name: 'activity',
    description: 'Session roll-up and activity detail mode. Usage: /activity [summary|full].',
    category: 'system',
    icon: '≋',
    handler: async (ctx: SlashCommandContext) => {
      const requestedMode = ctx.args[0]?.toLowerCase();
      if (requestedMode && requestedMode !== 'summary' && requestedMode !== 'full') {
        ctx.display.warn('Usage: /activity [summary|full]');
        return {};
      }
      if (requestedMode === 'summary' || requestedMode === 'full') {
        sources.setPresentationMode?.(requestedMode);
      }
      const presentationMode = sources.getPresentationMode?.() ?? 'summary';
      const id = sources.sessionId();
      // /usage source — best-effort (session may lack the optional accessor).
      const usage = ctx.session?.getTotalUsage?.() ?? { inputTokens: 0, outputTokens: 0 };
      const cap = sources.getCap();
      const used = id ? sources.getUsedTokens(id) : 0;
      const historyCount = await sources.getHistoryCount();
      const tasks = id ? sources.listTasks(id) : [];
      const artifacts = id ? sources.listArtifacts(id) : [];

      const totalTok = usage.inputTokens + usage.outputTokens;
      ctx.display.info('Activity — this session');
      ctx.display.write(`  View      : ${presentationMode} (/activity summary · /activity full)\n`);
      ctx.display.write(
        `  Tokens    : ${usage.inputTokens.toLocaleString()} in · ` +
        `${usage.outputTokens.toLocaleString()} out (${totalTok.toLocaleString()} total)\n`,
      );
      if (cap > 0) {
        const pct = Math.min(100, Math.round((used / cap) * 100));
        ctx.display.write(`  Budget    : ${used.toLocaleString()} / ${cap.toLocaleString()} tokens (${pct}%)\n`);
      } else {
        ctx.display.write(`  Budget    : no cap set (${used.toLocaleString()} tokens this session)\n`);
      }
      ctx.display.write(`  History   : ${historyCount} recent prompt${historyCount === 1 ? '' : 's'}\n`);

      // Roll up task rows by status (aggregation of the same rows /tasks lists).
      const byStatus = tasks.reduce<Record<string, number>>((acc, t) => {
        acc[t.status] = (acc[t.status] ?? 0) + 1;
        return acc;
      }, {});
      const statusBits = Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ');
      ctx.display.write(`  Tasks     : ${tasks.length}${statusBits ? ` — ${statusBits}` : ''}\n`);
      ctx.display.write(`  Artifacts : ${artifacts.length} file${artifacts.length === 1 ? '' : 's'} written\n`);
      ctx.display.dim('  Details: /usage · /budget · /history · /tasks · /artifacts');
      return {};
    },
  };
}
