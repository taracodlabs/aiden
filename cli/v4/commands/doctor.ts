/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/doctor.ts — Aiden v4.0.0 (Phase 20.1)
 *
 * `/doctor` slash-command surface for the in-REPL health check.
 *
 * Phase 20 added the check functions and the `aiden doctor` shell
 * subcommand (`aidenCLI.ts` wires `runDoctorCli`), but never registered a
 * slash command — typing `/doctor` in the chat REPL hit the "Unknown
 * command" path. Phase 20.1 adds the slash entry that walks the same
 * `runDoctor` aggregator and renders rows through `display.*` so the
 * skin engine colours it correctly.
 */

import type { SlashCommand } from '../commandRegistry';
import { runDoctor } from '../doctor';

export const doctor: SlashCommand = {
  name: 'doctor',
  description: 'Run health checks: license, providers, npm update, paths, deps.',
  category: 'system',
  icon: '🩺',
  handler: async (ctx) => {
    if (!ctx.paths) {
      ctx.display.warn('Doctor cannot run before paths resolve.');
      return {};
    }
    ctx.display.info('Running diagnostic checks...');
    const report = await runDoctor({ paths: ctx.paths });

    for (const r of report.results) {
      const text = `${r.name}: ${r.message}`;
      if (r.passed) ctx.display.success(text);
      else ctx.display.printError(text, r.suggestion);
    }
    ctx.display.write('\n');
    if (report.passed) {
      ctx.display.success(`all ${report.results.length} checks passed in ${report.totalMs} ms`);
    } else {
      const failed = report.results.filter((r) => !r.passed).length;
      ctx.display.warn(
        `${failed} of ${report.results.length} checks failed in ${report.totalMs} ms`,
      );
    }
    return {};
  },
};
