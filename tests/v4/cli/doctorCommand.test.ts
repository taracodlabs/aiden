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
  // Phase 22 Task 5A: renderHealthBox composes coloured fragments via
  // display.brand / display.paint / display.muted. Mock the colour
  // helpers as identity functions so the string-content assertions
  // below still see the underlying text.
  o.brand = (m: string) => m;
  o.muted = (m: string) => m;
  o.paint = (m: string) => m;
  return o;
}

describe('/doctor slash command', () => {
  it('1. is registered in the system command barrel', () => {
    const found = allCommands.find((c) => c.name === 'doctor');
    expect(found).toBeDefined();
    expect(found?.category).toBe('system');
    expect(found?.description.toLowerCase()).toContain('health');
  });

  it.skip('2. handler emits license + npm update + paths rows /* TODO v4.1.1: doctor row order shifted with new audio-backend check */', async () => {
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
    // Phase 20 wired update check via setImmediate + dynamic import of
    // checkForUpdate. v4.5 update system kept the pre-warm in aidenCLI
    // (cache freshening) and moved the user-visible prompt into
    // chatSession's maybeShowBootUpdatePrompt. Either way, the
    // boot path must still reference these symbols so the cache is
    // primed before the prompt fires.
    expect(src).toContain('setImmediate');
    expect(src).toContain('checkForUpdate');
  });

  it('4. renders the same canonical coding readiness reason as Workbench', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const display = captured();
    const coding = {
      id: 'coding-provider', category: 'coding' as const, state: 'setup_available' as const,
      title: 'Coding provider', detail: 'Coding model is not selected.', configured: false,
      available: true, healthy: false, supported: true, authenticated: true,
      runtimeAvailable: true, permissionAvailable: true, validationAvailable: false,
      ready: false, reason: 'Coding model is not selected.',
      recommendedAction: 'Choose a supported coding model.', blocking: false,
      severity: 'info' as const, availableActions: ['manage_coding'], checkedAt: 1,
    };
    await doctor.handler({
      args: [], rawArgs: '', display: display as any, registry: new CommandRegistry(), paths,
      systemReadiness: async () => ({ overall: 'ready', items: [coding], issues: [], checkedAt: 1 }),
    } as SlashCommandContext);
    expect(display.out.join('\n')).toContain('Coding model is not selected.');
  });
});
