/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/memory/memoryReplace.ts — `memory_replace` wrapper.
 *
 * Substring-matched replace. Returns `verified: true` only after the
 * post-write read confirms the new text is present and the old text
 * is absent.
 *
 * Status: PHASE 9.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const memoryReplaceTool: ToolHandler = {
  schema: {
    name: 'memory_replace',
    description:
      'Replace one entry in MEMORY.md or USER.md with new text. Substring match — fails if old_text is ambiguous. Returns verified=true only after the change is confirmed on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['memory', 'user'],
          description: 'Which file to modify.',
        },
        old_text: { type: 'string', description: 'Substring of the entry to replace.' },
        new_text: { type: 'string', description: 'Replacement entry.' },
      },
      required: ['file', 'old_text', 'new_text'],
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
    const oldText = String(args.old_text ?? args.oldText ?? '');
    const newText = String(args.new_text ?? args.newText ?? '');
    const r = await ctx.memoryGuard.guardedReplace(file, oldText, newText);
    return {
      success: r.ok,
      verified: r.verified,
      error: r.ok ? undefined : r.reason,
      file,
      fileLength: r.fileLength,
    };
  },
};
