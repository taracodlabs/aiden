/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  CapabilityProtocolGuard,
  encodeCapabilityMessage,
  validateJsonValue,
  type CapabilityEvidenceClaimMessage,
  type CapabilityIdentity,
  type CapabilityManifest,
  type CapabilityProgressMessage,
  type JsonValue,
} from '../../../packages/capability-sdk/src';
import { killProcessTree, resolveCommand, spawnCommand } from '../util/spawnCommand';
import type { CapabilityBroker } from './broker';

export const DEFAULT_CAPABILITY_IMAGE = 'node:22.23.1-bookworm-slim';
const HOST_OUTPUT_HARD_LIMIT = 4 * 1024 * 1024;
const STDERR_HARD_LIMIT = 64 * 1024;
const MAX_PROTOCOL_MESSAGES = 1_024;
const CAPABILITY_HANDSHAKE_TIMEOUT_MS = 15_000;

export interface DockerCapabilityInvocation {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  containerName: string;
}

function dockerHostEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (source[key] !== undefined) result[key] = source[key];
  return result;
}

function safeContainerPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, '-').slice(0, 40);
}

export function buildDockerCapabilityInvocation(input: {
  manifest: CapabilityManifest;
  identity: CapabilityIdentity;
  invocationId: string;
  nonce: string;
  installPath: string;
  runtimePath: string;
  dockerExecutable?: string;
  image?: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
  now?: number;
}): DockerCapabilityInvocation {
  const runtimeSeconds = Math.max(
    2,
    Math.ceil(input.manifest.limits.runtimeMs / 1_000)
      + Math.ceil(CAPABILITY_HANDSHAKE_TIMEOUT_MS / 1_000),
  );
  const containerName = `aiden-cap-${safeContainerPart(input.invocationId)}-${randomBytes(3).toString('hex')}`;
  const environment = dockerHostEnvironment(input.sourceEnvironment ?? process.env);
  const identityB64 = Buffer.from(JSON.stringify(input.identity), 'utf8').toString('base64url');
  const expiresAt = (input.now ?? Date.now()) + input.manifest.limits.runtimeMs + 15_000;
  return {
    executable: input.dockerExecutable ?? 'docker',
    environment,
    containerName,
    args: [
      'run', '--rm', '-i', '--name', containerName,
      '--label', 'com.taracod.aiden.capability=true',
      '--label', `com.taracod.aiden.invocation=${input.invocationId}`,
      '--label', `com.taracod.aiden.expires-at=${expiresAt}`,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '16',
      '--memory', '128m', '--cpus', '0.5', '--ulimit', 'nofile=64:64',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=700',
      '--tmpfs', '/home/capability:rw,noexec,nosuid,nodev,size=4m,uid=65532,gid=65532,mode=700',
      '--user', '65532:65532',
      '-v', `${path.resolve(input.installPath)}:/capability:ro`,
      '-v', `${path.resolve(input.runtimePath)}:/aiden-host/containerRuntime.js:ro`,
      '-w', '/capability',
      '-e', 'HOME=/home/capability', '-e', 'TMPDIR=/tmp', '-e', 'NODE_ENV=production',
      '-e', `AIDEN_CAPABILITY_IDENTITY_B64=${identityB64}`,
      '-e', `AIDEN_CAPABILITY_INVOCATION_ID=${input.invocationId}`,
      '-e', `AIDEN_CAPABILITY_NONCE=${input.nonce}`,
      '-e', `AIDEN_CAPABILITY_ENTRYPOINT=/capability/${input.manifest.entrypoint}`,
      '-e', `AIDEN_CAPABILITY_MAX_MESSAGE_BYTES=${input.manifest.limits.maxMessageBytes}`,
      input.image ?? DEFAULT_CAPABILITY_IMAGE,
      'timeout', '--signal=KILL', '--kill-after=1s', `${runtimeSeconds}s`,
      'node', '--experimental-permission', '--no-addons',
      '--allow-fs-read=/capability', '--allow-fs-read=/aiden-host',
      '/aiden-host/containerRuntime.js',
    ],
  };
}

export interface CapabilityProcessResult {
  state: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'protocol_error' | 'unknown';
  output?: JsonValue;
  error?: string;
  claims: CapabilityEvidenceClaimMessage[];
  exitCode: number | null;
  exitSignal: string | null;
  stderr: string;
  runtimeMs: number;
  isolation: 'docker';
}

type SpawnPort = typeof spawnCommand;

