/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/help.ts — Phase 22 Group B Task 2.
 *
 * Lists every visible slash command, grouped by sub-section under the
 * existing 'system' / 'skill' top-level categories. Sub-section headers
 * follow the `── Section ──` rule pattern.
 *
 * Sub-section assignment lives in `SUBSECTION_MAP` rather than on each
 * SlashCommand object — keeps the change to a single file. Commands
 * not in the map fall through to the default "System" bucket so new
 * commands surface predictably until they're slotted intentionally.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';

/**
 * Order matters: sections render in this order. Commands within a
 * section render in registration (alphabetical via registry.list)
 * order. Names use canonical (no leading slash) form.
 */
export const SUBSECTION_ORDER = [
  'Session',
  'Configuration',
  'Identity',
  'System',
  'Authentication',
  'Help',
] as const;
export type Subsection = (typeof SUBSECTION_ORDER)[number];

/**
 * Command name → sub-section mapping. Any 'system'-category command
 * not listed here lands in the trailing "System" bucket.
 */
export const SUBSECTION_MAP: Readonly<Record<string, Subsection>> = {
  // ── Session ── conversation lifecycle
  clear: 'Session',
  compress: 'Session',
  save: 'Session',
  title: 'Session',

  // ── Configuration ── runtime knobs
  model: 'Configuration',
  providers: 'Configuration',
  personality: 'Configuration',
  skin: 'Configuration',
  streaming: 'Configuration',
  reasoning: 'Configuration',
  verbose: 'Configuration',
  'debug-prompt': 'Configuration',

  // ── Identity ── SOUL.md introspection
  identity: 'Identity',
  // Phase v4.1.2 alive-core: manual SOUL.md cache invalidation.
  'reload-soul': 'Identity',

  // ── System ── housekeeping & process control (default fallback)
  doctor: 'System',
  license: 'System',
  plugins: 'System',
  'reload-mcp': 'System',
  tools: 'System',
  skills: 'System',
  quit: 'System',
  yolo: 'System',
  usage: 'System',
  cron: 'System',
  setup: 'System',
  channel: 'System',
  // Phase v4.1-tier3.1 + tier3-essentials commands.
  voice: 'System',
  status: 'System',
  show: 'System',
  history: 'System',
  // Phase v4.1.2-update — npm self-update for the running install.
  update: 'System',
  // v4.5 Phase 8a — subsystem live-flip slash commands.
  sandbox: 'System',
  tce: 'System',
  'browser-depth': 'System',
  daemon: 'System',
  // v4.5 Phase 8b — contextual capability suggestions.
  suggestions: 'System',
  // v4.6 Phase 2M — opt-in keyword-based tool narrower.
  'planner-guard': 'System',
  // v4.6 Phase 3A — operator kill-switch for sub-agent spawning.
  'spawn-pause': 'System',
  // v4.6 Phase 3b — self-improvement loop operator surface.
  recovery: 'System',

  // ── Authentication ──
  auth: 'Authentication',

  // ── Help ──
  help: 'Help',
};

export function subsectionFor(commandName: string): Subsection {
  return SUBSECTION_MAP[commandName] ?? 'System';
}

export const help: SlashCommand = {
  name: 'help',
  description: 'List available slash commands.',
  category: 'system',
  icon: '?',
  aliases: ['h', '?'],
  handler: async (ctx: SlashCommandContext) => {
    const all = ctx.registry.list();
    const system = all.filter((c) => c.category === 'system');
    const skill = all.filter((c) => c.category === 'skill');

    // Bucket by sub-section.
    const buckets = new Map<Subsection, SlashCommand[]>();
    for (const sec of SUBSECTION_ORDER) buckets.set(sec, []);
    for (const c of system) {
      buckets.get(subsectionFor(c.name))!.push(c);
    }

    // Tier-3.1: gate icon column on AIDEN_UI_ICONS=1 (default OFF).
    const showIcons = process.env.AIDEN_UI_ICONS === '1';
    for (const sec of SUBSECTION_ORDER) {
      const cmds = buckets.get(sec)!;
      if (cmds.length === 0) continue;
      ctx.display.dim(`── ${sec} ──`);
      for (const c of cmds) {
        const prefix = showIcons ? `${c.icon ?? ' '} ` : '';
        ctx.display.write(`  ${prefix}/${c.name.padEnd(14)} ${c.description}\n`);
      }
      ctx.display.write('\n');
    }

    if (skill.length > 0) {
      ctx.display.dim('── Skills ──');
      for (const c of skill) {
        const prefix = showIcons ? '⚡ ' : '';
        ctx.display.write(`  ${prefix}/${c.name.padEnd(14)} ${c.description}\n`);
      }
    }
    return {};
  },
};
