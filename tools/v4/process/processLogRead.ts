/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/process/processLogRead.ts — `process_log_read` wrapper.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const processLogReadTool: ToolHandler = {
  schema: {
    name: 'process_log_read',
    description:
      'Read the recent log lines (stdout+stderr) of a background process. Default 100 lines.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id from process_spawn.' },
        lines: {
          type: 'number',
          description: 'How many trailing lines to return (default 100).',
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
    const lines = typeof args.lines === 'number' ? args.lines : 100;
    const handle = ctx.processes.get(id);
    if (!handle) return { success: false, error: `Unknown process id: ${id}` };
    const log = ctx.processes.readLog(id, lines);
    return { success: true, id, status: handle.status, lines: log };
  },
};
