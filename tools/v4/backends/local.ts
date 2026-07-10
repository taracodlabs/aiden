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

import { spawn, type ChildProcess } from 'node:child_process';
// v4.9.0 Slice 7 — propagate ExecutionContext into the child via env.
import { currentContext, spawnEnvWithContext, reportMissingContext } from '../../../core/v4/identity';
// v4.14.7 — reuse the ONE tree-killer (PM.1); never write a second.
import { killProcessTree } from '../../../core/v4/util/spawnCommand';

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
  /** Turn-scoped abort signal. On abort the child's whole process TREE is
   *  reaped (not just the direct child). Absent → the command runs to its
   *  natural end or the timeout. */
  signal?: AbortSignal;
  /** Test seam: override the tree-killer. Defaults to killProcessTree (PM.1). */
  killTree?: (child: ChildProcess, signal: NodeJS.Signals) => void;
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

  // The ONE tree-killer (PM.1) — a test may inject its own to assert the reap
  // without spawning a real process.
  const killTree = cb.killTree ?? ((c: ChildProcess, s: NodeJS.Signals) => killProcessTree(c, s));

  // Already interrupted before we spawn — never start the child.
  if (cb.signal?.aborted) {
    return {
      exitCode: -1, stdout: '', stderr: 'interrupted before start',
      durationMs: 0, timedOut: false, backend: 'local',
    };
  }

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
      // POSIX: `detached` makes the child its own process-group leader so
      // killProcessTree can reap the GROUP (`kill(-pid)`). Windows uses
      // `taskkill /t` and needs no group. Not unref'd — we still await it.
      : spawn('bash', ['-lc', command], {
          cwd: args.cwd,
          env: { ...baseEnv, ...(args.env ?? {}) },
          detached: true,
        });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (r: ShellExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cb.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    // A turn interrupt reaps the whole TREE, not just the direct child:
    // `child.kill()` alone orphans grandchildren (a `powershell → nmap` subtree
    // — the PM.1 "Firefox lesson"). killProcessTree does `taskkill /t /f` on
    // Windows / a process-group kill on POSIX; then we resolve promptly as
    // interrupted so the turn settles instead of hanging on a dead child.
    const onAbort = (): void => {
      try { killTree(child, 'SIGKILL'); } catch { /* best-effort */ }
      finish({
        exitCode: -1, stdout, stderr: stderr || 'interrupted',
        durationMs: Date.now() - start, timedOut: false, backend: 'local',
      });
    };
    cb.signal?.addEventListener('abort', onAbort, { once: true });

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

    // Timeout: same grace→force escalation, now TREE-aware — `child.kill()` has
    // the identical orphan defect on this path.
    timer = setTimeout(() => {
      timedOut = true;
      try { killTree(child, 'SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { killTree(child, 'SIGKILL'); } catch { /* ignore */ }
      }, 2000);
    }, timeoutMs);

    child.on('error', (err) => {
      finish({
        exitCode: -1,
        stdout,
        stderr: stderr || err.message,
        durationMs: Date.now() - start,
        timedOut,
        backend: 'local',
      });
    });

    child.on('close', (code) => {
      finish({
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
