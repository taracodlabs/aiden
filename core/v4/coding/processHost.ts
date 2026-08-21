/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { getProcessCreationTime, killProcessTree, spawnCommand } from '../util/spawnCommand';
import type { ExternalCodingProcessIdentity, ExternalCodingProtocolMode } from './types';

export class ExternalCodingProcessHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalCodingProcessHostError';
  }
}

export interface ExternalCodingSandboxGrant {
  readonly required: true;
  readonly available: boolean;
  readonly authority: string;
  readonly networkEnforced: boolean;
  readonly workspaceWriteBoundaryEnforced: boolean;
}

export interface ExternalCodingProcessStartRequest {
  readonly codingSessionId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly executable: string;
  readonly executableVersion: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly protocolMode: ExternalCodingProtocolMode;
  readonly sandbox: ExternalCodingSandboxGrant;
  readonly limits: Readonly<{ outputBytes: number; rawLogBytes: number }>;
  readonly redactionCanaries?: readonly string[];
}

export interface ExternalCodingProcessHandle {
  readonly processRecordId: string;
  readonly codingSessionId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly identity: ExternalCodingProcessIdentity;
}

export interface ExternalCodingProcessExit {
  readonly processRecordId: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly exitedAt: number;
  readonly treeDeadVerified: boolean;
}

export interface ExternalCodingProcessOutput {
  readonly text: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly observedBytes: number;
  readonly storedBytes: number;
  readonly truncated: boolean;
}

export interface ExternalCodingProcessStatus {
  readonly handle: ExternalCodingProcessHandle;
  readonly running: boolean;
  readonly output: ExternalCodingProcessOutput;
}

interface Slot {
  handle: ExternalCodingProcessHandle;
  child: ChildProcess;
  rawStdout: string;
  rawStderr: string;
  observedBytes: number;
  truncated: boolean;
  outputLimit: number;
  rawLogLimit: number;
  canaries: readonly string[];
  settled: boolean;
  finalExit: ExternalCodingProcessExit | null;
  ownedTree: Map<number, number | null>;
  treeWatcher: NodeJS.Timeout | null;
  lastTreeRefreshAt: number;
  exit: Promise<ExternalCodingProcessExit>;
  settleExit: (value: ExternalCodingProcessExit) => void;
  dataListeners: Array<{ stream: NodeJS.ReadableStream; listener: (chunk: Buffer | string) => void }>;
}

const TOKEN_PATTERN = /(?:bearer\s+[a-z0-9._-]{12,}|(?:sk|gsk|ghp)_[a-z0-9_-]{12,})/gi;

function redact(text: string, canaries: readonly string[]): string {
  let safe = text.replace(TOKEN_PATTERN, '[redacted]');
  for (const canary of canaries) {
    if (canary) safe = safe.split(canary).join('[redacted]');
    if (canary) {
      const maximum = Math.min(canary.length - 1, safe.length);
      for (let length = maximum; length >= Math.min(4, maximum); length -= 1) {
        if (safe.endsWith(canary.slice(0, length))) {
          safe = `${safe.slice(0, -length)}[redacted]`;
          break;
        }
      }
    }
  }
  safe = safe.replace(/(?:bearer\s+[a-z0-9._-]{0,}|(?:sk|gsk|ghp)_[a-z0-9_-]{0,})$/gi, '[redacted]');
  return safe;
}

function truncateUtf8(text: string, maximumBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maximumBytes) return text;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function processAlive(pid: number, expectedStartTime: number | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (expectedStartTime !== null) {
    const actual = getProcessCreationTime(pid);
    return actual !== null && Math.abs(actual - expectedStartTime) < 2_000;
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface ProcessLink { pid: number; parentPid: number }

function processLinks(): ProcessLink[] {
  try {
    if (process.platform === 'win32') {
      const raw = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress",
      ], { encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const parsed: unknown = JSON.parse(String(raw));
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const row = item as { ProcessId?: unknown; ParentProcessId?: unknown };
        const pid = Number(row.ProcessId);
        const parentPid = Number(row.ParentProcessId);
        return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid >= 0
          ? [{ pid, parentPid }] : [];
      });
    }
    const raw = execFileSync('ps', ['-eo', 'pid=,ppid='], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(raw).split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]) }] : [];
    });
  } catch {
    return [];
  }
}

