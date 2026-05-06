/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/skillCommandHandler.ts — Aiden v4.0.0 (Phase 14c)
 *
 * Skill slash command activation. When the user types `/<skill-name>` (or
 * a `cmd:<alias>` registered by the skill's frontmatter), the handler
 * queues the skill body as a system-prompt insert for the next turn.
 *
 * The activation pattern (system message at the head of the next turn)
 * was chosen over tool-dispatch because it keeps the existing executor
 * untouched and lets the skill teach the LLM how to handle whatever the
 * user types next.
 */

import type {
  SlashCommand,
  SlashCommandHandler,
  ChatSessionLike,
} from '../commandRegistry';
import type { ParsedSkill } from '../../../core/v4/skillSpec';

/** Optional extension that ChatSession implements. Tests stub a noop. */
interface SessionWithQueue extends ChatSessionLike {
  queueSystemPrompt?(content: string): void;
}

/** Build the system-prompt insert text for a skill. */
export function buildSkillInsert(skill: ParsedSkill): string {
  return `## Skill: ${skill.frontmatter.name}\n\n${skill.body.trim()}\n`;
}

export function createSkillCommandHandler(skill: ParsedSkill): SlashCommandHandler {
  return async (ctx) => {
    const session = ctx.session as SessionWithQueue | undefined;
    if (!session) {
      ctx.display.warn(
        `No active chat session — skill '${skill.frontmatter.name}' was not activated.`,
      );
      return {};
    }
    const insert = buildSkillInsert(skill);
    if (typeof session.queueSystemPrompt === 'function') {
      session.queueSystemPrompt(insert);
      ctx.display.info(`Activated skill: ${skill.frontmatter.name}`);
    } else {
      ctx.display.warn(
        `Session does not support skill activation; '${skill.frontmatter.name}' was skipped.`,
      );
    }
    return {};
  };
}

/** Convert a skill into a fully-built SlashCommand entry. */
export function buildSkillSlashCommand(
  name: string,
  skill: ParsedSkill,
): SlashCommand {
  return {
    name,
    description: skill.frontmatter.description,
    category: 'skill',
    icon: '⚡',
    handler: createSkillCommandHandler(skill),
  };
}
