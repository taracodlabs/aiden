/**
 * tools/v4/skills/skillsList.ts — `skills_list` Phase-7 stub.
 *
 * Phase 9 (skill loader + Skill Hub) will return the real list of
 * available skills with their `triggers` so the agent can decide
 * whether to invoke one. For Phase 7 we return a placeholder
 * payload so the tool registers and the LLM gets a stable shape
 * to learn against.
 *
 * Status: PHASE 7 STUB.  TODO(phase-9): wire to `core/v4/skillsHub.ts`.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const skillsListTool: ToolHandler = {
  schema: {
    name: 'skills_list',
    description:
      'List available skills (named workflows the agent can invoke). Returns skill names, triggers, and short descriptions.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'skills',
  async execute() {
    return {
      success: true,
      skills: [],
      note: 'Skill discovery lands in Phase 9 (Skill Hub + skill loader). The empty list keeps the schema stable so the model can rely on the shape.',
    };
  },
};
