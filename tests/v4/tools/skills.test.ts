import { describe, it, expect } from 'vitest';

import { skillsListTool } from '../../../tools/v4/skills/skillsList';
import { makeLookupToolSchema } from '../../../tools/v4/skills/lookupToolSchema';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

const ctx: ToolContext = {
  cwd: process.cwd(),
  paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-test-root' }),
};

describe('skills tools', () => {
  it('1. skills_list returns an empty Phase-7 stub list with a forward-pointing note', async () => {
    expect(skillsListTool.schema.name).toBe('skills_list');
    expect(skillsListTool.toolset).toBe('skills');
    expect(skillsListTool.mutates).toBe(false);
    const result = (await skillsListTool.execute({}, ctx)) as {
      success: boolean;
      skills: unknown[];
      note: string;
    };
    expect(result.success).toBe(true);
    expect(result.skills).toEqual([]);
    expect(result.note).toMatch(/phase 9/i);
  });

  it('2. lookup_tool_schema returns the schema of a registered tool', async () => {
    const reg = new ToolRegistry();
    reg.register(skillsListTool);
    const lookup = makeLookupToolSchema(reg);
    reg.register(lookup);

    const result = (await lookup.execute({ toolName: 'skills_list' }, ctx)) as {
      success: boolean;
      schema: { name: string };
      category: string;
    };
    expect(result.success).toBe(true);
    expect(result.schema.name).toBe('skills_list');
    expect(result.category).toBe('read');
  });

  it('3. lookup_tool_schema returns availableTools list when name is unknown', async () => {
    const reg = new ToolRegistry();
    reg.register(skillsListTool);
    const lookup = makeLookupToolSchema(reg);
    reg.register(lookup);

    const result = (await lookup.execute({ toolName: 'nope' }, ctx)) as {
      success: boolean;
      error: string;
      availableTools: string[];
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not registered/);
    expect(result.availableTools).toContain('skills_list');
  });
});