function descendantPids(rootPid: number): number[] {
  const links = processLinks();
  const descendants = new Set<number>();
  const frontier = [rootPid];
  while (frontier.length > 0) {
    const parent = frontier.shift()!;
    for (const link of links) {
      if (link.parentPid !== parent || descendants.has(link.pid) || link.pid === rootPid) continue;
      descendants.add(link.pid);
      frontier.push(link.pid);
    }
  }
  return [...descendants];
}

function refreshOwnedTree(slot: Slot, force = false, allowExitedRoot = false): void {
  const now = Date.now();
  if (!force && now - slot.lastTreeRefreshAt < 750) return;
  slot.lastTreeRefreshAt = now;
  if (!processAlive(slot.handle.identity.pid, slot.handle.identity.startTime) && !allowExitedRoot) return;
  for (const pid of descendantPids(slot.handle.identity.pid)) {
    if (slot.ownedTree.has(pid)) continue;
    const startedAt = getProcessCreationTime(pid);
    const rootStartedAt = slot.handle.identity.startTime;
    if (startedAt === null || (rootStartedAt !== null && startedAt < rootStartedAt - 2_000)) continue;
    slot.ownedTree.set(pid, startedAt);
  }
}

function ownedTreeDead(slot: Slot): boolean {
  return [...slot.ownedTree].every(([pid, startedAt]) => !processAlive(pid, startedAt));
}

function killOwnedSurvivors(slot: Slot): void {
  for (const [pid, startedAt] of slot.ownedTree) {
    if (pid === slot.handle.identity.pid || !processAlive(pid, startedAt)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* exact attributable process already exited */ }
  }
}

export interface PersistedExternalCodingTermination {
  readonly identityMatched: boolean;
  readonly signalIssued: boolean;
  readonly treeDeadVerified: boolean;
  readonly reason: string;
}

