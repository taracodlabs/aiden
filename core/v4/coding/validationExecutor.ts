/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { killProcessTree, resolveCommand, spawnCommand } from '../util/spawnCommand';
import type { ExternalCodingValidationExecutor } from './verification';

const DEFAULT_IMAGE = 'node:22-bookworm-slim';
const OUTPUT_LIMIT = 1024 * 1024;

export class ExternalCodingValidationExecutorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalCodingValidationExecutorError';
  }
}

export interface DockerValidationInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly containerName: string;
  readonly environment: NodeJS.ProcessEnv;
}

function hostEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL']) {
    const value = source[key];
    if (value) output[key] = value;
  }
  return output;
}

/** Tokenize one direct executable plus arguments; shell grammar is rejected. */
export function parseExternalCodingValidationCommand(command: string): string[] {
  if (!command.trim() || /[\0\r\n;&|<>`]/u.test(command) || /\$\(/u.test(command)) {
    throw new ExternalCodingValidationExecutorError(
      'UNSAFE_VALIDATION_COMMAND',
      'External coding validation must be one direct command without shell operators',
    );
  }
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const character of command.trim()) {
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (token) { tokens.push(token); token = ''; }
    } else {
      token += character;
    }
  }
  if (escaping || quote) {
    throw new ExternalCodingValidationExecutorError('INVALID_VALIDATION_COMMAND', 'Validation command quoting is incomplete');
  }
  if (token) tokens.push(token);
  if (tokens.length === 0 || !/^[A-Za-z0-9_.+-]+(?:\.cmd|\.exe)?$/iu.test(tokens[0]!)) {
    throw new ExternalCodingValidationExecutorError('INVALID_VALIDATION_EXECUTABLE', 'Validation executable is not allowed');
  }
  return tokens;
}

/**
 * The repository is mounted read-only and copied into a container tmpfs before
 * execution. Validation therefore cannot mutate either user or candidate state.
 */
export function buildDockerValidationInvocation(input: {
  command: string;
  cwd: string;
  image?: string;
  dockerExecutable?: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
  nonce?: string;
}): DockerValidationInvocation {
  const [program, ...programArgs] = parseExternalCodingValidationCommand(input.command);
  const cwd = path.resolve(input.cwd);
  const nonce = input.nonce ?? randomBytes(6).toString('hex');
  const identity = createHash('sha256').update(`${cwd}\0${nonce}`).digest('hex').slice(0, 16);
  const containerName = `aiden-coding-validation-${identity}`;
  return {
    executable: input.dockerExecutable ?? 'docker',
    containerName,
    environment: hostEnvironment(input.sourceEnvironment ?? process.env),
    args: [
      'run', '--name', containerName, '--rm',
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '256',
      '--memory', '2g',
      '--cpus', '2',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=256m',
      '--tmpfs', '/workspace:rw,nosuid,nodev,exec,size=2g',
      '-v', `${cwd}:/source:ro`,
      '-w', '/workspace',
      input.image ?? DEFAULT_IMAGE,
      'sh', '-c', 'cp -a /source/. /workspace/ && exec "$@"',
      'aiden-validation', program!, ...programArgs,
    ],
  };
}

export interface DockerExternalCodingValidationExecutorOptions {
  readonly image?: string;
  readonly dockerExecutable?: string;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly available?: () => boolean;
}

export class DockerExternalCodingValidationExecutor implements ExternalCodingValidationExecutor {
  constructor(private readonly options: DockerExternalCodingValidationExecutorOptions = {}) {}

  available(): boolean {
    if (this.options.available) return this.options.available();
    const executable = this.options.dockerExecutable
      ?? resolveCommand('docker', { env: this.options.sourceEnvironment ?? process.env })?.path;
    if (!executable) return false;
    try {
      return spawnSync(executable, ['version', '--format', '{{.Server.Version}}'], {
        env: hostEnvironment(this.options.sourceEnvironment ?? process.env),
        windowsHide: true,
        timeout: 5_000,
        stdio: 'ignore',
      }).status === 0;
    } catch {
      return false;
    }
  }

  async execute(request: Parameters<ExternalCodingValidationExecutor['execute']>[0]) {
    if (!this.available()) {
      throw new ExternalCodingValidationExecutorError(
        'VALIDATION_SANDBOX_UNAVAILABLE',
        'Independent coding validation requires the configured Docker sandbox',
      );
    }
    const invocation = buildDockerValidationInvocation({
      command: request.command,
      cwd: request.cwd,
      image: this.options.image,
      dockerExecutable: this.options.dockerExecutable,
      sourceEnvironment: this.options.sourceEnvironment,
    });
    const { child } = spawnCommand(invocation.executable, invocation.args, {
      cwd: request.cwd,
      env: invocation.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let observedBytes = 0;
    let timedOut = false;
    let cancelled = false;
    const append = (current: string, chunk: Buffer | string): string => {
      const value = String(chunk);
      observedBytes += Buffer.byteLength(value, 'utf8');
      if (Buffer.byteLength(current, 'utf8') >= OUTPUT_LIMIT) return current;
      return `${current}${value}`.slice(0, OUTPUT_LIMIT);
    };
    const onStdout = (chunk: Buffer | string) => { stdout = append(stdout, chunk); };
    const onStderr = (chunk: Buffer | string) => { stderr = append(stderr, chunk); };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    const removeContainer = (): void => {
      try {
        execFileSync(invocation.executable, ['rm', '-f', invocation.containerName], {
          env: invocation.environment,
          windowsHide: true,
          timeout: 5_000,
          stdio: 'ignore',
        });
      } catch { /* already removed or daemon unavailable */ }
    };
    const stop = (reason: 'timeout' | 'cancel'): void => {
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      removeContainer();
      killProcessTree(child as ChildProcess, 'SIGKILL');
    };
    const onAbort = () => stop('cancel');
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const timer = setTimeout(() => stop('timeout'), Math.max(1, request.timeoutMs));
    timer.unref?.();
    try {
      const exitCode = await new Promise<number>((resolve) => {
        let settled = false;
        const finish = (value: number) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        child.once('error', () => finish(-1));
        child.once('close', (code) => finish(code ?? -1));
      });
      if (observedBytes > OUTPUT_LIMIT) {
        stderr = `${stderr}\n[output truncated after ${OUTPUT_LIMIT} bytes]`.trim();
      }
      return { exitCode, stdout, stderr, timedOut, cancelled };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      if (timedOut || cancelled) removeContainer();
    }
  }
}
