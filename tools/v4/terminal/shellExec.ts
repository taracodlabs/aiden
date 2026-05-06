/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/terminal/shellExec.ts — `shell_exec` wrapper.
 *
 * Routes a shell command to either the local backend (PowerShell on
 * Windows, bash on POSIX) or the Docker backend, based on
 * `ctx.terminalBackend`. Phase 8 has no shell-injection guards —
 * Phase 9's approval engine inspects every call before it lands here.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { localBackendExecute } from '../backends/local';
import { dockerBackendExecute } from '../backends/docker';

export const shellExecTool: ToolHandler = {
  schema: {
    name: 'shell_exec',
    description:
      'Execute a shell command. PowerShell on Windows, bash elsewhere. Use `cwd` to change the working dir; `timeoutMs` to bound runtime (default 30000).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute.' },
        cwd: { type: 'string', description: 'Working directory (optional).' },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in ms (default 30000).',
        },
        captureOutput: {
          type: 'boolean',
          description: 'Capture stdout/stderr (default true).',
        },
      },
      required: ['command'],
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'terminal',
  async execute(args, ctx) {
    const command = String(args.command ?? args.cmd ?? '').trim();
    if (!command) return { success: false, error: 'No command provided' };

    const shellArgs = {
      command,
      cwd: typeof args.cwd === 'string' ? args.cwd : ctx.cwd,
      timeoutMs:
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      captureOutput:
        typeof args.captureOutput === 'boolean'
          ? args.captureOutput
          : true,
    };

    const cb = ctx.log ? { log: ctx.log } : {};
    const backend = ctx.terminalBackend ?? 'local';
    const result =
      backend === 'docker'
        ? await dockerBackendExecute(shellArgs, { image: ctx.dockerImage }, cb)
        : await localBackendExecute(shellArgs, cb);

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      backend: result.backend,
    };
  },
};
