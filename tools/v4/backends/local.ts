/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/backends/local.ts — local terminal backend.
 *
 * Spawns a child process on the host. Cross-platform: PowerShell on
 * Windows, bash on POSIX. Streams stdout/stderr to the optional
 * `log` callback while collecting the full text for the return value.
 *
 * Phase 8 has no shell-injection guards — Phase 9's approval engine
 * sits in front of `shell_exec` and inspects the command before it
 * reaches this backend.
 *
 */

import { spawn } from 'node:child_process';
// v4.9.0 Slice 7 — propagate ExecutionContext into the child via env.
import { currentContext, spawnEnvWithContext, reportMissingContext } from '../../../core/v4/identity';

export interface ShellExecArgs {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  captureOutput?: boolean;
}

export interface ShellExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  backend: 'local' | 'docker';
}

const DEFAULT_TIMEOUT = 30_000;

export interface LocalBackendCallbacks {
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export async function localBackendExecute(
  args: ShellExecArgs,
  cb: LocalBackendCallbacks = {},
): Promise<ShellExecResult> {
  const command = args.command.trim();
  if (!command) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: 'empty command',
      durationMs: 0,
      timedOut: false,
      backend: 'local',
    };
  }

  const isWin = process.platform === 'win32';
  const start = Date.now();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT;
  const capture = args.captureOutput ?? true;

  return new Promise<ShellExecResult>((resolve) => {
    // v4.9.0 Slice 7 — when running inside a `runWithContext` frame,
    // stamp AIDEN_* env vars so the child process can reconstitute
    // the same daemon/incarnation/run/trace correlation chain via
    // `readContextFromEnv(process.env)`. Outside a context frame, the
    // env spread is unchanged.
    const ambient = currentContext();
    let baseEnv: NodeJS.ProcessEnv;
    if (ambient) {
      baseEnv = spawnEnvWithContext(ambient, process.env);
    } else {
      // v4.9.0 Slice 8 — report through the enforcement layer.
      reportMissingContext('subprocess', 'shellExec');
      baseEnv = process.env;
    }
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd: args.cwd,
          env: { ...baseEnv, ...(args.env ?? {}) },
        })
      : spawn('bash', ['-lc', command], {
          cwd: args.cwd,
          env: { ...baseEnv, ...(args.env ?? {}) },
        });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    if (capture) {
      child.stdout?.on('data', (b: Buffer) => {
        const s = b.toString();
        stdout += s;
        cb.log?.('info', s.slice(0, 200));
      });
      child.stderr?.on('data', (b: Buffer) => {
        const s = b.toString();
        stderr += s;
        cb.log?.('warn', s.slice(0, 200));
      });
    } else {
      child.stdout?.resume();
      child.stderr?.resume();
    }

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
        exitCode: -1,
        stdout,
        stderr: stderr || err.message,
        durationMs: Date.now() - start,
        timedOut,
        backend: 'local',
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === 'number' ? code : -1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
        backend: 'local',
      });
    });
  });
}
