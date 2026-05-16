/**
 * v4.5 Phase 4b — Windows install guidance test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runDaemonSubcommand } from '../../../../cli/v4/commands/daemon';

let prevPlatform: PropertyDescriptor | undefined;

function setPlatform(p: NodeJS.Platform): void {
  prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
function restorePlatform(): void {
  if (prevPlatform) Object.defineProperty(process, 'platform', prevPlatform);
}

beforeEach(() => { setPlatform('win32'); });
afterEach(()  => { restorePlatform(); });

function out(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => { lines.push(s); } };
}

describe('aiden daemon install (Windows)', () => {
  it('exits 0 and prints the docs guidance without writing files', async () => {
    const o = out(); const e = out();
    const code = await runDaemonSubcommand('install', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(0);
    const stdout = o.lines.join('');
    expect(stdout).toMatch(/aiden daemon start/i);
    expect(stdout).toMatch(/pm2|nssm|task scheduler/i);
    expect(stdout).toMatch(/daemon-windows\.md/i);
  });

  it('uninstall reports nothing-to-do on Windows', async () => {
    const o = out(); const e = out();
    const code = await runDaemonSubcommand('uninstall', [], { writeOut: o.write, writeErr: e.write });
    expect(code).toBe(0);
    expect(o.lines.join('')).toMatch(/docs-only|nothing to remove/i);
  });
});
