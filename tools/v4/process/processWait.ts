/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/process/processWait.ts — `process_wait` wrapper.
 *
 * Block until a background process exits, with optional timeout.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const processWaitTool: ToolHandler = {
  schema: {
    name: 'process_wait',
    description:
      'Wait until a background process exits. Pass timeoutMs to bound the wait — without a timeout, this blocks indefinitely.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id from process_spawn.' },
        timeoutMs: {
          type: 'number',
          description: 'Maximum wait in ms.',
        },
      },
      required: ['id'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'process',
  async execute(args, ctx) {
    if (!ctx.processes) {
      return { success: false, error: 'process registry not configured' };
    }
    const id = String(args.id ?? '').trim();
    if (!id) return { success: false, error: 'No id provided' };
    const timeoutMs =
      typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
    try {
      const handle = await ctx.processes.waitFor(id, timeoutMs);
      return { success: true, ...handle };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  },
};