export class DockerCapabilityProcessHost {
  constructor(private readonly options: {
    dockerExecutable?: string;
    image?: string;
    sourceEnvironment?: NodeJS.ProcessEnv;
    runtimePath?: string;
    spawn?: SpawnPort;
    removeContainer?: (invocation: DockerCapabilityInvocation) => void;
    probe?: () => { available: boolean; mechanism: 'docker'; reason?: string; image: string };
  } = {}) {}

  probe(): { available: boolean; mechanism: 'docker'; reason?: string; image: string } {
    if (this.options.probe) return this.options.probe();
    const environment = dockerHostEnvironment(this.options.sourceEnvironment ?? process.env);
    const executable = this.options.dockerExecutable
      ?? resolveCommand('docker', { env: environment })?.path;
    const image = this.options.image ?? DEFAULT_CAPABILITY_IMAGE;
    if (!executable) return { available: false, mechanism: 'docker', reason: 'Docker executable is unavailable', image };
    try {
      const daemon = spawnSync(executable, ['version', '--format', '{{.Server.Version}}'], {
        env: environment, windowsHide: true, timeout: 5_000, encoding: 'utf8',
      });
      if (daemon.status !== 0) return { available: false, mechanism: 'docker', reason: 'Docker daemon is unavailable', image };
      const installed = spawnSync(executable, ['image', 'inspect', image], {
        env: environment, windowsHide: true, timeout: 5_000, stdio: 'ignore',
      });
      if (installed.status !== 0) return { available: false, mechanism: 'docker', reason: `Required capability image is unavailable: ${image}`, image };
      return { available: true, mechanism: 'docker', image };
    } catch (error) {
      return { available: false, mechanism: 'docker', reason: error instanceof Error ? error.message : String(error), image };
    }
  }

  reapExpired(now = Date.now()): number {
    const probe = this.probe();
    if (!probe.available) return 0;
    const executable = this.options.dockerExecutable ?? 'docker';
    const environment = dockerHostEnvironment(this.options.sourceEnvironment ?? process.env);
    let output = '';
    try {
      output = execFileSync(executable, [
        'ps', '-a', '--filter', 'label=com.taracod.aiden.capability=true',
        '--format', '{{.ID}} {{.Label "com.taracod.aiden.expires-at"}}',
      ], { env: environment, windowsHide: true, timeout: 5_000, encoding: 'utf8' });
    } catch { return 0; }
    let removed = 0;
    for (const line of output.split(/\r?\n/u).filter(Boolean)) {
      const [id, expires] = line.trim().split(/\s+/u);
      if (!id || !Number.isFinite(Number(expires)) || Number(expires) > now) continue;
      try {
        execFileSync(executable, ['rm', '-f', id], { env: environment, windowsHide: true, timeout: 5_000, stdio: 'ignore' });
        removed += 1;
      } catch { /* the container may have exited between list and remove */ }
    }
    return removed;
  }

  removeInvocation(invocationId: string): number {
    const probe = this.probe();
    if (!probe.available) throw new Error(`CAPABILITY_SANDBOX_UNAVAILABLE: ${probe.reason}`);
    const executable = this.options.dockerExecutable ?? 'docker';
    const environment = dockerHostEnvironment(this.options.sourceEnvironment ?? process.env);
    const output = execFileSync(executable, [
      'ps', '-a', '--filter', `label=com.taracod.aiden.invocation=${invocationId}`,
      '--format', '{{.ID}}',
    ], { env: environment, windowsHide: true, timeout: 5_000, encoding: 'utf8' });
    let removed = 0;
    for (const id of output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
      execFileSync(executable, ['rm', '-f', id], {
        env: environment, windowsHide: true, timeout: 5_000, stdio: 'ignore',
      });
      removed += 1;
    }
    return removed;
  }

