/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveCommand, spawnCommand } from '../util/spawnCommand';
import { createExternalCodingCapabilitySnapshot } from './capability';
import {
  ExternalCodingProviderError,
  type ExternalCodingAgentProvider,
  type ExternalCodingProviderDetection,
  type ExternalCodingProviderEvent,
  type ExternalCodingProviderInputRequest,
  type ExternalCodingModelHealth,
  type ExternalCodingProviderReconciliation,
  type ExternalCodingProviderSessionHandle,
  type ExternalCodingProviderStartRequest,
  type ExternalCodingProviderState,
  type ExternalCodingProviderTaskRequest,
  type ExternalCodingProviderVersion,
} from './provider';
import type {
  ExternalCodingProcessExit,
  ExternalCodingProcessHandle,
  ExternalCodingProcessOutput,
  ExternalCodingProcessStartRequest,
  ExternalCodingProcessStatus,
} from './processHost';
import { ExternalCodingProcessHost } from './processHost';
import type { ExternalCodingCandidateResult, ExternalCodingEventType } from './types';

interface ProcessHostPort {
  start(request: ExternalCodingProcessStartRequest): Promise<ExternalCodingProcessHandle>;
  endInput(processRecordId: string, content?: string): void;
  inspect(processRecordId: string): ExternalCodingProcessStatus;
  output(processRecordId: string): ExternalCodingProcessOutput;
  cancel(processRecordId: string): Promise<ExternalCodingProcessExit>;
  terminate(processRecordId: string): Promise<ExternalCodingProcessExit>;
  wait(processRecordId: string, timeoutMs?: number): Promise<ExternalCodingProcessExit>;
  dispose(processRecordId: string): void;
}

interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CodexCliExternalCodingProviderOptions {
  executableName?: string;
  resolveExecutable?: (name: string) => string | null;
  probe?: (executable: string, args: readonly string[], environment: Readonly<Record<string, string>>) => Promise<ProbeResult>;
  modelProbe?: (executable: string, args: readonly string[], environment: Readonly<Record<string, string>>) => Promise<ProbeResult>;
  modelProbeTtlMs?: number;
  now?: () => number;
  processHost?: ProcessHostPort;
  healthEnvironment?: Readonly<Record<string, string>>;
  /** Explicit narrow credential source copied into each disposable provider home. */
  credentialFile?: string;
  platform?: NodeJS.Platform;
  /** Bounded product install roots. Only the root and one child level are inspected. */
  knownInstallRoots?: readonly string[];
}

interface ProviderSession {
  providerSessionId: string;
  request: ExternalCodingProviderStartRequest;
  process: ExternalCodingProcessHandle;
  events: ExternalCodingProviderEvent[];
  parsedLineCount: number;
  taskSent: boolean;
  reportedFiles: string[];
  result: ExternalCodingCandidateResult | null;
  closed: boolean;
}

function minimalProbeEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

async function defaultProbe(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  timeoutMs = 5_000,
): Promise<ProbeResult> {
  const { child } = spawnCommand(executable, args, {
    env: { ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const append = (current: string, chunk: Buffer | string) => `${current}${String(chunk)}`.slice(0, 16_384);
  child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
  return await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { (child as ChildProcess).kill('SIGKILL'); } catch { /* already gone */ }
      finish(-2);
    }, timeoutMs);
    timer.unref?.();
    child.once('error', () => finish(-1));
    child.once('exit', (code) => finish(code ?? -1));
  });
}

const MODEL_PROBE_PROMPT = 'Reply with exactly AIDEN_CODING_MODEL_READY. Do not inspect files or use tools.';

