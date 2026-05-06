/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/skills/skillManage.ts — `skill_manage` tool.
 *
 * Mutating tool — gated through Phase 9's ApprovalEngine. Five
 * actions:
 *
 *   create     — write a new SKILL.md; rejects on duplicate name.
 *   edit       — overwrite an existing SKILL.md with new content.
 *   patch      — string find/replace inside an existing SKILL.md
 *                (reuses the Phase 8 file_patch semantics).
 *   delete     — remove the skill directory + manifest entry.
 *   write_file — write a reference file inside the skill dir.
 *
 * Mark every change as user-modified via the bundled manifest so
 * the next install pull won't silently overwrite.
 *
 * Status: PHASE 10.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { parseSkillContent } from '../../../core/v4/skillSpec';

type Action = 'create' | 'edit' | 'patch' | 'delete' | 'write_file';
const ACTIONS: readonly Action[] = [
  'create',
  'edit',
  'patch',
  'delete',
  'write_file',
];

export const skillManageTool: ToolHandler = {
  schema: {
    name: 'skill_manage',
    description:
      'Create, edit, patch, write reference files inside, or delete skills. Mutating — every action goes through the approval engine.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'edit', 'patch', 'delete', 'write_file'],
          description: 'Operation to perform.',
        },
        name: { type: 'string', description: 'Skill name.' },
        content: {
          type: 'string',
          description: 'For create/edit: full SKILL.md content.',
        },
        find: {
          type: 'string',
          description: 'For patch: literal string to find.',
        },
        replace: {
          type: 'string',
          description: 'For patch: replacement text.',
        },
        filePath: {
          type: 'string',
          description: 'For write_file: relative path inside skill dir.',
        },
        fileContent: {
          type: 'string',
          description: 'For write_file: content to write.',
        },
      },
      required: ['action', 'name'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'skills',
  async execute(args, ctx) {
    if (!ctx.skillLoader || !ctx.paths) {
      return { success: false, error: 'No skill loader configured' };
    }
    const action = String(args.action ?? '') as Action;
    if (!ACTIONS.includes(action)) {
      return { success: false, error: `Unknown action: ${action}` };
    }
    const name = String(args.name ?? '').trim();
    if (!name) return { success: false, error: 'No skill name provided' };
    if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
      return {
        success: false,
        error: `Invalid skill name: ${name} (allowed: a-z A-Z 0-9 _ -)`,
      };
    }

    const skillDir = path.join(ctx.paths.skillsDir, name);
    const skillFile = path.join(skillDir, 'SKILL.md');

    switch (action) {
      case 'create': {
        const content = String(args.content ?? '');
        if (!content.trim()) {
          return { success: false, error: 'Empty content for create' };
        }
        try {
          parseSkillContent(content, name); // validate frontmatter
        } catch (e) {
          return { success: false, error: (e as Error).message };
        }
        if (await exists(skillFile)) {
          return {
            success: false,
            error: `Skill "${name}" already exists. Use action="edit" to overwrite.`,
          };
        }
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(skillFile, content, 'utf-8');
        await ctx.skillManifest?.markUserModified(name);
        return { success: true, action, name, filePath: skillFile };
      }

      case 'edit': {
        const content = String(args.content ?? '');
        if (!content.trim()) {
          return { success: false, error: 'Empty content for edit' };
        }
        try {
          parseSkillContent(content, name);
        } catch (e) {
          return { success: false, error: (e as Error).message };
        }
        if (!(await exists(skillFile))) {
          return {
            success: false,
            error: `Skill "${name}" does not exist. Use action="create" first.`,
          };
        }
        await fs.writeFile(skillFile, content, 'utf-8');
        await ctx.skillManifest?.markUserModified(name);
        return { success: true, action, name, filePath: skillFile };
      }

      case 'patch': {
        const find = typeof args.find === 'string' ? args.find : '';
        const replace = typeof args.replace === 'string' ? args.replace : '';
        if (!find) {
          return { success: false, error: 'Empty find string for patch' };
        }
        if (!(await exists(skillFile))) {
          return { success: false, error: `Skill "${name}" does not exist.` };
        }
        const original = await fs.readFile(skillFile, 'utf-8');
        const occurrences = original.split(find).length - 1;
        if (occurrences === 0) {
          return { success: false, error: `find string not found in ${name}/SKILL.md` };
        }
        if (occurrences > 1) {
          return {
            success: false,
            error: `find string is not unique (${occurrences} occurrences) — make it more specific`,
          };
        }
        const next = original.replace(find, replace);
        await fs.writeFile(skillFile, next, 'utf-8');
        await ctx.skillManifest?.markUserModified(name);
        return { success: true, action, name, replacements: 1 };
      }

      case 'delete': {
        if (!(await exists(skillDir))) {
          return { success: false, error: `Skill "${name}" does not exist.` };
        }
        await fs.rm(skillDir, { recursive: true, force: true });
        await ctx.skillManifest?.remove(name);
        return { success: true, action, name };
      }

      case 'write_file': {
        const filePath = String(args.filePath ?? '').trim();
        const fileContent = String(args.fileContent ?? '');
        if (!filePath) {
          return { success: false, error: 'No filePath for write_file' };
        }
        if (filePath.includes('..')) {
          return { success: false, error: 'Path traversal refused' };
        }
        if (!(await exists(skillDir))) {
          await fs.mkdir(skillDir, { recursive: true });
        }
        const target = path.resolve(skillDir, filePath);
        const resolvedDir = path.resolve(skillDir);
        if (
          target !== resolvedDir &&
          !target.startsWith(resolvedDir + path.sep)
        ) {
          return { success: false, error: 'Path traversal refused' };
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, fileContent, 'utf-8');
        await ctx.skillManifest?.markUserModified(name);
        return { success: true, action, name, filePath: target };
      }
    }
  },
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
