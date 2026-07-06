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
import {
  renderHealthBox,
  runDoctor,
  resolveSetupInputs,
  setupResults,
  subsystemHealthResults,
  skillOutcomeResults,
  sessionCounterResults,
} from '../doctor';

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
    // v4.14.x — Setup group with LIVE runtime state: the session's active
    // model, the approval engine's mode, and the live tool registry. Anything
    // a live source doesn't provide falls back to saved config (labelled).
    try {
      const setup = await resolveSetupInputs({
        paths:          ctx.paths,
        config:         ctx.config,
        session:        ctx.session,
        approvalEngine: ctx.approvalEngine,
        toolRegistry:   ctx.toolRegistry,
      });
      report.results.push(...setupResults(setup));
    } catch { /* informational group — never fail /doctor */ }
    // v4.1.3-essentials doctor-polish: pull in-process subsystem
    // health + skill-outcome data into the same report so they
    // render as additional grouped sections inside the health box,
    // not as disconnected blocks below it. `subsystemHealthResults`
    // / `skillOutcomeResults` return empty arrays when their
    // sources are unavailable so the grouped-renderer simply drops
    // those sections.
    if (ctx.agent) {
      const a = ctx.agent as unknown as {
        subsystemHealthRegistry?: import('../../../core/v4/subsystemHealth').SubsystemHealthRegistry;
        skillOutcomeTracker?:     import('../../../core/v4/skillOutcomeTracker').SkillOutcomeTracker;
      };
      report.results.push(...subsystemHealthResults(a.subsystemHealthRegistry));
      report.results.push(...skillOutcomeResults(a.skillOutcomeTracker));
      // v4.1.3-essentials doctor-polish: session-scoped counters
      // (skill enforcement / URL provenance / empty response) now
      // fold into the same report so they render as a "Session
      // counters" group INSIDE the box instead of as orphan
      // `display.write` lines below it. Previous code emitted them
      // as 3 separate `[bracket-prefix] key=N ...` lines after
      // renderHealthBox closed — visually disconnected.
      report.results.push(...sessionCounterResults(ctx.agent));
    }
    // v4.1.3-essentials doctor-polish: renderHealthBox now groups
    // results by section header with a top summary. Same renderer
    // is used by `aiden doctor` CLI path so both surfaces stay in
    // visual sync (Path-A unification).
    ctx.display.write(renderHealthBox(report, ctx.display) + '\n');
    return {};
  },
};
