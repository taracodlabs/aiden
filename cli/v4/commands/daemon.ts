/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/daemon.ts — v4.5 Phase 4b: `aiden daemon` CLI.
 *
 * Sub-actions:
 *   install     — write platform-appropriate OS service unit + enable
 *   uninstall   — remove unit + disable
 *   start       — foreground supervisor (Phase 1 startSupervisor)
 *   stop        — SIGTERM the daemon via runtime.lock PID
 *   restart     — SIGUSR1 on POSIX → exit 75 → respawn;
 *                 stop+start on Windows (no SIGUSR1)
 *   status      — query /api/daemon/status
 *   logs        — tail recent logs (best-effort, platform-dependent)
 *
 * The OS-level supervisor (systemd/launchd) is the preferred path
 * because it survives logout + reboot. The internal supervisor
 * (start) is the fallback when no service manager exists or when the
 * user doesn't want to install one.
 *
 * Windows install is DOCS-ONLY in v4.5 — NSSM/SCM/Scheduled Task
 * variance + admin requirements make the install footprint too risky
 * for an auto-installer. The docs cover pm2 + foreground patterns.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';

import {
  daemonRuntimeLockPath,
  generateSystemdUnit,
  generateLaunchdPlist,
  startSupervisor,
  windowsServiceGuidance,
  DAEMON_RESTART_EXIT_CODE,
} from '../../../core/v4/daemon';
import {
  getDaemonConfig,
} from '../../../core/v4/daemon';
import { resolveAidenRoot } from '../../../core/v4/paths';

const execFileAsync = promisify(execFile);

export interface DaemonCliOptions {
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
}

const noopOut = (s: string): void => { process.stdout.write(s); };
const noopErr = (s: string): void => { process.stderr.write(s); };

/**
 * Run `aiden daemon <action>` and return the desired process exit code.
 */
export async function runDaemonSubcommand(
  action: string,
  args:   string[],
  opts:   DaemonCliOptions = {},
): Promise<number> {
  const out = opts.writeOut ?? noopOut;
  const err = opts.writeErr ?? noopErr;
  switch (action) {
    case 'install':    return runInstall({ out, err });
    case 'uninstall':  return runUninstall({ out, err });
    case 'start':      return runStart({ out, err });
    case 'stop':       return runStop({ out, err });
    case 'restart':    return runRestart({ out, err });
    case 'status':     return runStatus({ out, err });
    case 'logs':       return runLogs({ out, err });
    case 'doctor': {
      // v4.9.0 Slice 8 — substrate health diagnostic. Read-only by
      // default; `--fix` runs safe sweeps; `--json` outputs machine-
      // parseable shape.
      const { runDaemonDoctor } = await import('./daemonDoctor');
      return runDaemonDoctor({
        json:     args.includes('--json'),
        fix:      args.includes('--fix'),
        writeOut: out,
        writeErr: err,
      });
    }
    default:
      err(`Unknown daemon action: ${action}\n`);
      err('Actions: install, uninstall, start, stop, restart, status, logs, doctor\n');
      return 2;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

interface CtxIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const SYSTEMD_UNIT_NAME = 'aiden.service';
const LAUNCHD_LABEL     = 'com.aiden.daemon';

function systemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

function launchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/**
 * Best-effort: find the Aiden CLI entry point on disk.
 *
 * For packaged installs (`aiden-runtime` npm package), this is the
 * shipped `dist-bundle/index.js`. For local dev (running via
 * `npx tsx cli/v4/aidenCLI.ts`), we fall back to `process.argv[1]`
 * which is the script entry point tsx/node is currently executing.
 */
function findBundlePath(): string {
  // Try the well-known packaged location relative to this file.
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'dist-bundle', 'index.js'),
    path.resolve(__dirname, '..', '..', '..', 'dist-bundle', 'cli.js'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* noop */ }
  }
  // Fallback: whatever the user is running NOW.
  return process.argv[1] ?? path.resolve(__dirname, '..', 'aidenCLI.ts');
}

/**
 * Read the running daemon's PID from the runtime lock file.
 * Returns null when the file doesn't exist or is malformed.
 */
function readRuntimeLockPid(): number | null {
  const lockPath = daemonRuntimeLockPath(resolveAidenRoot());
  try {
    if (!fs.existsSync(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, 'utf-8').trim();
    if (!raw) return null;
    const lines = raw.split(/\r?\n/);
    if (lines.length < 2) return null;
    const pid = Number.parseInt(lines[1], 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/** True when the PID corresponds to a live process. */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';   // exists, not ours
  }
}

/** Poll until the PID is gone, OR timeout expires. */
async function pollUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(250);
  }
  return false;
}

