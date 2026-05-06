/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/skills.ts — Phase 14b
 *
 * `/skills [list|view <name>|install <id>]` — minimal CLI surface to
 * Phase 10's SkillLoader + Phase 14a's SkillsHub. Default subcommand: list.
 */
import type { SlashCommand } from '../commandRegistry';

export const skills: SlashCommand = {
  name: 'skills',
  description: 'List, view, or install skills.',
  category: 'system',
  icon: '⚡',
  handler: async (ctx) => {
    const sub = (ctx.args[0] ?? 'list').toLowerCase();
    if (sub === 'list') {
      if (!ctx.skillLoader) {
        ctx.display.warn('Skill loader not wired.');
        return {};
      }
      const skills = await ctx.skillLoader.list();
      if (skills.length === 0) {
        ctx.display.dim('(no skills installed)');
        return {};
      }
      ctx.display.info(`Installed skills (${skills.length}):`);
      for (const s of skills) {
        ctx.display.write(`  • ${s.name.padEnd(24)} ${s.description ?? ''}\n`);
      }
      return {};
    }
    if (sub === 'view') {
      const name = ctx.args[1];
      if (!name) {
        ctx.display.printError('Usage: /skills view <name>');
        return {};
      }
      if (!ctx.skillLoader) {
        ctx.display.warn('Skill loader not wired.');
        return {};
      }
      const parsed = await ctx.skillLoader.load(name);
      if (!parsed) {
        ctx.display.printError(`Skill '${name}' not found.`);
        return {};
      }
      ctx.display.info(`${parsed.frontmatter.name} v${parsed.frontmatter.version}`);
      ctx.display.dim(parsed.frontmatter.description ?? '(no description)');
      ctx.display.line(40);
      ctx.display.write(parsed.body.slice(0, 1200));
      if (parsed.body.length > 1200) ctx.display.dim('… (truncated)');
      ctx.display.write('\n');
      return {};
    }
    if (sub === 'install') {
      const id = ctx.args.slice(1).join(' ').trim();
      if (!id) {
        ctx.display.printError('Usage: /skills install <identifier>');
        return {};
      }
      if (!ctx.skillsHub) {
        ctx.display.warn('SkillsHub not wired.');
        return {};
      }
      const spinner = ctx.display.startSpinner(`Installing ${id}…`);
      const res = await ctx.skillsHub.install(id);
      spinner.stop();
      if (res.ok) {
        ctx.display.success(`Installed at ${res.installPath ?? '(?)'}`);
      } else {
        ctx.display.printError(`Install failed: ${res.reason ?? 'unknown'}`);
      }
      return {};
    }
    ctx.display.printError(
      `Unknown subcommand: ${sub}`,
      'Try: /skills list | view <name> | install <id>',
    );
    return {};
  },
};
