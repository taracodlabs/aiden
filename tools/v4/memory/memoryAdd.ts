/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/memory/memoryAdd.ts — `memory_add` wrapper.
 *
 * Append an entry to MEMORY.md or USER.md. Calls through MemoryGuard
 * so the result includes `verified: true` only after the post-write
 * read confirms the content landed on disk. Phase 12 HonestyEnforcement
 * uses that flag to catch fabricated "I remembered X" claims.
 *
 * Status: PHASE 9.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const memoryAddTool: ToolHandler = {
  schema: {
    name: 'memory_add',
    description:
      'Append a new entry to MEMORY.md (agent environment notes) or USER.md (user preferences). Returns verified=true only after the change is confirmed on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['memory', 'user'],
          description: 'Which file to append to.',
        },
        content: { type: 'string', description: 'New entry to add.' },
      },
      required: ['file', 'content'],
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
    const content = String(args.content ?? '');
    const r = await ctx.memoryGuard.guardedAdd(file, content);
    return {
      success: r.ok,
      verified: r.verified,
      error: r.ok ? undefined : r.reason,
      file,
      fileLength: r.fileLength,
    };
  },
};