function classifyModelProbe(modelId: string, result: ProbeResult, checkedAt: number): ExternalCodingModelHealth {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (result.code === 0 && !/(?:turn\.failed|"type"\s*:\s*"error"|unsupported model|model[^\n]*(?:not found|not available|does not exist))/u.test(detail)) {
    return { ready: true, modelId, state: 'ready', detail: 'The exact configured model is ready.', checkedAt };
  }
  if (/(?:unsupported model|model[^\n]*(?:not found|not available|does not exist|is not supported)|unknown model)/u.test(detail)) {
    const authMode = /chatgpt(?:-account| account)|authentication mode|auth mode/u.test(detail);
    return {
      ready: false,
      modelId,
      state: authMode ? 'model_unavailable_for_auth_mode' : 'unsupported_model',
      detail: authMode
        ? 'The exact configured model is not available with the active authentication mode.'
        : 'The exact configured model is not available to this coding runtime.',
      checkedAt,
    };
  }
  if (/(?:not logged in|login required|authentication required|missing (?:api )?key|no (?:api )?key)/u.test(detail)) {
    return { ready: false, modelId, state: 'authentication_missing', detail: 'Authentication is not configured for the exact model probe.', checkedAt };
  }
  if (/(?:unauthorized|forbidden|invalid (?:api )?key|invalid credential|expired (?:token|credential)|\b401\b|\b403\b)/u.test(detail)) {
    return { ready: false, modelId, state: 'authentication_invalid', detail: 'Authentication was rejected by the exact model probe.', checkedAt };
  }
  return {
    ready: false,
    modelId,
    state: 'provider_unreachable',
    detail: result.code === -2
      ? 'The exact model probe did not complete within its bounded deadline.'
      : 'The exact configured model could not be reached.',
    checkedAt,
  };
}

function parseVersion(raw: string): { normalized: string; supported: boolean } {
  const match = raw.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\s|$)/);
  if (!match) return { normalized: 'unknown', supported: false };
  const normalized = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return { normalized, supported: major === 0 && minor >= 147 && minor < 200 };
}

