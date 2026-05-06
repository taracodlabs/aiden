/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/backends/docker.ts — Docker terminal backend.
 *
 * Phase 8 minimum: shells out to `docker run --rm -v ${cwd}:/workspace
 * -w /workspace IMAGE sh -c "<command>"`. Returns a clear error if the
 * docker daemon is not reachable — never crashes the agent.
 *
 * Phase 9 hardens: image build, network policies, resource limits,
 * volume management. Phase 8 just proves the route works.
 *
 * Hermes reference: hermes-agent/tools/environments/docker.py.
 */

import { spawn, spawnSync } from 'node:child_process';

import type {
  ShellExecArgs,
  ShellExecResult,
  LocalBackendCallbacks,
} from './local';

const DEFAULT_IMAGE = 'node:22-alpine';
const DEFAULT_TIMEOUT = 30_000;

export interface DockerBackendOptions {
  image?: string;
}

/** Probe docker availability. Used by tests to skip cleanly. */
export function isDockerAvailable(): boolean {
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 3000,
      stdio: 'pipe',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export async function dockerBackendExecute(
  args: ShellExecArgs,
  opts: DockerBackendOptions = {},
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
      backend: 'docker',
    };
  }

  if (!isDockerAvailable()) {
    return {
      exitCode: -1,
      stdout: '',
      stderr:
        'Docker daemon is not running or `docker` is not on PATH. Start Docker and retry, or set terminalBackend="local".',
      durationMs: 0,
      timedOut: false,
      backend: 'docker',
    };
  }

  const image = opts.image ?? DEFAULT_IMAGE;
  const cwd = args.cwd ?? process.cwd();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT;
  const capture = args.captureOutput ?? true;
  const start = Date.now();

  const dockerArgs = [
    'run',
    '--rm',
    '-v',
    `${cwd}:/workspace`,
    '-w',
    '/workspace',
    image,
    'sh',
    '-c',
    command,
  ];

  return new Promise<ShellExecResult>((resolve) => {
    const child = spawn('docker', dockerArgs, {
      env: { ...process.env, ...(args.env ?? {}) },
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
        backend: 'docker',
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
        backend: 'docker',
      });
    });
  });
}