  async run(input: {
    manifest: CapabilityManifest;
    identity: CapabilityIdentity;
    invocationId: string;
    installPath: string;
    tool: string;
    value: JsonValue;
    broker: CapabilityBroker;
    signal?: AbortSignal;
    onProgress?: (message: CapabilityProgressMessage) => void;
    onEvidenceClaim?: (claim: CapabilityEvidenceClaimMessage) => void;
  }): Promise<CapabilityProcessResult> {
    const probe = this.probe();
    if (!probe.available) throw new Error(`CAPABILITY_SANDBOX_UNAVAILABLE: ${probe.reason}`);
    const tool = input.manifest.tools.find((candidate) => candidate.name === input.tool);
    if (!tool) throw new Error(`Capability tool is not declared: ${input.tool}`);
    const inputErrors = validateJsonValue(tool.inputSchema, input.value);
    if (inputErrors.length > 0) throw new Error(`Capability input is invalid: ${inputErrors[0]}`);
    const nonce = randomBytes(18).toString('base64url');
    const runtimePath = this.options.runtimePath ?? path.join(__dirname, 'containerRuntime.js');
    const invocation = buildDockerCapabilityInvocation({
      manifest: input.manifest, identity: input.identity, invocationId: input.invocationId,
      nonce, installPath: input.installPath, runtimePath,
      dockerExecutable: this.options.dockerExecutable, image: this.options.image,
      sourceEnvironment: this.options.sourceEnvironment,
    });
    const spawn = this.options.spawn ?? spawnCommand;
    const { child } = spawn(invocation.executable, invocation.args, {
      env: invocation.environment, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const startedAt = Date.now();
    const claims: CapabilityEvidenceClaimMessage[] = [];
    const guard = new CapabilityProtocolGuard({
      identity: input.identity, invocationId: input.invocationId, nonce,
      maxMessageBytes: input.manifest.limits.maxMessageBytes,
      maxMessages: Math.min(MAX_PROTOCOL_MESSAGES,
        input.manifest.limits.maxBrokerRequests + input.manifest.limits.maxEvidenceClaims + 256),
    });
    let hostSequence = 0;
    let totalOutputBytes = 0;
    let stderr = '';
    let buffer = '';
    let hello = false;
    let brokerRequests = 0;
    let terminal: CapabilityProcessResult['state'] | null = null;
    let output: JsonValue | undefined;
    let terminalError: string | undefined;
    let timedOut = false;
    let cancelled = false;
    let protocolFailure = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let containerRemoved = false;
    let stopRequested = false;
    let runtimeTimer: NodeJS.Timeout | null = null;

    const write = (message: Parameters<typeof encodeCapabilityMessage>[0]): void => {
      if (!child.stdin?.writable) throw new Error('Capability protocol stdin is closed');
      child.stdin.write(encodeCapabilityMessage(message, input.manifest.limits.maxMessageBytes));
    };
    const removeContainer = (): void => {
      if (containerRemoved) return;
      containerRemoved = true;
      if (this.options.removeContainer) return this.options.removeContainer(invocation);
      try {
        execFileSync(invocation.executable, ['rm', '-f', invocation.containerName], {
          env: invocation.environment, windowsHide: true, timeout: 5_000, stdio: 'ignore',
        });
      } catch { /* already removed or daemon unavailable */ }
    };
    const stop = (state: 'cancelled' | 'timed_out' | 'protocol_error', reason: string): void => {
      if (stopRequested) return;
      stopRequested = true;
      if (state === 'cancelled') cancelled = true;
      if (state === 'timed_out') timedOut = true;
      if (state === 'protocol_error') protocolFailure = true;
      terminalError = reason;
      try {
        write({
          type: 'CANCEL', sequence: hostSequence++, invocationId: input.invocationId,
          identity: input.identity, reason,
        });
      } catch { /* force cleanup below */ }
      removeContainer();
      killProcessTree(child as ChildProcess, 'SIGKILL');
    };
    const startRuntimeTimer = (): void => {
      if (runtimeTimer || stopRequested) return;
      runtimeTimer = setTimeout(
        () => stop('timed_out', 'Capability runtime limit exceeded'),
        input.manifest.limits.runtimeMs,
      );
      runtimeTimer.unref?.();
    };
    const onStdinError = (error: NodeJS.ErrnoException): void => {
      // Docker may close the pipe between the cancellation write and forced
      // container removal. That transport error is expected once shutdown is
      // owned; any earlier pipe failure is a protocol failure.
      if (stopRequested || terminal) return;
      stop('protocol_error', `Capability protocol stdin failed: ${error.code ?? error.message}`);
    };
    const handleLine = async (line: string): Promise<void> => {
      if (!line) return;
      const accepted = guard.accept(line);
      if ('code' in accepted) {
        stop('protocol_error', `${accepted.code}: ${accepted.error}`);
        return;
      }
      const message = accepted.message;
      if (message.type === 'HELLO') {
        if (hello) return stop('protocol_error', 'Duplicate capability handshake');
        hello = true;
        startRuntimeTimer();
        write({
          type: 'HELLO', sequence: hostSequence++, invocationId: input.invocationId,
          identity: input.identity, protocolVersion: input.identity.protocolVersion, nonce,
        });
        write({
          type: 'INVOKE', sequence: hostSequence++, invocationId: input.invocationId,
          identity: input.identity, tool: input.tool, input: input.value,
        });
        return;
      }
      if (!hello) return stop('protocol_error', 'Capability sent data before handshake');
      if (message.type === 'BROKER_REQUEST') {
        brokerRequests += 1;
        if (brokerRequests > input.manifest.limits.maxBrokerRequests) return stop('protocol_error', 'Capability broker request limit exceeded');
        const result = await input.broker.handle(message);
        if (!terminal && !cancelled && !timedOut && !protocolFailure) {
          write({ ...result, sequence: hostSequence++ });
        }
        return;
      }
      if (message.type === 'PROGRESS') {
        input.onProgress?.(message);
        return;
      }
      if (message.type === 'EVIDENCE_CLAIM') {
        if (claims.length >= input.manifest.limits.maxEvidenceClaims) return stop('protocol_error', 'Capability Evidence claim limit exceeded');
        claims.push(message);
        input.onEvidenceClaim?.(message);
        return;
      }
      if (message.type === 'RESULT') {
        const errors = validateJsonValue(tool.outputSchema, message.output);
        if (errors.length > 0) return stop('protocol_error', `Capability output is invalid: ${errors[0]}`);
        terminal = 'completed';
        output = message.output;
        child.stdin?.end();
        return;
      }
      if (message.type === 'ERROR') {
        terminal = message.outcome === 'unknown' ? 'unknown' : 'failed';
        terminalError = `${message.code}: ${message.message}`;
        child.stdin?.end();
      }
    };
    let lineChain = Promise.resolve();
    const onStdout = (chunk: Buffer | string): void => {
      totalOutputBytes += Buffer.byteLength(chunk);
      if (totalOutputBytes > Math.min(HOST_OUTPUT_HARD_LIMIT, input.manifest.limits.maxTotalOutputBytes)) {
        stop('protocol_error', 'Capability total output limit exceeded');
        return;
      }
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? '';
      if (Buffer.byteLength(buffer, 'utf8') > input.manifest.limits.maxMessageBytes) {
        stop('protocol_error', 'Capability unterminated message exceeds byte limit');
        return;
      }
      for (const line of lines) {
        lineChain = lineChain
          .then(() => handleLine(line))
          .catch((error: unknown) => {
            stop('protocol_error', `Capability protocol handling failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
    };
    const onStderr = (chunk: Buffer | string): void => {
      if (Buffer.byteLength(stderr, 'utf8') + Buffer.byteLength(chunk) > STDERR_HARD_LIMIT) {
        stop('protocol_error', 'Capability stderr limit exceeded');
        return;
      }
      stderr = `${stderr}${String(chunk)}`.slice(0, STDERR_HARD_LIMIT);
    };
    child.stdin?.on('error', onStdinError);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    const onAbort = (): void => stop('cancelled', 'Capability invocation cancelled');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    const handshakeTimer = setTimeout(() => {
      if (!hello) stop('protocol_error', 'Capability handshake timed out');
    }, CAPABILITY_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => { if (!settled) { settled = true; resolve(); } };
        child.once('error', finish);
        child.once('close', (code, signal) => {
          exitCode = code;
          exitSignal = signal;
          finish();
        });
      });
      await lineChain;
      if (buffer.trim()) await handleLine(buffer);
      let state = cancelled ? 'cancelled'
        : timedOut ? 'timed_out'
          : protocolFailure ? 'protocol_error'
            : terminal ?? (tool.mutates || brokerRequests > 0 ? 'unknown' : 'failed');
      if (state === 'completed' && exitCode !== 0) {
        state = tool.mutates || brokerRequests > 0 ? 'unknown' : 'failed';
        output = undefined;
        terminalError = `Capability emitted a result but exited with code ${exitCode ?? 'unknown'}`;
      }
      return {
        state, ...(output === undefined ? {} : { output }), ...(terminalError ? { error: terminalError } : {}),
        claims, exitCode, exitSignal, stderr, runtimeMs: Date.now() - startedAt, isolation: 'docker',
      };
    } finally {
      if (runtimeTimer) clearTimeout(runtimeTimer);
      clearTimeout(handshakeTimer);
      input.signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.stdin?.removeListener('error', onStdinError);
      if (cancelled || timedOut || protocolFailure || !terminal) removeContainer();
    }
  }
}
