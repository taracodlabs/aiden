/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/filePatch.ts — `file_patch` wrapper.
 *
 * String-replacement patch. Reads the file, replaces the literal
 * `find` string with `replace`, writes back. Fails cleanly when
 * `find` does not appear in the file. v3 has no equivalent — this
 * is a v4-native tool modeled after Hermes's `str_replace_editor`.
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { expandPath, isProtectedPath } from '../utils/paths';

export const filePatchTool: ToolHandler = {
  schema: {
    name: 'file_patch',
    description:
      "Replace a literal string in a file. Fails if `find` does not appear. Use `replace_all=true` to replace every occurrence; otherwise the find string must be unique.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to patch.' },
        find: { type: 'string', description: 'Literal string to find.' },
        replace: { type: 'string', description: 'Replacement text.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence (default false — must be unique).',
        },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'files',
  async execute(args, ctx) {
    const raw = String(args.path ?? args.file ?? '').trim();
    if (!raw) return { success: false, error: 'No path provided' };
    if (isProtectedPath(raw)) {
      return { success: false, error: 'Access denied: protected path' };
    }
    const find = typeof args.find === 'string' ? args.find : '';
    const replace = typeof args.replace === 'string' ? args.replace : '';
    if (!find) return { success: false, error: 'Empty find string' };
    const replaceAll = args.replace_all === true;
    const resolved = expandPath(raw, ctx.cwd);

    try {
      const original = await fs.readFile(resolved, 'utf-8');
      const occurrences = original.split(find).length - 1;
      if (occurrences === 0) {
        return {
          success: false,
          error: `find string not found in ${resolved}`,
          path: resolved,
        };
      }
      if (occurrences > 1 && !replaceAll) {
        return {
          success: false,
          error: `find string is not unique (${occurrences} occurrences); set replace_all=true to replace every match`,
          path: resolved,
        };
      }
      const next = replaceAll
        ? original.split(find).join(replace)
        : original.replace(find, replace);
      await fs.writeFile(resolved, next, 'utf-8');
      return {
        success: true,
        path: resolved,
        replacements: replaceAll ? occurrences : 1,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, path: resolved };
    }
  },
};
