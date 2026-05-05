import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import { doctor } from '../../../cli/v4/commands/doctor';
import { allCommands } from '../../../cli/v4/commands';
import {
  CommandRegistry,
  type SlashCommandContext,
} from '../../../cli/v4/commandRegistry';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-doctor-cmd-'));
  // Disable network probes so the test stays hermetic.
  process.env.AIDEN_NO_UPDATE_CHECK = '1';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_NO_UPDATE_CHECK;
});

function captured() {
  const o: any = { out: [], errs: [] };
  o.info = (m: string) => o.out.push('info:' + m);
  o.warn = (m: string) => o.out.push('warn:' + m);
  o.dim = (m: string) => o.out.push('dim:' + m);
  o.write = (m: string) => o.out.push(m);
  o.printError = (...m: string[]) => o.errs.push(m.join(' | '));
  o.success = (m: string) => o.out.push('ok:' + m);
  return o;
}

describe('/doctor slash command', () => {
  it('1. is registered in the system command barrel', () => {
    const found = allCommands.find((c) => c.name === 'doctor');
    expect(found).toBeDefined();
    expect(found?.category).toBe('system');
    expect(found?.description.toLowerCase()).toContain('health');
  });

  it('2. handler emits license + npm update + paths rows', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const display = captured();
    const ctx: SlashCommandContext = {
      args: [],
      rawArgs: '',
      display: display as any,
      registry: new CommandRegistry(),
      paths,
    };
    await doctor.handler(ctx);
    const text = (display.out.join('\n') + '\n' + display.errs.join('\n')).toLowerCase();
    expect(text).toContain('license');
    expect(text).toContain('npm update');
    expect(text).toContain('platform paths');
  });

  it('3. auto-update check is wired into the boot path of aidenCLI', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const src = await fs.readFile(
      path.join(repoRoot, 'cli', 'v4', 'aidenCLI.ts'),
      'utf8',
    );
    // The Phase 20 Task 5 wiring uses setImmediate + dynamic import of
    // checkForUpdate. Either gets renamed in the future without invalidating
    // this guard would still need to keep the symbol referenced from boot.
    expect(src).toContain('setImmediate');
    expect(src).toContain('checkForUpdate');
    expect(src).toContain('formatUpdateLine');
  });
});