function blockingPause(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

/**
 * Recovery-only exact process cleanup. A persisted PID is never signalled
 * unless its kernel creation time still matches the admitted process identity.
 */
export function terminatePersistedExternalCodingProcess(
  identity: ExternalCodingProcessIdentity,
): PersistedExternalCodingTermination {
  if (identity.startTime === null) {
    return {
      identityMatched: false,
      signalIssued: false,
      treeDeadVerified: false,
      reason: 'Persisted process identity could not be matched; no signal was sent.',
    };
  }
  const rootWasPresent = pidExists(identity.pid);
  const rootAbsentObservedAt = Date.now();
  if (!rootWasPresent) {
    if (process.platform !== 'win32') {
      return {
        identityMatched: false,
        signalIssued: false,
        treeDeadVerified: false,
        reason: 'Persisted process is absent and descendant lineage cannot be proven on this platform.',
      };
    }
    const descendants = descendantPids(identity.pid).map((pid) => ({ pid, startTime: getProcessCreationTime(pid) }))
      .filter((processRecord) => processRecord.startTime !== null
        && processRecord.startTime >= identity.startTime! - 2_000
        && processRecord.startTime <= rootAbsentObservedAt);
    let signalIssued = false;
    for (const descendant of descendants) {
      if (!processAlive(descendant.pid, descendant.startTime)) continue;
      try { process.kill(descendant.pid, 'SIGKILL'); signalIssued = true; } catch { /* exact descendant already exited */ }
    }
    const deadline = Date.now() + 5_000;
    let treeDeadVerified = false;
    do {
      treeDeadVerified = descendants.every((descendant) => !processAlive(descendant.pid, descendant.startTime));
      if (treeDeadVerified || Date.now() >= deadline) break;
      blockingPause(20);
    } while (true);
    return {
      identityMatched: true,
      signalIssued,
      treeDeadVerified,
      reason: treeDeadVerified
        ? 'The persisted Windows process was already absent and no attributable child lineage remains.'
        : 'An attributable Windows child process may still be running; reconciliation remains blocked.',
    };
  }
  const actualStartTime = getProcessCreationTime(identity.pid);
  if (actualStartTime === null || Math.abs(actualStartTime - identity.startTime) >= 2_000) {
    return {
      identityMatched: false,
      signalIssued: false,
      treeDeadVerified: false,
      reason: 'Persisted process identity could not be matched; no signal was sent.',
    };
  }

  const descendants = descendantPids(identity.pid).map((pid) => ({ pid, startTime: getProcessCreationTime(pid) }))
    .filter((processRecord) => processRecord.startTime !== null
      && processRecord.startTime >= identity.startTime! - 2_000);
  let signalIssued = false;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/pid', String(identity.pid), '/t', '/f'], {
        stdio: 'ignore', timeout: 5_000, windowsHide: true,
      });
    } else {
      try { process.kill(-identity.pid, 'SIGKILL'); }
      catch { process.kill(identity.pid, 'SIGKILL'); }
    }
    signalIssued = true;
  } catch {
    try { process.kill(identity.pid, 'SIGKILL'); signalIssued = true; } catch { /* process may already be terminal */ }
    for (const descendant of descendants) {
      if (!processAlive(descendant.pid, descendant.startTime)) continue;
      try { process.kill(descendant.pid, 'SIGKILL'); signalIssued = true; } catch { /* exact descendant already exited */ }
    }
  }

  const deadline = Date.now() + 5_000;
  let treeDeadVerified = false;
  do {
    treeDeadVerified = !processAlive(identity.pid, identity.startTime)
      && descendants.every((descendant) => !processAlive(descendant.pid, descendant.startTime));
    if (treeDeadVerified || Date.now() >= deadline) break;
    blockingPause(20);
  } while (true);
  return {
    identityMatched: true,
    signalIssued,
    treeDeadVerified,
    reason: treeDeadVerified
      ? 'The exact persisted process tree is no longer running.'
      : 'An attributable process may still be running; reconciliation remains blocked.',
  };
}

/** Coding-session-specific structured stdio host with exact ownership and bounded output. */
export class ExternalCodingProcessHost {
  private readonly slots = new Map<string, Slot>();

