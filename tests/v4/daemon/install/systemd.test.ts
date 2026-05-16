/**
 * v4.5 Phase 4b — systemd installer tests.
 *
 * Verifies the install/uninstall commands write/remove the unit at
 * the right path with the right content and invoke systemctl in the
 * expected order. The test exec()s are mocked via vi.mock so the
 * suite passes on every platform.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.mock must be hoisted — supply the mocked module inline.
const execCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      execCalls.push({ cmd, args });
      cb(null, { stdout: '', stderr: '' });
    },
    execFileSync: (_cmd: string, _args: string[]) => '/mock/path:/usr/bin\n',
    spawn: actual.spawn,
  };
});

import { runDaemonSubcommand } from '../../../../cli/v4/commands/daemon';

let homeOverride: string;
let prevHome: string | undefined;
let prevPlatform: PropertyDescriptor | undefined;

function setPlatform(p: NodeJS.Platform): void {
  prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
function restorePlatform(): void {
  if (prevPlatform) Object.defineProperty(process, 'platform', prevPlatform);
}

beforeEach(() => {
  execCalls.length = 0;
  homeOverride = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-systemd-test-'));
  prevHome = process.env.HOME;
  process.env.HOME = homeOverride;
  // Windows uses USERPROFILE for os.homedir() — set both for safety.
  process.env.USERPROFILE = homeOverride;
  setPlatform('linux');
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  restorePlatform();
  try { fs.rmSync(homeOverride, { recursive: true, force: true }); }
  catch { /* noop */ }
});

function out(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => { lines.push(s); } };
}

describe('aiden daemon install (Linux)', () => {
  it('writes the unit at ~/.config/systemd/user/aiden.service', async () => {
    const o = out();
    const e = out();
    const code = await runDaemonSubcommand('install', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(0);
    const unitPath = path.join(homeOverride, '.config', 'systemd', 'user', 'aiden.service');
    expect(fs.existsSync(unitPath)).toBe(true);
  });

  it('unit content includes RestartForceExitStatus=75', async () => {
    const o = out();
    const e = out();
    await runDaemonSubcommand('install', [], { writeOut: o.write, writeErr: e.write });
    const body = fs.readFileSync(
      path.join(homeOverride, '.config', 'systemd', 'user', 'aiden.service'),
      'utf-8',
    );
    expect(body).toContain('RestartForceExitStatus=75');
    expect(body).toContain('Restart=always');
    expect(body).toContain('ExecReload=/bin/kill -USR1 $MAINPID');
    expect(body).toContain('AIDEN_DAEMON_AUTO_RESTART=0');
  });

  it('invokes systemctl daemon-reload + enable', async () => {
    const o = out();
    const e = out();
    await runDaemonSubcommand('install', [], { writeOut: o.write, writeErr: e.write });
    const cmds = execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c.includes('systemctl --user daemon-reload'))).toBe(true);
    expect(cmds.some((c) => c.includes('systemctl --user enable aiden.service'))).toBe(true);
  });

  it('idempotent — second install overwrites cleanly', async () => {
    const o = out();
    const e = out();
    await runDaemonSubcommand('install', [], { writeOut: o.write, writeErr: e.write });
    execCalls.length = 0;
    const code2 = await runDaemonSubcommand('install', [], { writeOut: o.write, writeErr: e.write });
    expect(code2).toBe(0);
    // Second install still triggers daemon-reload + enable.
    const cmds = execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c.includes('daemon-reload'))).toBe(true);
  });
});

describe('aiden daemon uninstall (Linux)', () => {
  it('removes the unit + calls daemon-reload', async () => {
    const o = out();
    const e = out();
    // Pre-create the unit file.
    const unitPath = path.join(homeOverride, '.config', 'systemd', 'user', 'aiden.service');
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, '[Unit]\nDescription=stub\n');
    const code = await runDaemonSubcommand('uninstall', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(0);
    expect(fs.existsSync(unitPath)).toBe(false);
    const cmds = execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c.includes('disable aiden.service'))).toBe(true);
    expect(cmds.some((c) => c.includes('daemon-reload'))).toBe(true);
  });

  it('no-op when unit not installed', async () => {
    const o = out();
    const e = out();
    const code = await runDaemonSubcommand('uninstall', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(0);
    expect(o.lines.join('')).toMatch(/no systemd unit installed/i);
  });
});
