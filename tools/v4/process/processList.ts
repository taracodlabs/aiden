/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/process/processList.ts — `process_list` wrapper.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const processListTool: ToolHandler = {
  schema: {
    name: 'process_list',
    description:
      'List background processes started by `process_spawn`. Shows id, pid, status, command, and exit code.',
    inputSchema: { type: 'object', properties: {} },
  },
  category: 'read',
  mutates: false,
  toolset: 'process',
  async execute(_args, ctx) {
    if (!ctx.processes) {
      return { success: false, error: 'process registry not configured' };
    }
    const handles = ctx.processes.list();
    return { success: true, count: handles.length, processes: handles };
  },
};