/** Poll /health/live until 200 OR timeout. */
async function pollHealthLive(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await getJson(`http://127.0.0.1:${port}/health/live`, 1_000)
        .then((r) => (r as { ok?: boolean }).ok === true)
        .catch(() => false);
      if (ok) return true;
    } catch { /* noop */ }
    await sleep(250);
  }
  return false;
}

function getJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); if (typeof t.unref === 'function') t.unref(); });
}

// ── install ─────────────────────────────────────────────────────────────────

async function runInstall(io: CtxIO): Promise<number> {
  switch (process.platform) {
    case 'linux': return runInstallLinux(io);
    case 'darwin': return runInstallMacOS(io);
    case 'win32': return runInstallWindows(io);
    default:
      io.err(`Unsupported platform: ${process.platform}\n`);
      io.err('Run `aiden daemon start` to use the internal supervisor in the foreground.\n');
      return 1;
  }
}

async function runInstallLinux(io: CtxIO): Promise<number> {
  const cfg     = getDaemonConfig();
  const nodeBin = process.execPath;
  const bundle  = findBundlePath();
  const unitText = generateSystemdUnit({
    nodeBin,
    bundlePath:     bundle,
    workingDir:     os.homedir(),
    port:           cfg.port,
    drainTimeoutMs: cfg.drainTimeoutMs,
  });
  const unitPath = systemdUnitPath();
  try {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, unitText, { encoding: 'utf-8', mode: 0o644 });
  } catch (e) {
    io.err(`failed to write ${unitPath}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  try {
    await execFileAsync('systemctl', ['--user', 'daemon-reload']);
    await execFileAsync('systemctl', ['--user', 'enable', SYSTEMD_UNIT_NAME]);
  } catch (e) {
    io.err(`systemctl invocation failed: ${e instanceof Error ? e.message : String(e)}\n`);
    io.err('Unit file written but enable/reload step failed. Try manually:\n');
    io.err(`  systemctl --user daemon-reload\n`);
    io.err(`  systemctl --user enable ${SYSTEMD_UNIT_NAME}\n`);
    return 1;
  }
  io.out(`Installed: ${unitPath}\n`);
  io.out(`Start with:   systemctl --user start aiden\n`);
  io.out(`Status:       systemctl --user status aiden\n`);
  io.out(`Restart:      aiden daemon restart  (sends SIGUSR1 → exit ${DAEMON_RESTART_EXIT_CODE} → systemd respawns)\n`);
  return 0;
}

async function runInstallMacOS(io: CtxIO): Promise<number> {
  const cfg     = getDaemonConfig();
  const nodeBin = process.execPath;
  const bundle  = findBundlePath();
  const userPath = captureUserPath();
  const logsDir = path.join(os.homedir(), '.aiden', 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch { /* noop */ }
  const plistText = generateLaunchdPlist({
    nodeBin,
    bundlePath:     bundle,
    workingDir:     os.homedir(),
    port:           cfg.port,
    drainTimeoutMs: cfg.drainTimeoutMs,
    userPath,
    stdoutPath:     path.join(logsDir, 'daemon.out.log'),
    stderrPath:     path.join(logsDir, 'daemon.err.log'),
  });
  const plistPath = launchdPlistPath();
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plistText, { encoding: 'utf-8', mode: 0o644 });
  } catch (e) {
    io.err(`failed to write ${plistPath}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;
  // Idempotent install: bootout (ignore errors — first install
  // won't have a previous bootstrap) then bootstrap.
  try { await execFileAsync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]); } catch { /* noop */ }
  try { await execFileAsync('launchctl', ['bootstrap', domain, plistPath]); }
  catch (e) {
    io.err(`launchctl bootstrap failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  io.out(`Installed: ${plistPath}\n`);
  io.out(`Status:       launchctl print ${domain}/${LAUNCHD_LABEL}\n`);
  io.out(`Restart:      aiden daemon restart  (sends SIGUSR1 → exit ${DAEMON_RESTART_EXIT_CODE} → launchd respawns)\n`);
  return 0;
}

async function runInstallWindows(io: CtxIO): Promise<number> {
  io.out(windowsServiceGuidance());
  io.out('\n');
  io.out('See docs/v4.5/daemon-windows.md for the full walkthrough.\n');
  return 0;
}

// ── uninstall ───────────────────────────────────────────────────────────────

async function runUninstall(io: CtxIO): Promise<number> {
  switch (process.platform) {
    case 'linux': return runUninstallLinux(io);
    case 'darwin': return runUninstallMacOS(io);
    case 'win32':
      io.out('No service installed (Windows install is docs-only — nothing to remove).\n');
      return 0;
    default:
      io.err(`Unsupported platform: ${process.platform}\n`);
      return 1;
  }
}

async function runUninstallLinux(io: CtxIO): Promise<number> {
  const unitPath = systemdUnitPath();
  if (!fs.existsSync(unitPath)) {
    io.out('No systemd unit installed.\n');
    return 0;
  }
  try {
    await execFileAsync('systemctl', ['--user', 'disable', SYSTEMD_UNIT_NAME]);
    await execFileAsync('systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME]).catch(() => undefined);
  } catch { /* unit may not be enabled — fall through */ }
  try { fs.unlinkSync(unitPath); } catch { /* noop */ }
  try { await execFileAsync('systemctl', ['--user', 'daemon-reload']); } catch { /* noop */ }
  io.out(`Uninstalled: ${unitPath}\n`);
  return 0;
}

async function runUninstallMacOS(io: CtxIO): Promise<number> {
  const plistPath = launchdPlistPath();
  if (!fs.existsSync(plistPath)) {
    io.out('No launchd plist installed.\n');
    return 0;
  }
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;
  try { await execFileAsync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]); }
  catch { /* may not be loaded */ }
  try { fs.unlinkSync(plistPath); } catch { /* noop */ }
  io.out(`Uninstalled: ${plistPath}\n`);
  return 0;
}

// ── start (foreground supervisor) ───────────────────────────────────────────

async function runStart(io: CtxIO): Promise<number> {
  io.out('Starting Aiden daemon in foreground (Ctrl+C to stop).\n');
  io.out('Tip: run `aiden daemon install` to register an OS service that\n');
  io.out('     survives logout + reboot (Linux/macOS).\n');
  const cmd: string[] = [process.execPath, findBundlePath()];
  const handle = startSupervisor({
    childCmd: cmd,
    env: {
      AIDEN_DAEMON:               '1',
      // The inner child IS the daemon — disable its own internal
      // supervisor to avoid supervisor-in-supervisor recursion.
      AIDEN_DAEMON_AUTO_RESTART:  '0',
    },
    onChildExit: (code, signal) => io.out(`[supervisor] child exit code=${code} signal=${signal}\n`),
    onRespawn:   (attempt, delayMs) => io.out(`[supervisor] respawn attempt ${attempt} in ${delayMs}ms\n`),
    onGiveUp:    (reason) => io.err(`[supervisor] giving up: ${reason}\n`),
  });
  // Forward signals to the supervisor (which forwards to child).
  const onTerm = (): void => { void handle.stop(); };
  process.once('SIGINT',  onTerm);
  process.once('SIGTERM', onTerm);
  // Hold the event loop until the supervisor stops.
  await new Promise<void>((resolve) => {
    const id = setInterval(() => {
      if (handle.childPid() === null) { clearInterval(id); resolve(); }
    }, 1_000);
    if (typeof id.unref === 'function') id.unref();
  });
  return 0;
}

// ── stop ────────────────────────────────────────────────────────────────────

async function runStop(io: CtxIO): Promise<number> {
  const pid = readRuntimeLockPid();
  if (!pid) {
    io.out('No daemon running.\n');
    return 0;
  }
  if (!isPidAlive(pid)) {
    io.out(`No daemon running (stale lock pid ${pid}).\n`);
    return 0;
  }
  try { process.kill(pid, 'SIGTERM'); }
  catch (e) {
    io.err(`failed to signal pid ${pid}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const drain = getDaemonConfig().drainTimeoutMs;
  const died = await pollUntilDead(pid, drain + 5_000);
  if (!died) {
    io.err(`pid ${pid} did not exit within ${drain + 5_000}ms\n`);
    return 1;
  }
  io.out(`Stopped pid ${pid}\n`);
  return 0;
}

// ── restart ─────────────────────────────────────────────────────────────────

async function runRestart(io: CtxIO): Promise<number> {
  if (process.platform === 'win32') {
    return runRestartWindows(io);
  }
  const pid = readRuntimeLockPid();
  if (!pid) { io.err('No daemon running.\n'); return 1; }
  if (!isPidAlive(pid)) { io.err(`No daemon running (stale lock pid ${pid}).\n`); return 1; }
  try { process.kill(pid, 'SIGUSR1'); }
  catch (e) {
    io.err(`failed to send SIGUSR1 to pid ${pid}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  io.out(`Sent SIGUSR1 to pid ${pid} (graceful drain → exit ${DAEMON_RESTART_EXIT_CODE} → service manager respawns).\n`);
  const drain = getDaemonConfig().drainTimeoutMs;
  const died = await pollUntilDead(pid, drain + 5_000);
  if (!died) {
    io.err(`pid ${pid} did not exit within ${drain + 5_000}ms\n`);
    return 1;
  }
  io.out('Old daemon exited. Waiting for new daemon to come up ...\n');
  const port = getDaemonConfig().port;
  const up = await pollHealthLive(port, 15_000);
  if (!up) {
    io.err(`new daemon did not become live on http://127.0.0.1:${port}/health/live within 15s.\n`);
    io.err('Check service manager logs (systemctl --user status aiden / launchctl print).\n');
    return 1;
  }
  const newPid = readRuntimeLockPid();
  io.out(`Restarted (new pid ${newPid ?? '?'})\n`);
  return 0;
}

async function runRestartWindows(io: CtxIO): Promise<number> {
  io.out('SIGUSR1 not supported on Windows. Doing stop+start sequentially.\n');
  const stopCode = await runStop(io);
  if (stopCode !== 0) return stopCode;
  await sleep(2_000);
  // Re-spawn detached so the CLI can return.
  const cmd: string[] = [process.execPath, findBundlePath()];
  const child = spawn(cmd[0], cmd.slice(1), {
    env:    { ...process.env, AIDEN_DAEMON: '1' },
    stdio:  'ignore',
    detached: true,
  });
  child.unref();
  io.out(`Spawned new daemon (pid ${child.pid ?? '?'}).\n`);
  return 0;
}

// ── status ──────────────────────────────────────────────────────────────────

async function runStatus(io: CtxIO): Promise<number> {
  const port = getDaemonConfig().port;
  try {
    const r = await getJson(`http://127.0.0.1:${port}/api/daemon/status`, 3_000);
    io.out(JSON.stringify(r, null, 2) + '\n');
    return 0;
  } catch (e) {
    io.err(`failed to query http://127.0.0.1:${port}/api/daemon/status: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

// ── logs ────────────────────────────────────────────────────────────────────

async function runLogs(io: CtxIO): Promise<number> {
  // Phase 4b ships a minimal logs surface: locate the platform's
  // log destination + print the last N lines. Tail-follow (`-f`)
  // can come in a Phase 4b.x polish.
  if (process.platform === 'darwin') {
    const f = path.join(os.homedir(), '.aiden', 'logs', 'daemon.out.log');
    return tailFile(f, io);
  }
  if (process.platform === 'linux') {
    try {
      const r = await execFileAsync('journalctl', ['--user', '-u', SYSTEMD_UNIT_NAME, '-n', '200', '--no-pager']);
      io.out(r.stdout);
      return 0;
    } catch (e) {
      io.err(`journalctl failed: ${e instanceof Error ? e.message : String(e)}\n`);
      io.err('Is the service installed? Run `aiden daemon install`.\n');
      return 1;
    }
  }
  io.out('Log destination unknown for this platform. Run the daemon in foreground (`aiden daemon start`) to see live output.\n');
  return 0;
}

function tailFile(filePath: string, io: CtxIO): number {
  if (!fs.existsSync(filePath)) {
    io.out(`No log file at ${filePath} yet.\n`);
    return 0;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const tail = lines.slice(-200).join('\n');
    io.out(tail + '\n');
    return 0;
  } catch (e) {
    io.err(`failed to read ${filePath}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

// ── PATH capture for macOS launchd ──────────────────────────────────────────

/**
 * launchd starts with a minimal `/usr/bin:/bin:/usr/sbin:/sbin` PATH.
 * That misses Homebrew (`/opt/homebrew/bin`), nvm, cargo, etc.
 * Capture the user's login-shell PATH so the daemon can find tools
 * the user expects.
 *
 * Public for tests. Synchronous + best-effort: timeout + fallback
 * to `process.env.PATH`.
 */
export function captureUserPath(): string {
  const shell = process.env.SHELL ?? '/bin/zsh';
  const isFish = shell.endsWith('fish');
  const args   = isFish
    ? ['--login', '-c', 'echo $PATH']
    : ['-lc', 'echo $PATH'];
  try {
    const out = execFileSync(shell, args, {
      encoding: 'utf-8',
      timeout:  5_000,
      stdio:    ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    if (trimmed.length > 0) return trimmed;
  } catch { /* fall through to process.env.PATH */ }
  return process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
}
