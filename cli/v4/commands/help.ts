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
import { renderFramedPanel, type PanelRow } from '../display/framedPanel';
import { fitStartupLine } from '../startupDashboard';

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
  // v4.11 Slice B — revert the last turn from working context.
  undo: 'Session',
  // v4.11 Slice C — re-run the last prompt for a fresh response.
  retry: 'Session',

  // ── Configuration ── runtime knobs
  model: 'Configuration',
  providers: 'Configuration',
  personality: 'Configuration',
  skin: 'Configuration',
  // v4.9.0 Slice 1a — unified theme system (parallel to /skin).
  theme: 'Configuration',
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
  // v4.12 Slice 1a — /mcp read-only surfacing of connected MCP servers.
  mcp: 'System',
  tools: 'System',
  skills: 'System',
  quit: 'System',
  yolo: 'System',
  // v4.12.1 Pillar 2 — the autonomy dial (Observer | Assistant | Partner).
  autonomy: 'System',
  // v4.14 — one-command opt-in to Partner ("auto"), persisted across restarts.
  auto: 'System',
  // v4.14 — friendly trust-level viewer/switcher (safe | auto | observer).
  mode: 'System',
  // v4.12.1 Pillar 4 Slice 2a — type-next-while-busy.
  busy: 'System',
  queue: 'System',
  // v4.12.1 Pillar 4 Slice 2b — mid-turn redirect.
  redirect: 'System',
  usage: 'System',
  estimate: 'System',
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
  browser: 'System',
  budget: 'System',
  daemon: 'System',
  // v4.5 Phase 8b — contextual capability suggestions.
  suggestions: 'System',
  // v4.6 Phase 2M — opt-in keyword-based tool narrower.
  'planner-guard': 'System',
  // v4.6 Phase 3A — operator kill-switch for sub-agent spawning.
  'spawn-pause': 'System',
  // v4.6 Phase 3b — self-improvement loop operator surface.
  recovery: 'System',
  // v4.6 ONB1 slice 10 — new-user guided tour.
  walkthrough: 'System',
  // v4.9.1 amendment — REPL surfaces for memory + hooks (daemon already mapped).
  memory: 'System',
  hooks:  'System',
  // v4.9.3 Slice 1b — boot greeter management.
  greeter: 'System',
  // v4.12 /commands slice — /home (working dir) + /activity (inline roll-up).
  home: 'System',
  activity: 'System',

  // ── Authentication ──
  auth: 'Authentication',

  // ── Help ──
  help: 'Help',
};

export function subsectionFor(commandName: string): Subsection {
  return SUBSECTION_MAP[commandName] ?? 'System';
}

const DEFAULT_HELP_GROUPS: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  { title: 'Start working', commands: ['mode', 'skills', 'tools'] },
  { title: 'Models and setup', commands: ['model', 'doctor', 'auth'] },
  { title: 'Tasks and recovery', commands: ['status', 'queue', 'busy', 'retry'] },
  { title: 'Memory and skills', commands: ['memory', 'skills', 'history'] },
  { title: 'Integrations', commands: ['mcp', 'plugins', 'channel'] },
  { title: 'Settings and diagnostics', commands: ['providers', 'usage', 'setup'] },
];

function writeLines(ctx: SlashCommandContext, lines: readonly string[]): void {
  const columns = (ctx.display as typeof ctx.display & { terminalColumns?: () => number }).terminalColumns?.() ?? 80;
  const width = Math.max(1, columns - 2);
  ctx.display.write(lines.map((line) => fitStartupLine(line, width)).join('\n') + '\n');
}

function renderDefaultHelp(ctx: SlashCommandContext): void {
  const lines = ['Help', ''];
  for (const group of DEFAULT_HELP_GROUPS) {
    const commands = group.commands
      .map((name) => ctx.registry.get(name))
      .filter((command): command is SlashCommand => Boolean(command && !command.hidden));
    if (commands.length === 0) continue;
    lines.push(group.title);
    for (const command of commands) lines.push(`  /${command.name}  ${command.description}`);
    lines.push('');
  }
  lines.push('Use /help <command> for details · /help all for every command.');
  writeLines(ctx, lines);
}

function renderCommandDetail(ctx: SlashCommandContext, requested: string): void {
  const command = ctx.registry.get(requested);
  if (!command || command.hidden) {
    writeLines(ctx, [`Unknown command: /${requested}`, 'Use /help to browse available commands.']);
    return;
  }
  const aliases = (command.aliases ?? []).filter((alias) => alias !== command.name);
  writeLines(ctx, [
    `Help: /${command.name}`,
    command.description,
    `Usage: /${command.name}`,
    ...(aliases.length > 0 ? [`Aliases: ${aliases.map((alias) => `/${alias}`).join(', ')}`] : []),
    'Use /help all to browse every command.',
  ]);
}

export const help: SlashCommand = {
  name: 'help',
  description: 'List available slash commands.',
  category: 'system',
  icon: '?',
  aliases: ['h', '?'],
  handler: async (ctx: SlashCommandContext) => {
    const requested = (ctx.args[0] ?? '').trim().toLowerCase();
    if (requested && requested !== 'all') {
      renderCommandDetail(ctx, requested);
      return {};
    }
    if (!requested) {
      renderDefaultHelp(ctx);
      return {};
    }
    const all = ctx.registry.list();
    const system = all.filter((c) => c.category === 'system');
    const skill = all.filter((c) => c.category === 'skill');

    // Bucket by sub-section.
    const buckets = new Map<Subsection, SlashCommand[]>();
    for (const sec of SUBSECTION_ORDER) buckets.set(sec, []);
    for (const c of system) {
      buckets.get(subsectionFor(c.name))!.push(c);
    }

    // v4.8.0 Slice 4 — every section renders as an Aiden-native framed
    // panel: left orange accent bar, title + count subtitle, command
    // rows, footer hint always present. AIDEN_UI_ICONS still respected
    // for the inline glyph column. Sections stack vertically; one
    // blank line between them comes from the panel's trailing newline.
    const showIcons = process.env.AIDEN_UI_ICONS === '1';
    const toRows = (cmds: SlashCommand[]): PanelRow[] => cmds.map((c) => ({
      command:     `${showIcons ? `${c.icon ?? ' '} ` : ''}/${c.name}`,
      description: c.description,
    }));

    for (const sec of SUBSECTION_ORDER) {
      const cmds = buckets.get(sec)!;
      if (cmds.length === 0) continue;
      ctx.display.write(renderFramedPanel({
        title:    sec,
        subtitle: `${cmds.length} ${cmds.length === 1 ? 'command' : 'commands'}`,
        rows:     toRows(cmds),
        footer:   'type /<name> to run · /help for this list',
      }));
      ctx.display.write('\n');
    }

    if (skill.length > 0) {
      ctx.display.write(renderFramedPanel({
        title:    'Skills',
        subtitle: `${skill.length} ${skill.length === 1 ? 'command' : 'commands'}`,
        rows:     toRows(skill),
        footer:   'type /<name> to run · /skills list to browse installed skills',
      }));
    }
    return {};
  },
};
