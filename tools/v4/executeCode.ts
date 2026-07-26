/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/executeCode.ts — `execute_code` Python sandbox.
 *
 * Phase 8 minimum: spawns `python -c "<code>"` in a subprocess,
 * captures stdout/stderr/exit, returns a structured result. No
 * package install, no persistent state between calls, no
 * programmatic tool RPC (that lands in Phase 11 with MCP). If
 * Python isn't on PATH the tool returns a clear error rather than
 * crashing the agent.
 *
 * more elaborate (dedicated container, IPython-style state). v4
 * starts with the simplest thing that proves the loop.
 *
 * Status: PHASE 8.
 */

import { spawn, spawnSync } from 'node:child_process';

import type { ToolHandler } from '../../core/v4/toolRegistry';
import { capToolOutput, shellOutputHandle } from '../../core/v4/toolOutputCap';

const DEFAULT_TIMEOUT = 30_000;

let cachedPython: string | null | undefined;

/** Resolve a Python interpreter on PATH. Cached after first probe. */
function findPython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'print(1)'], { timeout: 3000, stdio: 'pipe' });
      if (r.status === 0) {
        cachedPython = c;
        return c;
      }
    } catch {
      /* try next */
    }
  }
  cachedPython = null;
  return null;
}

/** Reset the Python probe cache — exposed for tests. */
export function _resetPythonCache(): void {
  cachedPython = undefined;
}

export const executeCodeTool: ToolHandler = {
  schema: {
    name: 'execute_code',
    description:
      'Execute a snippet of Python code in a sandboxed subprocess. Use for data analysis, math, JSON munging, or quick transformations. Each call starts fresh — no state persists between invocations.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source to execute.' },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in ms (default 30000).',
        },
      },
      required: ['code'],
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'execute',
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    return {
      tool: 'execute_code',
      args: { code: '[redacted]', timeoutMs: args.timeoutMs },
      riskTier: 'caution',
      sideEffects: [{ type: 'shell_command', command: '[python code]', cwd: process.cwd(), backend: 'local' }],
      detectedRisks: ['Code can change local state or access the network.'],
      summary: 'Would execute the supplied code in a local Python process.',
    };
  },
  async execute(args) {
    const code = String(args.code ?? '');
    if (!code.trim()) {
      return {
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        note: 'empty code — no-op',
      };
    }
    const python = findPython();
    if (!python) {
      return {
        success: false,
        error:
          'Python interpreter not found on PATH. Install Python 3 and retry.',
      };
    }
    const timeoutMs =
      typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT;

    return new Promise((resolve) => {
      const child = spawn(python, ['-c', code], { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 2000);
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: err.message,
          stdout,
          stderr,
          exitCode: -1,
          timedOut,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const exitCode = typeof code === 'number' ? code : -1;
        // v4.12 TOC.1 — cap output at the boundary (same helper as shell_exec).
        const outCap = capToolOutput(stdout);
        const errCap = capToolOutput(stderr);
        resolve({
          success: exitCode === 0 && !timedOut,
          stdout: outCap.text,
          stderr: errCap.text,
          exitCode,
          timedOut,
          ...(outCap.truncated || errCap.truncated
            ? shellOutputHandle(outCap.omittedChars + errCap.omittedChars)
            : {}),
        });
      });
    });
  },
};
