/**
 * v4.5 Phase 4b — launchd installer tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execCalls: Array<{ cmd: string; args: string[] }> = [];
let capturedShellPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      execCalls.push({ cmd, args });
      cb(null, { stdout: '', stderr: '' });
    },
    execFileSync: (_cmd: string, _args: string[]) => capturedShellPath + '\n',
    spawn: actual.spawn,
  };
});

import { runDaemonSubcommand, captureUserPath } from '../../../../cli/v4/commands/daemon';

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
  homeOverride = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-launchd-test-'));
  prevHome = process.env.HOME;
  process.env.HOME = homeOverride;
  process.env.USERPROFILE = homeOverride;
  setPlatform('darwin');
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

describe('aiden daemon install (macOS)', () => {
  it('writes the plist at ~/Library/LaunchAgents/com.aiden.daemon.plist', async () => {
    const o = out(); const e = out();
    const code = await runDaemonSubcommand('install', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(0);
    const plistPath = path.join(homeOverride, 'Library', 'LaunchAgents', 'com.aiden.daemon.plist');
    expect(fs.existsSync(plistPath)).toBe(true);
  });

  it('plist captures the user PATH', async () => {
    const o = out(); const e = out();
    await runDaemonSubcommand('install', [], { writeOut: o.write, writeErr: e.write });
    const plistPath = path.join(homeOverride, 'Library', 'LaunchAgents', 'com.aiden.daemon.plist');
    const body = fs.readFileSync(plistPath, 'utf-8');
    expect(body).toContain('/opt/homebrew/bin');
    expect(body).toContain('KeepAlive');
    expect(body).toContain('SuccessfulExit');
  });

  it('invokes launchctl bootout THEN bootstrap (idempotent install)', async () => {
    const o = out(); const e = out();
    await runDaemonSubcommand('install', [], { writeOut: o.write, writeErr: e.write });
    const cmds = execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    const boutIdx = cmds.findIndex((c) => c.includes('launchctl bootout'));
    const bstrapIdx = cmds.findIndex((c) => c.includes('launchctl bootstrap'));
    expect(boutIdx).toBeGreaterThanOrEqual(0);
    expect(bstrapIdx).toBeGreaterThanOrEqual(0);
    expect(boutIdx).toBeLessThan(bstrapIdx);
  });
});

describe('aiden daemon uninstall (macOS)', () => {
  it('bootouts + removes the plist', async () => {
    const o = out(); const e = out();
    const plistPath = path.join(homeOverride, 'Library', 'LaunchAgents', 'com.aiden.daemon.plist');
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, '<?xml version="1.0"?><plist><dict/></plist>');
    const code = await runDaemonSubcommand('uninstall', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(0);
    expect(fs.existsSync(plistPath)).toBe(false);
    const cmds = execCalls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds.some((c) => c.includes('launchctl bootout'))).toBe(true);
  });
});

describe('captureUserPath helper', () => {
  it('returns the shell-exported PATH when shell exec succeeds', () => {
    capturedShellPath = '/captured/bin:/other/bin';
    expect(captureUserPath()).toBe('/captured/bin:/other/bin');
    capturedShellPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  });
});
