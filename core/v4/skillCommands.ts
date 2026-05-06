/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillCommands.ts — Aiden v4.0.0
 *
 * Maps slash-command names to skills. A skill names its slash
 * commands via `metadata.aiden.tags` entries that start with `cmd:`
 * (e.g. `tags: [cmd:trading-alert, india]`). The CLI dispatcher
 * (Phase 14) calls `execute(name)` which returns the skill plus a
 * pre-formatted system-prompt insert.
 *
 * Phase 10 ships the resolver + executor. Slash-command surfacing
 * to the CLI itself lands in Phase 14.
 *
 * Status: PHASE 10.
 */

import type { ParsedSkill } from './skillSpec';
import type { SkillLoader } from './skillLoader';

export interface SkillCommandResult {
  skill: ParsedSkill;
  systemPromptInsert: string;
}

export class SkillCommands {
  constructor(private readonly loader: SkillLoader) {}

  /** Walk every loaded skill, collect any `cmd:<name>` tag into a
   *  command-name → skill map. Skill names themselves are also
   *  registered as commands (so `/nse-scanner` works without an
   *  explicit `cmd:` tag). */
  async buildCommandMap(): Promise<Map<string, ParsedSkill>> {
    const map = new Map<string, ParsedSkill>();
    const skills = await this.loader.loadAll();
    for (const skill of skills) {
      map.set(skill.frontmatter.name, skill);
      const tags = normaliseTags(skill);
      for (const tag of tags) {
        const m = tag.match(/^cmd:(.+)$/i);
        if (m && m[1]) {
          map.set(m[1].trim(), skill);
        }
      }
    }
    return map;
  }

  async execute(commandName: string): Promise<SkillCommandResult | null> {
    const map = await this.buildCommandMap();
    const skill = map.get(commandName);
    if (!skill) return null;
    return {
      skill,
      systemPromptInsert: `\n## Skill: ${skill.frontmatter.name}\n\n${skill.body.trim()}\n`,
    };
  }
}

function normaliseTags(skill: ParsedSkill): string[] {
  const top = skill.frontmatter.tags;
  const inner = skill.frontmatter.metadata?.aiden?.tags;
  const arr: string[] = [];
  if (Array.isArray(top)) arr.push(...top);
  else if (typeof top === 'string') arr.push(...top.split(/[,\s]+/).filter(Boolean));
  if (Array.isArray(inner)) arr.push(...inner);
  return arr.map((t) => String(t).trim()).filter(Boolean);
}
