/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileCopy.ts — `file_copy` wrapper.
 *
 * Copy a file or directory tree. Creates parent dirs at the
 * destination if missing.
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { expandPath, isProtectedPath } from '../utils/paths';

export const fileCopyTool: ToolHandler = {
  schema: {
    name: 'file_copy',
    description:
      'Copy a file or directory tree to a new location. Creates parent dirs at the destination.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path.' },
        to: { type: 'string', description: 'Destination path.' },
      },
      required: ['from', 'to'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'files',
  async execute(args, ctx) {
    const fromRaw = String(args.from ?? args.source ?? '').trim();
    const toRaw = String(args.to ?? args.dest ?? args.destination ?? '').trim();
    if (!fromRaw || !toRaw) {
      return { success: false, error: 'Both from and to required' };
    }
    if (isProtectedPath(fromRaw) || isProtectedPath(toRaw)) {
      return { success: false, error: 'Access denied: protected path' };
    }
    const from = expandPath(fromRaw, ctx.cwd);
    const to = expandPath(toRaw, ctx.cwd);
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.cp(from, to, { recursive: true });
      return { success: true, from, to };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, from, to };
    }
  },
};
