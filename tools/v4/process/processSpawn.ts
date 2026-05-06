/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/process/processSpawn.ts — `process_spawn` wrapper.
 *
 * Start a long-running background process tracked by the
 * ProcessRegistry. For one-shot synchronous commands, use
 * `shell_exec`.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

export const processSpawnTool: ToolHandler = {
  schema: {
    name: 'process_spawn',
    description:
      'Start a background process (dev server, build, watcher). Returns a process id you can poll, log-read, kill, or wait on. Use `shell_exec` for one-shot commands instead.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to spawn.' },
        cwd: { type: 'string', description: 'Working directory.' },
      },
      required: ['command'],
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'process',
  async execute(args, ctx) {
    if (!ctx.processes) {
      return { success: false, error: 'process registry not configured' };
    }
    const command = String(args.command ?? '').trim();
    if (!command) return { success: false, error: 'No command provided' };
    const cwd = typeof args.cwd === 'string' ? args.cwd : ctx.cwd;
    try {
      const handle = ctx.processes.spawn(command, { cwd });
      return {
        success: true,
        id: handle.id,
        pid: handle.pid,
        status: handle.status,
        startedAt: handle.startedAt,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  },
};
