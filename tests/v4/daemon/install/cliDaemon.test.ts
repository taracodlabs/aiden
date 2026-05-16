/**
 * v4.5 Phase 4b — cli daemon start/stop/restart/status tests.
 *
 * These exercise the command-surface integration. The actual signal
 * + process spawning is best-effort isolated via platform overrides
 * and mocks where useful.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '', stderr: '' });
      void cmd; void args;
    },
    execFileSync: (_cmd: string, _args: string[]) => '/usr/bin:/bin\n',
    // Don't mock spawn — daemon start would need it, but those tests
    // assert *immediate* behavior (returns 2 on unknown action),
    // not the full lifecycle.
    spawn: actual.spawn,
  };
});

import {
  runDaemonSubcommand,
} from '../../../../cli/v4/commands/daemon';

let homeOverride: string;
let prevHome: string | undefined;

beforeEach(() => {
  homeOverride = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-cli-d-'));
  prevHome = process.env.HOME;
  process.env.HOME = homeOverride;
  process.env.USERPROFILE = homeOverride;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  try { fs.rmSync(homeOverride, { recursive: true, force: true }); }
  catch { /* noop */ }
});

function out(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => { lines.push(s); } };
}

describe('runDaemonSubcommand — unknown action', () => {
  it('exits 2 + lists valid actions', async () => {
    const o = out(); const e = out();
    const code = await runDaemonSubcommand('garbage', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(2);
    expect(e.lines.join('')).toMatch(/install.*uninstall.*start.*stop.*restart.*status.*logs/i);
  });
});

describe('runDaemonSubcommand — stop with no daemon', () => {
  it('returns 0 + reports no-daemon when runtime.lock is absent', async () => {
    const o = out(); const e = out();
    const code = await runDaemonSubcommand('stop', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(0);
    expect(o.lines.join('')).toMatch(/no daemon running/i);
  });

  it('handles stale lock file (dead PID) gracefully', async () => {
    // Pre-create a stale lock file pointing at a definitely-dead PID.
    const lockPath = path.join(homeOverride, '.config', 'aiden', 'daemon', 'runtime.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'stale-instance\n999999\n12345\n');
    const o = out(); const e = out();
    const code = await runDaemonSubcommand('stop', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(0);
    expect(o.lines.join('')).toMatch(/stale lock|no daemon running/i);
  });
});

describe('runDaemonSubcommand — restart with no daemon', () => {
  it('errors with 1 when runtime.lock is absent (POSIX path)', async () => {
    if (process.platform === 'win32') return;   // Windows restart path is different
    const o = out(); const e = out();
    const code = await runDaemonSubcommand('restart', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(1);
    expect(e.lines.join('')).toMatch(/no daemon running/i);
  });
});

describe('runDaemonSubcommand — status', () => {
  it('errors with 1 when /api/daemon/status not reachable', async () => {
    // No daemon running → http call fails immediately.
    process.env.AIDEN_DAEMON_PORT = '4988';   // unlikely to clash
    try {
      const o = out(); const e = out();
      const code = await runDaemonSubcommand('status', [], { writeOut: o.write, writeErr: e.write });
      expect(code).toBe(1);
      expect(e.lines.join('')).toMatch(/failed to query/i);
    } finally {
      delete process.env.AIDEN_DAEMON_PORT;
    }
  });
});

describe('runDaemonSubcommand — logs', () => {
  it('reports unknown destination on Windows (no journalctl, no plist log)', async () => {
    const prev = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const o = out(); const e = out();
      const code = await runDaemonSubcommand('logs', [], { writeOut: o.write, writeErr: e.write });
      expect(code).toBe(0);
      expect(o.lines.join('')).toMatch(/log destination unknown/i);
    } finally {
      if (prev) Object.defineProperty(process, 'platform', prev);
    }
  });

  it('returns 0 and shows "no log file" when path absent on macOS', async () => {
    const prev = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const o = out(); const e = out();
      const code = await runDaemonSubcommand('logs', [], { writeOut: o.write, writeErr: e.write });
      expect(code).toBe(0);
      expect(o.lines.join('')).toMatch(/no log file/i);
    } finally {
      if (prev) Object.defineProperty(process, 'platform', prev);
    }
  });
});
