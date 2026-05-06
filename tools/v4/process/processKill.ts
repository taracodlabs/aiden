/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/process/processKill.ts — `process_kill` wrapper.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const processKillTool: ToolHandler = {
  schema: {
    name: 'process_kill',
    description:
      'Terminate a background process. Sends SIGTERM by default; pass signal="SIGKILL" for the harder kill.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id from process_spawn.' },
        signal: {
          type: 'string',
          description: 'Signal name (default SIGTERM).',
        },
      },
      required: ['id'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'process',
  async execute(args, ctx) {
    if (!ctx.processes) {
      return { success: false, error: 'process registry not configured' };
    }
    const id = String(args.id ?? '').trim();
    if (!id) return { success: false, error: 'No id provided' };
    const signal = (args.signal as NodeJS.Signals) || 'SIGTERM';
    const ok = ctx.processes.kill(id, signal);
    if (!ok) {
      const handle = ctx.processes.get(id);
      if (!handle) return { success: false, error: `Unknown process id: ${id}` };
      return { success: false, error: `process not running (status: ${handle.status})` };
    }
    return { success: true, id, signal };
  },
};
