/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/dockerSession.ts — v4.4 Phase 3: long-lived sandbox container
 * lifecycle + reuse cache.
 *
 * One long-lived `docker run -d ... sleep` container is created per
 * session and reused across every `shell_exec` call within that
 * session. Per-command execution goes through `docker exec` — orders
 * of magnitude faster than the old single-shot `docker run --rm`
 * pattern (no image-resolution, no namespace setup, no teardown
 * per call).
 *
 * Lifecycle:
 *   - first exec for a sessionId  → start container (`docker run -d`),
 *                                  cache the handle, run `docker exec`.
 *   - subsequent execs            → reuse the cached container.
 *   - idle past `idleReaperMs`    → background reaper stops + removes.
 *   - SIGINT / SIGTERM / beforeExit → reapAllContainers() (parallel
 *                                  best-effort, never blocks shutdown).
 *
 * Concurrency:
 *   - Stampede defense: every handle carries an in-flight `starting`
 *     promise. A second caller that finds an existing handle with
 *     `starting != null` awaits it before proceeding.
 *   - Reaper is fire-and-forget; mark the handle `reaped: true` first,
 *     then `docker stop` async. Racing callers either find `reaped`
 *     and create a new container, or hit a dead container in
 *     `docker exec` and we restart.
 *
 * Local fallback (Q-P3-5):
 *   - When `isDockerAvailable() === false`, route through
 *     `localBackendExecute` and emit a one-time warning per session.
 *     The returned `backend` field stays `'local'` so traces are
 *     honest about what actually ran.
 *
 * Hardening flags applied unconditionally:
 *   --cap-drop ALL
 *   --security-opt no-new-privileges
 *   --pids-limit <config>
 *   --memory <config>
 *   --cpus <config>
 *   --tmpfs /tmp:rw,size=256m
 *   --tmpfs /var/tmp:rw,size=64m
 *   --tmpfs /run:rw,size=16m
 *   --network <bridge|none>
 *   -v cwd:/workspace            (only when persistent === true)
 *   --tmpfs /workspace:rw,...    (only when persistent === false)
 *
 * Gated by `config.enabled` (AIDEN_SANDBOX=1 strict in Phase 1-5).
 * The status-quo single-shot `dockerBackendExecute` in
 * `tools/v4/backends/docker.ts` is retained for the `AIDEN_SANDBOX=0
 * + ctx.terminalBackend='docker'` path — zero regression there.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import {
  getSandboxConfig,
  type SandboxConfig,
} from './sandboxConfig';
import {
  type ShellExecArgs,
  type ShellExecResult,
  type LocalBackendCallbacks,
  localBackendExecute,
} from '../../tools/v4/backends/local';

// ── Public surface ──────────────────────────────────────────────────────────

export interface DockerExecArgs extends ShellExecArgs {
  /** Session id from `ToolContext`. Defaults to `'default'` when unset. */
  sessionId?: string;
  /** Per-call image override (rare — usually inherits config.image). */
  image?: string;
}

interface ContainerHandle {
  id:          string;
  sessionId:   string;
  image:       string;
  cwd:         string;
  persistent:  boolean;
  startedAt:   number;
  lastUsedAt:  number;
  starting?:   Promise<void>;
  reaped:      boolean;
  /** Whether we already emitted the local-fallback warning. */
  warnedFallback: boolean;
}

// ── Module state ────────────────────────────────────────────────────────────

const _containers: Map<string, ContainerHandle> = new Map();
/** Sessions for which we already logged the local-fallback warning. */
const _warnedFallback: Set<string> = new Set();

let _reaperInterval: NodeJS.Timeout | null = null;
let _shutdownHookInstalled = false;

// ── Docker availability cache (60s) ─────────────────────────────────────────

let _dockerAvailCache: { ts: number; value: boolean } | null = null;
const DOCKER_AVAIL_TTL = 60_000;

function isDockerAvailableCached(): boolean {
  const now = Date.now();
  if (_dockerAvailCache && now - _dockerAvailCache.ts < DOCKER_AVAIL_TTL) {
    return _dockerAvailCache.value;
  }
  let value = false;
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 3000,
      stdio:   'pipe',
    });
    value = r.status === 0;
  } catch {
    value = false;
  }
  _dockerAvailCache = { ts: now, value };
  return value;
}

/** Test-only — clears the docker-availability cache. */
export function _clearDockerAvailCacheForTests(): void {
  _dockerAvailCache = null;
}

// ── Container start ─────────────────────────────────────────────────────────

function shortId(): string {
  return randomBytes(4).toString('hex');
}

