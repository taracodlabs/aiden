/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/tools.ts — Phase 14b + v4.11 toolset grouping
 *
 * Subcommands:
 *   /tools                 — show active profile + loaded tool count
 *                            grouped by toolset (visibility marker
 *                            per group reflects the filter)
 *   /tools list            — list every built-in profile + its
 *                            toolset membership
 *   /tools <profile>       — switch the in-config profile (session
 *                            only, requires restart to take effect)
 *   /tools <profile> --global
 *                          — same, persisted to config.yaml
 *
 * Profile switching does NOT hot-swap the live AidenAgent's tool
 * catalog because `this.tools` is captured at construction time for
 * prefix-cache stability. The slash command writes config and
 * prints a restart hint — the audit-locked invariant ("profile
 * stable for session") is preserved.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import {
  BUILT_IN_PROFILES,
  PROFILE_NAMES,
  parseProfileName,
  resolveBootProfile,
  type ToolProfileName,
} from '../../../core/v4/toolProfiles';

export const tools: SlashCommand = {
  name: 'tools',
  description: 'Inspect or switch the active tool profile (minimal|standard|full).',
  category: 'system',
  icon: '🛠',
  handler: async (ctx: SlashCommandContext) => {
    if (!ctx.toolRegistry) {
      ctx.display.warn('Tool registry not wired in this context.');
      return {};
    }
    const sub = (ctx.args[0] ?? '').toLowerCase();

    // /tools list — describe every built-in profile.
    if (sub === 'list') {
      ctx.display.info('Available tool profiles:');
      for (const name of PROFILE_NAMES) {
        const def = BUILT_IN_PROFILES[name];
        const ts  = def.toolsets === null
          ? '(all toolsets)'
          : `[${def.toolsets.join(', ')}]`;
        ctx.display.write(`  • ${name} — ${def.description}\n    ${ts}\n`);
      }
      return {};
    }

    // /tools <profile> [--global] — switch profile.
    const maybeProfile = parseProfileName(sub);
    if (maybeProfile) {
      return await switchProfile(ctx, maybeProfile);
    }

    // Unknown arg.
    if (sub !== '') {
      ctx.display.warn(
        `Unknown subcommand '${sub}'. Try /tools, /tools list, or /tools <${PROFILE_NAMES.join('|')}>.`,
      );
      return {};
    }

    // /tools (no args) — describe current profile + grouped catalog.
    return showCurrentProfile(ctx);
  },
};

async function switchProfile(
  ctx:     SlashCommandContext,
  profile: ToolProfileName,
): Promise<Record<string, never>> {
  if (!ctx.config) {
    ctx.display.warn('Config manager not wired — cannot switch profile.');
    return {};
  }
  const isGlobal = ctx.args.includes('--global');
  ctx.config.set('agent.tool_profile', profile);
  if (isGlobal) {
    try {
      await ctx.config.save();
      ctx.display.success(
        `Tool profile set to '${profile}' (persisted to config.yaml).`,
      );
    } catch (err) {
      ctx.display.printError(
        `Set profile to '${profile}' but save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  } else {
    ctx.display.success(
      `Tool profile set to '${profile}' (this session only — add --global to persist).`,
    );
  }
  ctx.display.dim(
    'Restart Aiden for the new profile to take effect — the live agent\'s tool catalog is locked at boot for prefix-cache stability.',
  );
  return {};
}

function showCurrentProfile(ctx: SlashCommandContext): Record<string, never> {
  // Re-resolve to show the user EXACTLY what `aidenCLI.buildAgentRuntime`
  // would pick on the next boot (env > config > 'standard' default).
  const resolved = resolveBootProfile(
    process.env.AIDEN_TOOL_PROFILE,
    ctx.config?.getValue<string>('agent.tool_profile'),
    ctx.config?.getValue<string[]>('agent.tool_profile_toolsets'),
  );
  const filter = resolved.toolsets;

  // Group LIVE registry by toolset.
  const groups = new Map<string, string[]>();
  for (const name of ctx.toolRegistry!.list()) {
    const handler = ctx.toolRegistry!.get(name);
    const toolset = handler?.toolset ?? 'misc';
    const arr = groups.get(toolset) ?? [];
    arr.push(name);
    groups.set(toolset, arr);
  }
  const allCount = ctx.toolRegistry!.list().length;
  const visibleCount = filter === undefined
    ? allCount
    : [...groups.entries()]
        .filter(([ts]) => filter.includes(ts))
        .reduce((acc, [, names]) => acc + names.length, 0);

  ctx.display.info(
    `Active profile: ${resolved.name} (${resolved.source}) — ${visibleCount}/${allCount} tools visible`,
  );
  if (filter !== undefined) {
    ctx.display.dim(`Toolsets: [${filter.join(', ')}]`);
  } else {
    ctx.display.dim('Toolsets: (all — no filter)');
  }

  // Render grouped catalog with a visibility marker per group.
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [toolset, names] of sorted) {
    const visible = filter === undefined || filter.includes(toolset);
    const marker  = visible ? '✓' : '✗';
    ctx.display.info(`${marker} ${toolset} (${names.length})`);
    for (const n of names.sort()) {
      ctx.display.write(`  • ${n}\n`);
    }
  }
  return {};
}