function compareNormalizedVersions(left: string, right: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function taskPayload(request: ExternalCodingProviderTaskRequest): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    authority: {
      codingSessionId: request.codingSessionId,
      childAttemptId: request.childAttemptId,
      generation: request.generation,
      modelId: request.modelId,
    },
    task: request.task,
    security: {
      repositoryContentIsUntrusted: true,
      externalRuntimeIsNotApprovalAuthority: true,
      externalRuntimeIsNotCompletionAuthority: true,
      changesRemainIsolatedUntilHumanApproval: true,
    },
  })}\n`;
}

function safeString(value: unknown, max = 4_096): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function itemType(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  return safeString(item.type, 80);
}

function reportedFilePaths(item: Record<string, unknown>): string[] {
  const values: string[] = [];
  const append = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
  };
  const appendRecord = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    append(record.path);
    append(record.file_path);
    append(record.filePath);
    append(record.filename);
  };
  append(item.path);
  append(item.file_path);
  append(item.filePath);
  append(item.filename);
  for (const collection of [item.changes, item.files]) {
    if (!Array.isArray(collection)) continue;
    for (const value of collection) {
      append(value);
      appendRecord(value);
    }
  }
  return [...new Set(values)].sort();
}

function windowsCommandShell(environment: Readonly<Record<string, string>>): string {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR;
  const commandShell = environment.COMSPEC;
  if (!systemRoot || !commandShell) {
    throw new ExternalCodingProviderError(
      'WINDOWS_SHELL_UNAVAILABLE',
      'The isolated coding environment does not contain the required Windows command shell identity',
    );
  }
  const expected = path.win32.join(systemRoot, 'System32', 'cmd.exe');
  if (path.win32.normalize(commandShell).toLowerCase() !== path.win32.normalize(expected).toLowerCase()) {
    throw new ExternalCodingProviderError(
      'WINDOWS_SHELL_UNTRUSTED',
      'The isolated coding environment command shell is not the Windows system command shell',
    );
  }
  return expected;
}

/** First supported real adapter: the structured JSONL CLI protocol. */
export class CodexCliExternalCodingProvider implements ExternalCodingAgentProvider {
  readonly id = 'codex_cli';
  readonly label = 'Codex CLI';
  private readonly executableName: string;
  private readonly resolveExecutable: (name: string) => string | null;
  private readonly probe: NonNullable<CodexCliExternalCodingProviderOptions['probe']>;
  private readonly modelProbe: NonNullable<CodexCliExternalCodingProviderOptions['modelProbe']>;
  private readonly modelProbeTtlMs: number;
  private readonly now: () => number;
  private readonly processHost: ProcessHostPort;
  private readonly healthEnvironment: Readonly<Record<string, string>>;
  private readonly credentialFile: string | null;
  private readonly platform: NodeJS.Platform;
  private readonly explicitExecutable: boolean;
  private readonly knownInstallRoots: readonly string[];
  private discoveryPromise: Promise<{
    detection: ExternalCodingProviderDetection;
    version: ExternalCodingProviderVersion;
  }> | null = null;
  private readonly sessions = new Map<string, ProviderSession>();
  private readonly modelHealthCache = new Map<string, ExternalCodingModelHealth>();

  constructor(options: CodexCliExternalCodingProviderOptions = {}) {
    this.executableName = options.executableName ?? 'codex';
    this.explicitExecutable = options.executableName !== undefined;
    this.resolveExecutable = options.resolveExecutable
      ?? ((name) => resolveCommand(name, { env: this.healthEnvironment ?? minimalProbeEnvironment() })?.path ?? null);
    this.probe = options.probe ?? defaultProbe;
    this.modelProbe = options.modelProbe ?? ((executable, args, environment) =>
      defaultProbe(executable, args, environment, 15_000));
    this.modelProbeTtlMs = Math.max(1_000, options.modelProbeTtlMs ?? 30_000);
    this.now = options.now ?? Date.now;
    this.processHost = options.processHost ?? new ExternalCodingProcessHost();
    this.healthEnvironment = Object.freeze({ ...(options.healthEnvironment ?? minimalProbeEnvironment()) });
    this.credentialFile = options.credentialFile ? path.resolve(options.credentialFile) : null;
    this.platform = options.platform ?? process.platform;
    const defaultRoot = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
      : null;
    this.knownInstallRoots = Object.freeze(
      (options.knownInstallRoots ?? (defaultRoot ? [defaultRoot] : []))
        .map((root) => path.resolve(root)),
    );
  }

  async detect(): Promise<ExternalCodingProviderDetection> {
    return (await this.resolveDiscovery()).detection;
  }

  async version(): Promise<ExternalCodingProviderVersion> {
    return (await this.resolveDiscovery()).version;
  }

  async health() {
    const detection = await this.detect();
    if (!detection.executable) {
      return { healthy: false, authentication: 'unknown', authenticationMode: 'unknown', detail: detection.reason ?? 'unavailable' } as const;
    }
    const version = await this.version();
    if (!version.supported) {
      return {
        healthy: false,
        authentication: 'unknown',
        authenticationMode: 'unknown',
        detail: `Unsupported coding CLI version ${version.raw || version.normalized}.`,
      } as const;
    }
    const hasExplicitCredential = Boolean(
      this.healthEnvironment.OPENAI_API_KEY || this.healthEnvironment.CODEX_API_KEY,
    );
    if (hasExplicitCredential) {
      return { healthy: true, authentication: 'ready', authenticationMode: 'api_key', detail: 'An explicit coding credential is available.' } as const;
    }
    if (this.credentialFile) {
      const healthHome = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-auth-health-'));
      const isolatedConfigHome = path.join(healthHome, '.codex');
      try {
        await this.stageCredential(isolatedConfigHome);
        const result = await this.probe(detection.executable, ['login', 'status'], {
          ...this.healthEnvironment,
          HOME: healthHome,
          USERPROFILE: healthHome,
          CODEX_HOME: isolatedConfigHome,
        });
        const authenticationMode = await this.credentialAuthenticationMode();
        return result.code === 0
          ? { healthy: true, authentication: 'ready', authenticationMode, detail: 'Authentication is ready.' } as const
          : { healthy: false, authentication: 'invalid', authenticationMode, detail: 'The selected isolated coding credential is not valid.' } as const;
      } catch {
        return { healthy: false, authentication: 'missing', authenticationMode: 'not_configured', detail: 'The selected isolated coding credential is unavailable.' } as const;
      } finally {
        await rm(healthHome, { recursive: true, force: true });
      }
    }
    if (!this.healthEnvironment.CODEX_HOME) {
      return {
        healthy: false,
        authentication: 'missing',
        authenticationMode: 'not_configured',
        detail: 'Authentication is not configured for the isolated coding runtime.',
      } as const;
    }
    const result = await this.probe(detection.executable, ['login', 'status'], this.healthEnvironment);
    return result.code === 0
      ? { healthy: true, authentication: 'ready', authenticationMode: 'unknown', detail: 'Authentication is ready.' } as const
      : { healthy: false, authentication: 'missing', authenticationMode: 'not_configured', detail: 'Authentication is not configured for the isolated coding runtime.' } as const;
  }

  async validateModel(modelId: string): Promise<ExternalCodingModelHealth> {
    const normalizedModel = modelId.trim();
    const checkedAt = this.now();
    if (!normalizedModel) {
      return {
        ready: false, modelId: normalizedModel, state: 'unsupported_model',
        detail: 'External coding model is not configured.', checkedAt,
      };
    }
    const cacheKey = `${normalizedModel}\0${await this.authenticationCacheKey()}`;
    const cached = this.modelHealthCache.get(cacheKey);
    if (cached && checkedAt - cached.checkedAt < this.modelProbeTtlMs) return cached;

    const [detection, version, health] = await Promise.all([this.detect(), this.version(), this.health()]);
    if (!detection.executable || !version.supported || !health.healthy) {
      const state = !version.supported
        ? 'unsupported_cli' as const
        : health.authentication === 'invalid'
          ? 'authentication_invalid' as const
          : health.authentication === 'missing'
            ? 'authentication_missing' as const
            : 'provider_unreachable' as const;
      const result: ExternalCodingModelHealth = {
        ready: false,
        modelId: normalizedModel,
        state,
        detail: !version.supported ? 'The coding CLI version cannot validate the configured model.' : health.detail,
        checkedAt,
      };
      this.modelHealthCache.set(cacheKey, result);
      return result;
    }

    const healthHome = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-model-health-'));
    const isolatedConfigHome = path.join(healthHome, '.codex');
    const workspacePath = path.join(healthHome, 'workspace');
    try {
      await mkdir(workspacePath, { recursive: true });
      if (this.credentialFile) await this.stageCredential(isolatedConfigHome);
      else await mkdir(isolatedConfigHome, { recursive: true });
      const environment = {
        ...this.healthEnvironment,
        HOME: healthHome,
        USERPROFILE: healthHome,
        CODEX_HOME: isolatedConfigHome,
      };
      const windowsShell = this.platform === 'win32' ? windowsCommandShell(environment) : null;
      const args = [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--model', normalizedModel,
        '--sandbox', 'read-only',
        ...(this.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []),
        ...(windowsShell ? ['-c', `windows.shell_path=${JSON.stringify(windowsShell)}`] : []),
        '-c', 'shell_environment_policy.inherit=none',
        '-C', workspacePath,
        MODEL_PROBE_PROMPT,
      ];
      const result = classifyModelProbe(normalizedModel, await this.modelProbe(detection.executable, args, environment), checkedAt);
      this.modelHealthCache.set(cacheKey, result);
      return result;
    } catch {
      const result: ExternalCodingModelHealth = {
        ready: false, modelId: normalizedModel, state: 'provider_unreachable',
        detail: 'The exact configured model could not be validated in isolation.', checkedAt,
      };
      this.modelHealthCache.set(cacheKey, result);
      return result;
    } finally {
      await rm(healthHome, { recursive: true, force: true });
    }
  }

  async capabilities() {
    const version = await this.version();
    return createExternalCodingCapabilitySnapshot({
      capabilityId: 'external-coding:codex-cli-jsonl-v1',
      providerId: this.id,
      providerVersion: version.normalized,
      protocolMode: 'structured',
      protocolVersion: 'jsonl-v1',
      supportedFeatures: {
        structuredProtocol: true,
        pty: false,
        resume: false,
        semanticEvents: true,
        clarification: false,
        approvalEvents: false,
        nativeDiff: true,
        nativeTestEvents: true,
        networkRequired: true,
        processTreeGuarantee: 'supervised',
        commandVisibility: 'observable',
      },
      runtimeCompatibility: { platforms: ['darwin', 'linux', 'win32'] },
      capturedAt: Date.now(),
    });
  }

  async startSession(request: ExternalCodingProviderStartRequest): Promise<ExternalCodingProviderSessionHandle> {
    if (!request.sandbox.available) {
      throw new ExternalCodingProviderError('SANDBOX_UNAVAILABLE', 'Required coding sandbox is unavailable');
    }
    const detection = await this.detect();
    const version = await this.version();
    if (!detection.executable) throw new ExternalCodingProviderError('PROVIDER_UNAVAILABLE', 'Coding CLI executable is unavailable');
    if (!version.supported) {
      throw new ExternalCodingProviderError('UNSUPPORTED_PROVIDER_VERSION', `Coding CLI version ${version.raw} is not supported`);
    }
    const existing = this.sessions.get(request.codingSessionId);
    if (existing) {
      if (existing.request.childAttemptId !== request.childAttemptId || existing.request.generation !== request.generation) {
        throw new ExternalCodingProviderError('SESSION_IDENTITY_CONFLICT', 'Coding provider session authority changed');
      }
      return {
        providerSessionId: existing.providerSessionId,
        codingSessionId: request.codingSessionId,
        protocolMode: 'structured',
        processIdentity: existing.process.identity,
        processRecordId: existing.process.processRecordId,
      };
    }
    const windowsShell = this.platform === 'win32' ? windowsCommandShell(request.environment) : null;
    const args = [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--model', request.modelId,
      '--sandbox', 'workspace-write',
      ...(this.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []),
      ...(windowsShell ? ['-c', `windows.shell_path=${JSON.stringify(windowsShell)}`] : []),
      '-c', 'shell_environment_policy.inherit=all',
      '-c', `sandbox_workspace_write.network_access=${request.sandbox.network === 'disabled' ? 'false' : 'true'}`,
      '-C', request.workspacePath,
      '-',
    ];
    const isolatedConfigHome = path.join(request.sessionHome, '.codex');
    await mkdir(isolatedConfigHome, { recursive: true });
    if (this.credentialFile) {
      try {
        await this.stageCredential(isolatedConfigHome);
      } catch {
        throw new ExternalCodingProviderError(
          'AUTHENTICATION_MISSING',
          'The selected isolated coding credential could not be staged',
        );
      }
    }
    const process = await this.processHost.start({
      codingSessionId: request.codingSessionId,
      childAttemptId: request.childAttemptId,
      generation: request.generation,
      executable: detection.executable,
      executableVersion: version.normalized,
      args,
      cwd: request.workspacePath,
      environment: { ...request.environment, CODEX_HOME: isolatedConfigHome },
      protocolMode: 'structured',
      sandbox: {
        required: true,
        available: request.sandbox.available,
        authority: `provider-native:${this.id}:${version.normalized}`,
        networkEnforced: request.sandbox.network === 'disabled',
        workspaceWriteBoundaryEnforced: true,
      },
      limits: { outputBytes: request.task.budgets.outputBytes, rawLogBytes: request.task.budgets.outputBytes },
      redactionCanaries: request.redactionCanaries,
    });
    const providerSessionId = `codex_provider_session_${randomBytes(16).toString('hex')}`;
    const session: ProviderSession = {
      providerSessionId,
      request,
      process,
      events: [{
        providerEventId: `${providerSessionId}:1`, cursor: 1, type: 'session.started',
        payload: { protocolMode: 'structured', executableVersion: version.normalized }, observedAt: Date.now(),
      }],
      parsedLineCount: 0,
      taskSent: false,
      reportedFiles: [],
      result: null,
      closed: false,
    };
    this.sessions.set(request.codingSessionId, session);
    return {
      providerSessionId,
      codingSessionId: request.codingSessionId,
      protocolMode: 'structured',
      processIdentity: process.identity,
      processRecordId: process.processRecordId,
    };
  }

  async sendTask(request: ExternalCodingProviderTaskRequest): Promise<void> {
    const session = this.require(request.providerSessionId);
    this.assertAuthority(session, request);
    if (session.taskSent) throw new ExternalCodingProviderError('TASK_ALREADY_SENT', 'Coding task is immutable and was already sent');
    session.taskSent = true;
    this.processHost.endInput(session.process.processRecordId, taskPayload(request));
  }

  async sendInput(_request: ExternalCodingProviderInputRequest): Promise<void> {
    throw new ExternalCodingProviderError('INPUT_NOT_SUPPORTED', 'Selected structured coding protocol does not support mid-session input');
  }

  async events(providerSessionId: string, afterCursor: number): Promise<readonly ExternalCodingProviderEvent[]> {
    const session = this.require(providerSessionId);
    this.syncEvents(session);
    return session.events.filter((event) => event.cursor > afterCursor);
  }

  async cancel(providerSessionId: string, _reason: string): Promise<void> {
    const session = this.require(providerSessionId);
    if (this.processHost.inspect(session.process.processRecordId).running) {
      await this.processHost.cancel(session.process.processRecordId);
    }
  }

  async terminate(providerSessionId: string): Promise<void> {
    const session = this.require(providerSessionId);
    if (this.processHost.inspect(session.process.processRecordId).running) {
      await this.processHost.terminate(session.process.processRecordId);
    }
  }

  async inspectState(providerSessionId: string): Promise<ExternalCodingProviderState> {
    const session = this.require(providerSessionId);
    this.syncEvents(session);
    const status = this.processHost.inspect(session.process.processRecordId);
    return {
      state: status.running ? 'running' : 'terminal',
      processIdentity: session.process.identity,
      lastCursor: session.events[session.events.length - 1]?.cursor ?? 0,
      detail: status.running ? 'running' : 'process terminal',
    };
  }

  async collectResult(providerSessionId: string): Promise<ExternalCodingCandidateResult | null> {
    const session = this.require(providerSessionId);
    this.syncEvents(session);
    return session.result;
  }

  async reconcile(providerSessionId: string): Promise<ExternalCodingProviderReconciliation> {
    const session = this.require(providerSessionId);
    this.syncEvents(session);
    const status = this.processHost.inspect(session.process.processRecordId);
    if (status.running) {
      return { outcome: 'running', retrySafe: false, reason: 'Original process is still running.', observedProcessTreeDead: false, result: null };
    }
    const exit = await this.processHost.wait(session.process.processRecordId);
    const outcome = session.result?.externalOutcome ?? (exit.exitCode === 0 ? 'unknown' : 'failed');
    return {
      outcome,
      retrySafe: false,
      reason: session.result?.summary ?? 'Process ended without an independently verified result.',
      observedProcessTreeDead: exit.treeDeadVerified,
      result: session.result,
    };
  }

  async close(providerSessionId: string): Promise<void> {
    const session = this.require(providerSessionId);
    if (this.processHost.inspect(session.process.processRecordId).running) {
      throw new ExternalCodingProviderError('SESSION_STILL_RUNNING', 'Cannot close a running coding provider session');
    }
    if (!session.closed) {
      this.processHost.dispose(session.process.processRecordId);
      session.closed = true;
    }
  }

  async forensicOutput(providerSessionId: string) {
    const session = this.require(providerSessionId);
    const status = this.processHost.inspect(session.process.processRecordId);
    const output = status.output;
    const exit = status.running ? null : await this.processHost.wait(session.process.processRecordId);
    return {
      processRecordId: session.process.processRecordId,
      stdout: output.stdout,
      stderr: output.stderr,
      observedBytes: output.observedBytes,
      storedBytes: output.storedBytes,
      truncated: output.truncated,
      exitCode: exit?.exitCode ?? null,
      exitSignal: exit?.signal ?? null,
      treeDeadVerified: exit?.treeDeadVerified ?? false,
    };
  }

  private syncEvents(session: ProviderSession): void {
    const output = this.processHost.output(session.process.processRecordId).stdout;
    const lines = output.split(/\r\n|\r|\n/u);
    const trailingLineBreak = /(?:\r\n|\r|\n)$/u.test(output);
    let parsedLineCount = session.parsedLineCount;
    for (let index = session.parsedLineCount; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) {
        if (index < lines.length - 1) parsedLineCount = index + 1;
        continue;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Structured output is cumulative. The last logical line may be only a
        // fragment from the current stdout chunk, so leave it pending until a
        // later read completes it. A malformed newline-terminated record is
        // bounded forensic output, not a semantic event.
        if (index === lines.length - 1 && !trailingLineBreak) break;
        parsedLineCount = index + 1;
        continue;
      }
      const type = safeString(event.type, 80);
      let normalized: ExternalCodingEventType | null = null;
      let payload: Record<string, unknown> = {};
      if (type === 'thread.started') normalized = 'session.ready';
      else if (type === 'turn.started') normalized = 'inspection.started';
      else if (type === 'turn.completed') normalized = 'inspection.completed';
      else if (type === 'error' || type === 'turn.failed') {
        normalized = 'process.terminal';
        payload = { failed: true };
      } else if (type === 'item.started') {
        const nestedType = itemType(event.item);
        if (nestedType === 'command_execution') {
          normalized = 'command.started';
          payload = { commandVisible: true };
        }
      } else if (type === 'item.completed') {
        const item = (event.item && typeof event.item === 'object') ? event.item as Record<string, unknown> : {};
        const nestedType = itemType(item);
        if (nestedType === 'command_execution') {
          normalized = 'command.completed';
          payload = { exitCode: typeof item.exit_code === 'number' ? item.exit_code : null };
        } else if (nestedType === 'file_change') {
          normalized = 'file.activity';
          const paths = reportedFilePaths(item);
          session.reportedFiles = [...new Set([...session.reportedFiles, ...paths])].sort();
          if (session.result) session.result = { ...session.result, reportedFiles: session.reportedFiles };
          payload = { operation: 'change_reported', changedFileCount: paths.length, paths };
        } else if (nestedType === 'agent_message') {
          const summary = safeString(item.text ?? item.content, 8_192);
          session.result = {
            summary,
            reportedFiles: session.reportedFiles,
            reportedValidations: [],
            externalOutcome: 'completed',
          };
          normalized = 'result.reported';
          payload = { summary, reportedFiles: session.reportedFiles, externalOutcome: 'completed' };
        }
      }
      if (normalized) {
        const cursor = session.events.length + 1;
        session.events.push({
          providerEventId: `${session.providerSessionId}:${cursor}`,
          cursor,
          type: normalized,
          payload,
          observedAt: Date.now(),
        });
      }
      parsedLineCount = index + 1;
    }
    session.parsedLineCount = parsedLineCount;
  }

  private require(providerSessionId: string): ProviderSession {
    const session = [...this.sessions.values()].find((item) => item.providerSessionId === providerSessionId);
    if (!session) throw new ExternalCodingProviderError('PROVIDER_SESSION_NOT_FOUND', 'Coding provider session was not found');
    return session;
  }

  private async probeVersion(executable: string): Promise<ExternalCodingProviderVersion> {
    const result = await this.probe(executable, ['--version'], this.healthEnvironment);
    const raw = `${result.stdout}\n${result.stderr}`.trim().slice(0, 512);
    const parsed = result.code === 0 ? parseVersion(raw) : { normalized: 'unknown', supported: false };
    return { raw, ...parsed };
  }

  private async discoverKnownWindowsCandidates(): Promise<string[]> {
    if (this.platform !== 'win32') return [];
    const candidates = new Set<string>();
    for (const configuredRoot of this.knownInstallRoots) {
      try {
        const rootStat = await lstat(configuredRoot);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
        const resolvedRoot = await realpath(configuredRoot);
        const possible = [path.join(resolvedRoot, 'codex.exe')];
        for (const entry of await readdir(resolvedRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          possible.push(path.join(resolvedRoot, entry.name, 'codex.exe'));
        }
        for (const candidate of possible) {
          try {
            const stat = await lstat(candidate);
            if (!stat.isFile() || stat.isSymbolicLink() || path.basename(candidate).toLowerCase() !== 'codex.exe') continue;
            const resolvedCandidate = await realpath(candidate);
            if (isInside(resolvedRoot, resolvedCandidate)) candidates.add(resolvedCandidate);
          } catch { /* candidate absent or unsafe */ }
        }
      } catch { /* configured product root is absent or unsafe */ }
    }
    return [...candidates].sort((left, right) => left.localeCompare(right));
  }

  private resolveDiscovery(): Promise<{
    detection: ExternalCodingProviderDetection;
    version: ExternalCodingProviderVersion;
  }> {
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = (async () => {
      const primary = this.resolveExecutable(this.executableName);
      if (this.explicitExecutable) {
        if (!primary) {
          return {
            detection: {
              available: false, executable: null, source: 'explicit',
              reason: 'The explicitly configured coding CLI executable was not found.',
            },
            version: { raw: 'unavailable', normalized: 'unknown', supported: false },
          };
        }
        return {
          detection: { available: true, executable: primary, source: 'explicit', reason: null },
          version: await this.probeVersion(primary),
        };
      }

      const primaryVersion = primary ? await this.probeVersion(primary) : null;
      if (primary && primaryVersion?.supported) {
        return {
          detection: { available: true, executable: primary, source: 'path', reason: null },
          version: primaryVersion,
        };
      }

      const compatible: Array<{ executable: string; version: ExternalCodingProviderVersion }> = [];
      const unsupported: Array<{ executable: string; version: ExternalCodingProviderVersion }> = [];
      for (const executable of await this.discoverKnownWindowsCandidates()) {
        if (primary && path.resolve(executable).toLowerCase() === path.resolve(primary).toLowerCase()) continue;
        const version = await this.probeVersion(executable);
        (version.supported ? compatible : unsupported).push({ executable, version });
      }
      compatible.sort((left, right) => compareNormalizedVersions(right.version.normalized, left.version.normalized));
      const selected = compatible[0];
      if (selected) {
        return {
          detection: {
            available: true,
            executable: selected.executable,
            source: 'known_installation',
            reason: null,
            ambientExecutable: primary,
            ambientVersion: primaryVersion?.raw ?? null,
          },
          version: selected.version,
        };
      }

      if (primary && primaryVersion) {
        return {
          detection: { available: true, executable: primary, source: 'path', reason: null },
          version: primaryVersion,
        };
      }
      const discovered = unsupported[0];
      if (discovered) {
        return {
          detection: { available: true, executable: discovered.executable, source: 'known_installation', reason: null },
          version: discovered.version,
        };
      }
      return {
        detection: {
          available: false, executable: null,
          reason: 'Supported coding CLI executable was not found; Aiden never auto-installs it.',
        },
        version: { raw: 'unavailable', normalized: 'unknown', supported: false },
      };
    })();
    return this.discoveryPromise;
  }

  private async stageCredential(isolatedConfigHome: string): Promise<void> {
    if (!this.credentialFile) return;
    const source = await lstat(this.credentialFile);
    if (!source.isFile() || source.isSymbolicLink()) throw new Error('Credential source is not a regular file');
    await mkdir(isolatedConfigHome, { recursive: true });
    const destination = path.join(isolatedConfigHome, 'auth.json');
    await copyFile(this.credentialFile, destination);
    if (process.platform !== 'win32') await chmod(destination, 0o600);
  }

  private async credentialAuthenticationMode(): Promise<'api_key' | 'chatgpt_account' | 'unknown'> {
    if (!this.credentialFile) return 'unknown';
    try {
      const parsed = JSON.parse(await readFile(this.credentialFile, 'utf8')) as Record<string, unknown>;
      const value = typeof parsed.auth_mode === 'string' ? parsed.auth_mode.toLowerCase() : '';
      if (value.includes('chatgpt')) return 'chatgpt_account';
      if (value.includes('api')) return 'api_key';
    } catch { /* authentication remains validatable without exposing file content */ }
    return 'unknown';
  }

  private async authenticationCacheKey(): Promise<string> {
    if (this.healthEnvironment.OPENAI_API_KEY || this.healthEnvironment.CODEX_API_KEY) return 'explicit-api-key';
    if (!this.credentialFile) return `config-home:${this.healthEnvironment.CODEX_HOME ?? 'missing'}`;
    try {
      const stat = await lstat(this.credentialFile);
      return `credential-file:${this.credentialFile}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `credential-file:${this.credentialFile}:missing`;
    }
  }

  private assertAuthority(
    session: ProviderSession,
    input: { codingSessionId: string; childAttemptId: string; generation: number; modelId?: string },
  ): void {
    if (session.request.codingSessionId !== input.codingSessionId
      || session.request.childAttemptId !== input.childAttemptId
      || session.request.generation !== input.generation
      || (input.modelId !== undefined && session.request.modelId !== input.modelId)) {
      throw new ExternalCodingProviderError('STALE_PROVIDER_INPUT', 'Coding provider input authority is stale');
    }
  }
}