function buildRunArgs(opts: {
  config:     SandboxConfig;
  image:      string;
  cwd:        string;
  name:       string;
  persistent: boolean;
}): string[] {
  const args = [
    'run',
    '-d',
    '--name',                 opts.name,
    '--cap-drop',             'ALL',
    '--security-opt',         'no-new-privileges',
    '--pids-limit',           String(opts.config.resourceLimits.pidsLimit),
    '--memory',               opts.config.resourceLimits.memory,
    '--cpus',                 opts.config.resourceLimits.cpus,
    '--tmpfs',                '/tmp:rw,size=256m',
    '--tmpfs',                '/var/tmp:rw,size=64m',
    '--tmpfs',                '/run:rw,size=16m',
    '--network',              opts.config.networkMode,
  ];
  if (opts.persistent) {
    args.push('-v', `${opts.cwd}:/workspace`);
  } else {
    args.push('--tmpfs', '/workspace:rw,size=512m');
  }
  args.push('-w', '/workspace');
  args.push(opts.image);
  // sleep loop — busybox `sleep infinity` isn't portable; use a loop
  // so plain alpine images work without GNU coreutils.
  args.push('sh', '-c', 'while true; do sleep 3600; done');
  return args;
}

async function startContainer(
  sessionId:  string,
  image:      string,
  cwd:        string,
  persistent: boolean,
  config:     SandboxConfig,
): Promise<string> {
  const name = `aiden-sbx-${sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 32)}-${shortId()}`;
  const args = buildRunArgs({ config, image, cwd, name, persistent });
  return new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, 120_000);  // first run may pull the image
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`docker run failed: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('docker run timed out (120s)'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`docker run exited ${code}: ${stderr.trim()}`));
        return;
      }
      const id = stdout.trim().split(/\s+/)[0];
      if (!id) {
        reject(new Error('docker run produced no container id'));
        return;
      }
      resolve(id);
    });
  });
}

// ── Container exec ──────────────────────────────────────────────────────────

function execInContainer(
  handle:    ContainerHandle,
  args:      DockerExecArgs,
  cb:        LocalBackendCallbacks,
): Promise<ShellExecResult> {
  handle.lastUsedAt = Date.now();
  const timeoutMs = args.timeoutMs ?? 30_000;
  const capture   = args.captureOutput ?? true;
  const start     = Date.now();

  const execArgs = ['exec', '-i'];
  if (args.env) {
    for (const [k, v] of Object.entries(args.env)) {
      execArgs.push('-e', `${k}=${v}`);
    }
  }
  execArgs.push(handle.id, 'sh', '-c', args.command);

  return new Promise<ShellExecResult>((resolve) => {
    const child = spawn('docker', execArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
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
        exitCode:   -1,
        stdout,
        stderr:     stderr || err.message,
        durationMs: Date.now() - start,
        timedOut,
        backend:    'docker',
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode:   typeof code === 'number' ? code : -1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
        backend:    'docker',
      });
    });
  });
}

// ── Public exec entry point ─────────────────────────────────────────────────

/**
 * Execute a command inside the long-lived sandbox container for the
 * given session. Starts a new container if none exists, reuses
 * otherwise. Falls back to the local backend when Docker isn't
 * available, warning once per session.
 */
export async function dockerSessionExec(
  args: DockerExecArgs,
  cb:   LocalBackendCallbacks = {},
): Promise<ShellExecResult> {
  const config    = getSandboxConfig();
  const sessionId = args.sessionId ?? 'default';
  const cwd       = args.cwd ?? process.cwd();
  const image     = args.image ?? config.image;

  // Local fallback when Docker isn't reachable.
  if (!isDockerAvailableCached()) {
    if (!_warnedFallback.has(sessionId)) {
      _warnedFallback.add(sessionId);
      cb.log?.(
        'warn',
        'Sandbox: Docker is not running or unreachable. ' +
        'Falling back to local backend for this session — resource ' +
        'limits and isolation are NOT enforced.',
      );
    }
    return localBackendExecute(
      {
        command:       args.command,
        cwd,
        env:           args.env,
        timeoutMs:     args.timeoutMs,
        captureOutput: args.captureOutput,
      },
      cb,
    );
  }

  // Opportunistic idle sweep on the active path (Q-P3-4 hybrid).
  sweepIdleAsync(config);

  // Hot path — reuse existing container if any.
  let handle = _containers.get(sessionId);
  if (handle && !handle.reaped) {
    if (handle.starting) {
      try { await handle.starting; }
      catch {
        // start failed; drop the handle and fall through to restart.
        _containers.delete(sessionId);
        handle = undefined;
      }
    }
  }
  if (!handle || handle.reaped) {
    // Start a new container.
    const newHandle: ContainerHandle = {
      id:             '',
      sessionId,
      image,
      cwd,
      persistent:     config.persistent,
      startedAt:      Date.now(),
      lastUsedAt:     Date.now(),
      reaped:         false,
      warnedFallback: false,
    };
    let resolveStart: () => void = () => undefined;
    let rejectStart:  (e: Error) => void = () => undefined;
    newHandle.starting = new Promise<void>((res, rej) => {
      resolveStart = res; rejectStart = rej;
    });
    _containers.set(sessionId, newHandle);
    armReaperIfNeeded();
    try {
      const id = await startContainer(
        sessionId,
        image,
        cwd,
        config.persistent,
        config,
      );
      newHandle.id       = id;
      newHandle.starting = undefined;
      resolveStart();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      _containers.delete(sessionId);
      rejectStart(err);
      return {
        exitCode:   -1,
        stdout:     '',
        stderr:     `Sandbox: failed to start container: ${err.message}`,
        durationMs: 0,
        timedOut:   false,
        backend:    'docker',
      };
    }
    handle = newHandle;
  }

  return execInContainer(handle, args, cb);
}

// ── Idle reaper ─────────────────────────────────────────────────────────────

function sweepIdleAsync(config: SandboxConfig): void {
  const now = Date.now();
  for (const handle of _containers.values()) {
    if (handle.starting) continue;
    if (handle.reaped)   continue;
    if (now - handle.lastUsedAt > config.idleReaperMs) {
      // Fire-and-forget.
      void reapSessionContainer(handle.sessionId);
    }
  }
}

function armReaperIfNeeded(): void {
  if (_reaperInterval) return;
  _reaperInterval = setInterval(() => {
    try {
      sweepIdleAsync(getSandboxConfig());
      if (_containers.size === 0 && _reaperInterval) {
        clearInterval(_reaperInterval);
        _reaperInterval = null;
      }
    } catch {
      /* never let the reaper crash the process */
    }
  }, 30_000);
  // Don't keep the process alive just for the reaper.
  if (typeof _reaperInterval.unref === 'function') {
    _reaperInterval.unref();
  }
  installShutdownHook();
}

function installShutdownHook(): void {
  if (_shutdownHookInstalled) return;
  _shutdownHookInstalled = true;
  const handler = (): void => {
    // Fire-and-forget — never block shutdown.
    void reapAllContainers();
  };
  process.once('beforeExit', handler);
  process.once('SIGINT',     () => { handler(); });
  process.once('SIGTERM',    () => { handler(); });
}

// ── Reap APIs ───────────────────────────────────────────────────────────────

function dockerStopRemove(id: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // -t 2: 2-second grace period before SIGKILL.
    const stop = spawn('docker', ['stop', '-t', '2', id], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { stop.kill('SIGKILL'); } catch { /* ignore */ }
    }, 5000);
    stop.on('close', () => {
      clearTimeout(timer);
      const rm = spawn('docker', ['rm', '-f', id], { stdio: 'ignore' });
      const rmTimer = setTimeout(() => {
        try { rm.kill('SIGKILL'); } catch { /* ignore */ }
      }, 3000);
      rm.on('close', () => { clearTimeout(rmTimer); resolve(); });
      rm.on('error', () => { clearTimeout(rmTimer); resolve(); });
    });
    stop.on('error', () => { clearTimeout(timer); resolve(); });
  });
}

/** Reap one session's container. Idempotent + fire-and-forget safe. */
export async function reapSessionContainer(sessionId: string): Promise<void> {
  const handle = _containers.get(sessionId);
  if (!handle) return;
  if (handle.reaped) return;
  handle.reaped = true;
  _containers.delete(sessionId);
  if (handle.id) {
    try { await dockerStopRemove(handle.id); } catch { /* never throw on cleanup */ }
  }
}

/** Reap every cached container. Used by shutdown hooks. */
export async function reapAllContainers(): Promise<void> {
  const ids = Array.from(_containers.keys());
  await Promise.all(ids.map((sid) => reapSessionContainer(sid)));
  if (_reaperInterval) {
    clearInterval(_reaperInterval);
    _reaperInterval = null;
  }
}

// ── Test helpers ────────────────────────────────────────────────────────────

/** Test-only — synchronously wipe in-memory state. Does NOT call docker. */
export function _resetDockerSessionForTests(): void {
  _containers.clear();
  _warnedFallback.clear();
  if (_reaperInterval) {
    clearInterval(_reaperInterval);
    _reaperInterval = null;
  }
  _dockerAvailCache = null;
}

/** Test-only — inspect the cache state. */
export function _inspectDockerSessionsForTests(): {
  count:       number;
  sessionIds:  string[];
  warnedSessions: string[];
} {
  return {
    count:          _containers.size,
    sessionIds:     Array.from(_containers.keys()),
    warnedSessions: Array.from(_warnedFallback),
  };
}

/**
 * Test-only — inject a fake docker-availability decision so unit
 * tests can exercise the local-fallback warn-once path without
 * actually probing docker.
 */
export function _setDockerAvailableForTests(value: boolean): void {
  _dockerAvailCache = { ts: Date.now(), value };
}
