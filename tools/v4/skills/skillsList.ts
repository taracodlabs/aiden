/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/skills/skillsList.ts — `skills_list` tool.
 *
 * Progressive-disclosure level 0: agent sees name + description for
 * every installed skill (~3k tokens for 75 bundled skills). The
 * agent then decides whether to drill down via `skill_view`.
 *
 * Wraps `SkillLoader.list()` and decorates with the bundled
 * manifest's `userModified` flag (when available).
 *
 * Status: PHASE 10.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const skillsListTool: ToolHandler = {
  schema: {
    name: 'skills_list',
    description:
      'List every installed skill with name + description (progressive-disclosure level 0). Use this first to find a skill, then call skill_view to read it.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'skills',
  async execute(_args, ctx) {
    if (!ctx.skillLoader) {
      return {
        success: true,
        skills: [],
        note: 'No skill loader configured for this session.',
      };
    }
    const summaries = await ctx.skillLoader.list();
    if (ctx.skillManifest) {
      for (const s of summaries) {
        try {
          s.userModified = await ctx.skillManifest.isUserModified(s.name);
        } catch {
          s.userModified = undefined;
        }
      }
    }
    return {
      success: true,
      count: summaries.length,
      skills: summaries.map((s) => ({
        name: s.name,
        description: s.description,
        version: s.version,
        category: s.category,
        trustLevel: s.trustLevel,
        userModified: s.userModified ?? null,
      })),
    };
  },
};