  async start(request: ExternalCodingProcessStartRequest): Promise<ExternalCodingProcessHandle> {
    if (!request.sandbox.available
      || !request.sandbox.workspaceWriteBoundaryEnforced
      || (request.sandbox.authority === 'none')) {
      throw new ExternalCodingProcessHostError('SANDBOX_UNAVAILABLE', 'Required external coding sandbox is unavailable');
    }
    if (request.limits.outputBytes <= 0 || request.limits.rawLogBytes <= 0) {
      throw new ExternalCodingProcessHostError('INVALID_OUTPUT_LIMIT', 'External coding output limits must be positive');
    }
    if (request.protocolMode !== 'structured') {
      throw new ExternalCodingProcessHostError('PTY_HOST_REQUIRED', 'Structured process host cannot launch a PTY session');
    }
    const { child } = spawnCommand(request.executable, request.args, {
      cwd: request.cwd,
      env: { ...request.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const pid = child.pid;
    if (!pid || pid <= 0) {
      try { child.kill('SIGKILL'); } catch { /* no process was created */ }
      throw new ExternalCodingProcessHostError('PROCESS_IDENTITY_MISSING', 'External coding process did not receive a PID');
    }
    const identity: ExternalCodingProcessIdentity = {
      pid,
      startTime: getProcessCreationTime(pid),
      executable: request.executable,
      version: request.executableVersion,
      cwd: request.cwd,
      mode: request.protocolMode,
    };
    const processRecordId = `coding_process_${randomBytes(16).toString('hex')}`;
    let settleExit!: (value: ExternalCodingProcessExit) => void;
    const exit = new Promise<ExternalCodingProcessExit>((resolve) => { settleExit = resolve; });
    const slot: Slot = {
      handle: {
        processRecordId,
        codingSessionId: request.codingSessionId,
        childAttemptId: request.childAttemptId,
        generation: request.generation,
        identity,
      },
      child,
      rawStdout: '',
      rawStderr: '',
      observedBytes: 0,
      truncated: false,
      outputLimit: request.limits.outputBytes,
      rawLogLimit: Math.min(request.limits.rawLogBytes, request.limits.outputBytes),
      canaries: [...(request.redactionCanaries ?? [])],
      settled: false,
      finalExit: null,
      ownedTree: new Map([[pid, identity.startTime]]),
      treeWatcher: null,
      lastTreeRefreshAt: 0,
      exit,
      settleExit,
      dataListeners: [],
    };
    this.slots.set(processRecordId, slot);
    const onData = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      slot.observedBytes += Buffer.byteLength(raw, 'utf8');
      const stored = Buffer.byteLength(slot.rawStdout, 'utf8') + Buffer.byteLength(slot.rawStderr, 'utf8');
      const remaining = Math.max(0, slot.rawLogLimit - stored);
      if (remaining > 0) {
        const bytes = Buffer.from(raw, 'utf8');
        const value = bytes.subarray(0, remaining).toString('utf8');
        if (stream === 'stdout') slot.rawStdout += value;
        else slot.rawStderr += value;
      }
      if (slot.observedBytes > slot.outputLimit || Buffer.byteLength(raw, 'utf8') > remaining) slot.truncated = true;
    };
    if (child.stdout) {
      const listener = (chunk: Buffer | string) => onData('stdout', chunk);
      child.stdout.on('data', listener);
      slot.dataListeners.push({ stream: child.stdout, listener });
    }
    if (child.stderr) {
      const listener = (chunk: Buffer | string) => onData('stderr', chunk);
      child.stderr.on('data', listener);
      slot.dataListeners.push({ stream: child.stderr, listener });
    }
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (slot.settled) return;
      // Windows retains the creator PID on surviving descendants after a
      // short-lived parent exits. Capture that final kernel view before the
      // periodic sampler is stopped so tree-death cannot be reported while an
      // attributable child remains alive.
      refreshOwnedTree(slot, true, true);
      slot.settled = true;
      if (slot.treeWatcher) clearInterval(slot.treeWatcher);
      slot.treeWatcher = null;
      for (const listener of slot.dataListeners) listener.stream.removeListener('data', listener.listener);
      slot.dataListeners.length = 0;
      const finish = () => {
        slot.finalExit = {
          processRecordId,
          exitCode,
          signal,
          exitedAt: Date.now(),
          treeDeadVerified: ownedTreeDead(slot),
        };
        slot.settleExit(slot.finalExit);
      };
      setImmediate(finish);
    };
    slot.treeWatcher = setInterval(() => refreshOwnedTree(slot, true), 1_000);
    slot.treeWatcher.unref?.();
    child.once('exit', () => {
      // The process can exit before its inherited stdout/stderr handles close.
      // Capture the final kernel tree now, but keep consuming output until the
      // authoritative close event proves both process and stdio settlement.
      refreshOwnedTree(slot, true, true);
    });
    child.once('close', settle);
    child.once('error', () => settle(-1, null));
    return slot.handle;
  }

  send(processRecordId: string, content: string): void {
    const slot = this.require(processRecordId);
    if (slot.settled || !slot.child.stdin?.writable) {
      throw new ExternalCodingProcessHostError('PROCESS_NOT_WRITABLE', 'External coding process input is closed');
    }
    slot.child.stdin.write(content);
  }

  endInput(processRecordId: string, content?: string): void {
    const slot = this.require(processRecordId);
    if (slot.settled || !slot.child.stdin?.writable) {
      throw new ExternalCodingProcessHostError('PROCESS_NOT_WRITABLE', 'External coding process input is closed');
    }
    slot.child.stdin.end(content);
  }

  async cancel(processRecordId: string): Promise<ExternalCodingProcessExit> {
    const slot = this.require(processRecordId);
    refreshOwnedTree(slot, true);
    const rootAlive = processAlive(slot.handle.identity.pid, slot.handle.identity.startTime);
    if (!rootAlive && ownedTreeDead(slot)) return this.wait(processRecordId);
    if (!rootAlive && !slot.settled) {
      throw new ExternalCodingProcessHostError('PROCESS_IDENTITY_LOST', 'External coding process identity no longer matches');
    }
    if (rootAlive) killProcessTree(slot.child, 'SIGKILL');
    else killOwnedSurvivors(slot);
    const exit = await this.wait(processRecordId, 10_000);
    const deadline = Date.now() + 5_000;
    while (!ownedTreeDead(slot) && Date.now() < deadline) {
      killOwnedSurvivors(slot);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!ownedTreeDead(slot)) {
      throw new ExternalCodingProcessHostError('PROCESS_TREE_STILL_ALIVE', 'Attributable external coding descendants survived cancellation');
    }
    slot.finalExit = { ...exit, treeDeadVerified: true };
    return slot.finalExit;
  }

  async terminate(processRecordId: string): Promise<ExternalCodingProcessExit> {
    return this.cancel(processRecordId);
  }

  async wait(processRecordId: string, timeoutMs?: number): Promise<ExternalCodingProcessExit> {
    const slot = this.require(processRecordId);
    if (slot.settled && slot.finalExit) return slot.finalExit;
    if (!timeoutMs || timeoutMs <= 0) return slot.exit;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        slot.exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ExternalCodingProcessHostError(
            'PROCESS_WAIT_TIMEOUT', `External coding process did not exit within ${timeoutMs}ms`,
          )), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  output(processRecordId: string): ExternalCodingProcessOutput {
    const slot = this.require(processRecordId);
    const stdout = truncateUtf8(redact(slot.rawStdout, slot.canaries), slot.rawLogLimit);
    const remaining = Math.max(0, slot.rawLogLimit - Buffer.byteLength(stdout, 'utf8'));
    const stderr = truncateUtf8(redact(slot.rawStderr, slot.canaries), remaining);
    const text = `${stdout}${stderr}`;
    return {
      text,
      stdout,
      stderr,
      observedBytes: slot.observedBytes,
      storedBytes: Buffer.byteLength(text, 'utf8'),
      truncated: slot.truncated,
    };
  }

  inspect(processRecordId: string): ExternalCodingProcessStatus {
    const slot = this.require(processRecordId);
    if (!slot.settled) refreshOwnedTree(slot);
    return { handle: slot.handle, running: !slot.settled || !ownedTreeDead(slot), output: this.output(processRecordId) };
  }

  active(): readonly ExternalCodingProcessHandle[] {
    return [...this.slots.values()].filter((slot) => !slot.settled || !ownedTreeDead(slot)).map((slot) => slot.handle);
  }

  dispose(processRecordId: string): void {
    const slot = this.require(processRecordId);
    if (!slot.settled || !ownedTreeDead(slot)) {
      throw new ExternalCodingProcessHostError('PROCESS_ACTIVE', 'Cannot dispose an active coding process tree');
    }
    this.slots.delete(processRecordId);
  }

  private require(processRecordId: string): Slot {
    const slot = this.slots.get(processRecordId);
    if (!slot) throw new ExternalCodingProcessHostError('PROCESS_NOT_FOUND', 'External coding process was not found');
    return slot;
  }
}
