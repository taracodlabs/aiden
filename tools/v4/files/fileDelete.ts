/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileDelete.ts — `file_delete` wrapper.
 *
 * Deletes a file or (with `recursive=true`) a directory tree.
 * Refuses filesystem roots and protected paths. Phase 9's approval
 * engine wraps every call so the user OKs deletions before they
 * happen — for Phase 8 the deny-list is the only safeguard.
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { expandPath, isProtectedPath, isFilesystemRoot } from '../utils/paths';

export const fileDeleteTool: ToolHandler = {
  schema: {
    name: 'file_delete',
    description:
      'Delete a file. Pass recursive=true to delete a directory tree. Refuses filesystem roots and credential paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target path.' },
        recursive: {
          type: 'boolean',
          description: 'Delete a directory tree (default false).',
        },
      },
      required: ['path'],
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
    const resolved = expandPath(raw, ctx.cwd);
    if (isFilesystemRoot(resolved)) {
      return { success: false, error: 'Refusing to delete filesystem root' };
    }
    const recursive = args.recursive === true;
    try {
      await fs.rm(resolved, { recursive, force: false });
      return { success: true, path: resolved };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, path: resolved };
    }
  },
};
