/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/skills/skillView.ts — `skill_view` tool.
 *
 * Progressive-disclosure level 1 + level 2:
 *
 *   level 1: name only           → return full SKILL.md
 *   level 2: name + path         → return that reference file
 *
 * Path traversal (`../`) is refused by SkillLoader.readSkillFile.
 *
 * Status: PHASE 10.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const skillViewTool: ToolHandler = {
  schema: {
    name: 'skill_view',
    description:
      'Read a skill in full (no path) or read a specific reference file inside the skill (with path). Progressive-disclosure level 1 / 2.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from skills_list.' },
        path: {
          type: 'string',
          description:
            'Optional: relative path to a reference file inside the skill (e.g., "templates/email.md").',
        },
      },
      required: ['name'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'skills',
  async execute(args, ctx) {
    if (!ctx.skillLoader) {
      return { success: false, error: 'No skill loader configured' };
    }
    const name = String(args.name ?? '').trim();
    if (!name) return { success: false, error: 'No skill name provided' };
    const relPath = typeof args.path === 'string' ? args.path : '';

    if (relPath) {
      try {
        const content = await ctx.skillLoader.readSkillFile(name, relPath);
        return {
          success: true,
          name,
          path: relPath,
          content,
          size: content.length,
        };
      } catch (e) {
        return {
          success: false,
          error: (e as Error).message,
          name,
          path: relPath,
        };
      }
    }

    const skill = await ctx.skillLoader.load(name);
    if (!skill) {
      return { success: false, error: `Skill not found: ${name}` };
    }
    // Phase 23.1: surface required_tools so the agent loop's skill-
    // enforcement guard can arm without re-parsing the SKILL.md body.
    // Absent/empty = no enforcement, no behavior change for legacy skills.
    const requiredToolsRaw = skill.frontmatter.required_tools;
    const requiredTools = Array.isArray(requiredToolsRaw)
      ? requiredToolsRaw
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim())
      : [];
    return {
      success: true,
      name: skill.frontmatter.name,
      description: skill.frontmatter.description,
      version: skill.frontmatter.version,
      category:
        skill.frontmatter.category ??
        skill.frontmatter.metadata?.aiden?.category,
      content: skill.rawText,
      filePath: skill.filePath,
      requiredTools,
    };
  },
};
