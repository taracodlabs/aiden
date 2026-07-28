/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SkinEngine } from '../../../cli/v4/skinEngine';
import { initializeEffectiveTheme } from '../../../cli/v4/themeCompatibility';
import { getCurrentName, resetToDefault } from '../../../core/v4/theme/themeRegistry';

const cleanup: string[] = [];

afterEach(() => {
  resetToDefault();
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'aiden-effective-theme-'));
  cleanup.push(value);
  return value;
}

describe('effective theme startup compatibility', () => {
  it('migrates a persisted legacy monochrome setting into theme authority', () => {
    const directory = root();
    const skin = new SkinEngine({ forceMono: false });
    skin.setActive('light');

    const result = initializeEffectiveTheme(directory, 'monochrome', skin);

    expect(result).toMatchObject({ name: 'monochrome', source: 'legacy-migration' });
    expect(getCurrentName()).toBe('monochrome');
    expect(skin.getActive().name).toBe('default');
    expect(readFileSync(path.join(directory, 'theme.yaml'), 'utf8')).toMatch(/name:\s*"?monochrome"?/);
  });

  it('gives an existing theme file precedence over a legacy skin setting', () => {
    const directory = root();
    writeFileSync(path.join(directory, 'theme.yaml'), [
      'name: persisted-theme',
      'colors:',
      '  brand:',
      '    primary: "#123456"',
    ].join('\n'), 'utf8');
    const skin = new SkinEngine({ forceMono: false });

    const result = initializeEffectiveTheme(directory, 'light', skin);

    expect(result).toMatchObject({ name: 'persisted-theme', source: 'theme-file' });
    expect(getCurrentName()).toBe('persisted-theme');
    expect(skin.getActive().name).toBe('default');
  });

  it('uses aiden-ember for an unmapped legacy name without creating conflicting state', () => {
    const directory = root();
    const skin = new SkinEngine({ forceMono: false });
    const result = initializeEffectiveTheme(directory, 'old-custom-skin', skin);
    expect(result).toMatchObject({ name: 'aiden-ember', source: 'bundled-default' });
    expect(getCurrentName()).toBe('aiden-ember');
    expect(skin.getActive().name).toBe('default');
  });
});
