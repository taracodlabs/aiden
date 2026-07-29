/**
 * tests/v4/cli/commands/skin-deprecation.test.ts — v4.9.0 Slice 1a.
 *
 * /skin still works but prints a deprecation pointer to /theme.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skin } from '../../../../cli/v4/commands/skin';
import { SkinEngine } from '../../../../cli/v4/skinEngine';
import { getCurrentName, resetToDefault } from '../../../../core/v4/theme/themeRegistry';

const cleanup: string[] = [];

afterEach(() => {
  resetToDefault();
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('/skin deprecation banner — Slice 1a', () => {
  it('prints deprecation warning regardless of subcommand', async () => {
    const warns: string[] = [];
    const ctx = {
      args: [],
      rawArgs: '',
      paths: { root: '/tmp/x' },
      skin: undefined, // forces the early-return after the warning
      display: {
        warn: (m: string) => warns.push(m),
        info: () => undefined,
        write: () => undefined,
        success: () => undefined,
        printError: () => undefined,
      },
    } as unknown as Parameters<typeof skin.handler>[0];
    await skin.handler(ctx);
    expect(warns.some((m) => /deprecated/.test(m) && /\/theme/.test(m))).toBe(true);
  });

  it('maps legacy names into the effective theme without activating a second palette', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aiden-skin-compat-'));
    cleanup.push(root);
    const engine = new SkinEngine({ forceMono: false });
    const output: string[] = [];
    const ctx = {
      args: ['monochrome'], rawArgs: 'monochrome', paths: { root }, skin: engine,
      display: {
        warn: (message: string) => output.push(message),
        success: (message: string) => output.push(message),
        info: (message: string) => output.push(message),
        write: (message: string) => output.push(message),
        printError: (message: string) => output.push(message),
      },
    } as unknown as Parameters<typeof skin.handler>[0];

    await skin.handler(ctx);

    expect(getCurrentName()).toBe('monochrome');
    expect(engine.getActive().name).toBe('default');
    expect(output.join('\n')).not.toContain('✓ ✓');
  });
});
