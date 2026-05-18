/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/recovery.ts — v4.6 Phase 3b.
 *
 * `/recovery list [limit]`        — top N recurring failure patterns
 * `/recovery show <signature>`    — details for one signature + reports
 * `/recovery clear <signature>`   — operator says "fixed; stop counting"
 *
 * Backed by the v7 `failure_signatures` + `recovery_reports` tables
 * via the `RecoveryStore` singleton (initialised at REPL/daemon/MCP
 * boot). All three sub-actions degrade cleanly when the store isn't
 * initialised — print a non-fatal error and return.
 */

import type { SlashCommand } from '../commandRegistry';
import { getRecoveryStore } from '../../../core/v4/selfimprovement/recoveryStore';

/** Format a wall-clock ms timestamp as a compact UTC label. */
function formatTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

/** Right-pad to width; truncate with ellipsis when too long. */
function pad(value: string | number, width: number): string {
  const s = String(value);
  if (s.length === width) return s;
  if (s.length < width) return s + ' '.repeat(width - s.length);
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

export const recovery: SlashCommand = {
  name: 'recovery',
  description: 'Inspect recurring failure patterns + recoveries (v4.6 Phase 3b).',
  category: 'system',
  icon: '🩹',
  handler: async (ctx) => {
    const action = (ctx.args[0] ?? 'list').toLowerCase();
    const store = getRecoveryStore();
    if (!store) {
      ctx.display.printError(
        'recovery: recovery store not initialised — daemon DB unavailable?',
      );
      return {};
    }

    if (action === 'list') {
      const limitArg = ctx.args[1];
      const parsed = limitArg !== undefined ? Number.parseInt(limitArg, 10) : NaN;
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
      const rows = store.listTopFailures(limit);
      if (rows.length === 0) {
        ctx.display.write('No recurring failures recorded yet.\n');
        ctx.display.dim(
          '  TCE writes failure signatures on classify; recoveries on failure→success transition.',
        );
        return {};
      }
      ctx.display.write(
        `${pad('signature', 50)}  ${pad('occur', 6)}  ${pad('recov', 6)}  last_strategy\n`,
      );
      for (const r of rows) {
        ctx.display.write(
          `${pad(r.signature, 50)}  ${pad(r.occurrences, 6)}  ${pad(r.recoveredCount, 6)}  ${r.lastRecoveryStrategy ?? '-'}\n`,
        );
      }
      ctx.display.write(`\n${rows.length} signature${rows.length === 1 ? '' : 's'} shown\n`);
      return {};
    }

    if (action === 'show') {
      const sig = ctx.args[1];
      if (!sig) {
        ctx.display.printError('Usage: /recovery show <signature>');
        return {};
      }
      const row = store.getBySignature(sig);
      if (!row) {
        ctx.display.printError(`recovery: signature not found: ${sig}`);
        return {};
      }
      ctx.display.write(`signature:        ${row.signature}\n`);
      ctx.display.write(`tool_name:        ${row.toolName}\n`);
      ctx.display.write(`failure_category: ${row.failureCategory}\n`);
      ctx.display.write(`occurrences:      ${row.occurrences}\n`);
      ctx.display.write(`recovered_count:  ${row.recoveredCount}\n`);
      ctx.display.write(`first_seen:       ${formatTs(row.firstSeenAt)}\n`);
      ctx.display.write(`last_seen:        ${formatTs(row.lastSeenAt)}\n`);
      const reports = store.listReportsForSignature(row.id, 20);
      if (reports.length === 0) {
        ctx.display.dim('  (no recovery reports yet for this signature)');
        return {};
      }
      ctx.display.write(`\nrecovery reports (${reports.length}, newest first):\n`);
      for (const r of reports) {
        ctx.display.write(`  [${formatTs(r.createdAt)}] strategy=${r.successfulStrategy}`);
        if (r.failedAttempts !== undefined) {
          ctx.display.write(` failed=${r.failedAttempts}`);
        }
        if (r.sessionId) ctx.display.write(` session=${r.sessionId}`);
        ctx.display.write('\n');
        if (r.notes) ctx.display.dim(`    ${r.notes}`);
        if (r.verification) ctx.display.dim(`    verified: ${r.verification}`);
      }
      return {};
    }

    if (action === 'clear') {
      const sig = ctx.args[1];
      if (!sig) {
        ctx.display.printError('Usage: /recovery clear <signature>');
        return {};
      }
      const ok = store.clearSignature(sig);
      if (ok) {
        ctx.display.write(`recovery: cleared signature ${sig}\n`);
      } else {
        ctx.display.printError(`recovery: signature not found: ${sig}`);
      }
      return {};
    }

    ctx.display.printError(
      'Usage: /recovery list [limit] | show <signature> | clear <signature>',
    );
    return {};
  },
};
