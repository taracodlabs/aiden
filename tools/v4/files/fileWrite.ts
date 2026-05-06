/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileWrite.ts — `file_write` wrapper.
 *
 * Writes content to a file (creating parent dirs as needed).
 * Refuses to touch credential paths via `isProtectedPath`. Phase 9
 * adds the approval engine on top — for Phase 8, this is the only
 * gate.
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { expandPath, isProtectedPath } from '../utils/paths';

export const fileWriteTool: ToolHandler = {
  schema: {
    name: 'file_write',
    description:
      'Write text content to a file. Creates parent directories. Overwrites if the file already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target file path.' },
        content: { type: 'string', description: 'Text content to write.' },
      },
      required: ['path', 'content'],
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
    const content = typeof args.content === 'string' ? args.content : '';
    const resolved = expandPath(raw, ctx.cwd);
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      return {
        success: true,
        path: resolved,
        bytes: Buffer.byteLength(content, 'utf-8'),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, path: resolved };
    }
  },
};
