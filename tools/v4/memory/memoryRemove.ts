/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/memory/memoryRemove.ts — `memory_remove` wrapper.
 *
 * Delete an entry from MEMORY.md or USER.md by substring match.
 * Returns `verified: true` only after the post-write read confirms
 * the text is gone from the file.
 *
 * Status: PHASE 9.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const memoryRemoveTool: ToolHandler = {
  schema: {
    name: 'memory_remove',
    description:
      'Remove an entry from MEMORY.md or USER.md by substring match. Returns verified=true only after the change is confirmed on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['memory', 'user'],
          description: 'Which file to modify.',
        },
        text: { type: 'string', description: 'Substring of the entry to remove.' },
      },
      required: ['file', 'text'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'memory',
  async execute(args, ctx) {
    if (!ctx.memoryGuard) {
      return { success: false, error: 'memory guard not configured' };
    }
    const file = args.file === 'user' ? 'user' : 'memory';
    const text = String(args.text ?? '');
    const r = await ctx.memoryGuard.guardedRemove(file, text);
    return {
      success: r.ok,
      verified: r.verified,
      error: r.ok ? undefined : r.reason,
      file,
      fileLength: r.fileLength,
    };
  },
};
