/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { theme } from '../../../../cli/v4/commands/theme';
import { resetToDefault, getCurrentName } from '../../../../core/v4/theme/themeRegistry';
import { parseThemeYaml } from '../../../../core/v4/theme/themeLoader';
import { getYaml, listBundled } from '../../../../core/v4/theme/bundledThemes';

interface CapturedDisplay {
  info: string[];
  warn: string[];
  success: string[];
  errors: Array<{ msg: string; suggestion?: string }>;
  refreshes: number;
}

function mkCtx(overrides: { paths?: { root: string } | null; rawArgs?: string }) {
  const captured: CapturedDisplay = { info: [], warn: [], success: [], errors: [], refreshes: 0 };
  return {
    captured,
    ctx: {
      args: [], rawArgs: overrides.rawArgs ?? '', paths: overrides.paths,
      display: {
        info: (message: string) => captured.info.push(message),
        warn: (message: string) => captured.warn.push(message),
        success: (message: string) => captured.success.push(message),
        printError: (message: string, suggestion?: string) => captured.errors.push({ msg: message, suggestion }),
        refreshTheme: () => { captured.refreshes += 1; },
      },
    } as unknown as Parameters<typeof theme.handler>[0],
  };
}

describe('Aiden-native bundled themes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'aiden-theme-'));
    resetToDefault();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetToDefault();
  });

  it('/theme list shows the five public bundled themes', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'list' });
    await theme.handler(ctx);
    const output = captured.info.join('\n');
    for (const name of ['aiden-ember', 'midnight', 'aurora', 'monochrome', 'high-contrast']) {
      expect(output).toContain(name);
      expect(output).toContain('(bundled)');
    }
    expect(output).not.toContain('tokyo-night');
    expect(output).not.toContain('dracula');
  });

  it('/theme list includes user themes when present', async () => {
    const userDir = path.join(dir, 'themes');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, 'my-custom.yaml'), 'name: "my-custom"\ndescription: "User test"\n', 'utf8');
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'list' });
    await theme.handler(ctx);
    expect(captured.info.join('\n')).toMatch(/my-custom\s+\(user\)\s+User test/);
  });

  it('/theme set midnight copies bundled YAML and applies it', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set midnight' });
    await theme.handler(ctx);
    const themeFile = path.join(dir, 'theme.yaml');
    expect(existsSync(themeFile)).toBe(true);
    expect(readFileSync(themeFile, 'utf8')).toMatch(/name:\s*"midnight"/);
    expect(getCurrentName()).toBe('midnight');
    expect(captured.success.some((line) => /midnight.*bundled/.test(line))).toBe(true);
    expect(captured.refreshes).toBe(1);
  });

  it('/theme <name> is a direct local selection alias', async () => {
    const { ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'aurora' });
    await theme.handler(ctx);
    expect(getCurrentName()).toBe('aurora');
  });

  it('keeps previously persisted bundled identifiers resolvable', async () => {
    const { ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set tokyo-night' });
    await theme.handler(ctx);
    expect(getCurrentName()).toBe('tokyo-night');
    expect(getYaml('default')).not.toBe(null);
    expect(getYaml('dracula')).not.toBe(null);
  });

  it('/theme set nonexistent reports only the public bundled choices', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set bogus' });
    await theme.handler(ctx);
    expect(captured.errors).toHaveLength(1);
    expect(captured.errors[0].suggestion).toMatch(/aiden-ember.*midnight.*aurora.*monochrome.*high-contrast/);
  });

  it('/theme set resolves a user theme', async () => {
    const userDir = path.join(dir, 'themes');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, 'personal.yaml'), 'name: "personal"\ncolors:\n  brand:\n    primary: "#00FF00"\n', 'utf8');
    const { ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set personal' });
    await theme.handler(ctx);
    expect(getCurrentName()).toBe('personal');
  });

  it('/theme set with no name reports usage', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set' });
    await theme.handler(ctx);
    expect(captured.errors[0].msg).toMatch(/Usage: \/theme set/);
  });
});

describe('bundled theme files', () => {
  const names = ['aiden-ember', 'midnight', 'aurora', 'monochrome', 'high-contrast'] as const;

  it('resolves exactly five public themes', () => {
    expect(listBundled().map((item) => item.name)).toEqual(names);
  });

  for (const name of names) {
    it(`${name} parses cleanly and declares the complete color surface`, () => {
      const yaml = getYaml(name);
      expect(yaml).not.toBe(null);
      const { parsed, warnings } = parseThemeYaml(yaml!);
      expect(parsed?.name).toBe(name);
      expect(warnings).toEqual([]);
      for (const required of [
        'brand.primary', 'brand.muted', 'content.primary', 'content.secondary', 'content.tertiary',
        'semantic.success', 'semantic.warn', 'semantic.error', 'semantic.info',
        'metrics.model', 'metrics.tokens', 'metrics.timer', 'metrics.turnCount',
        'surface.bg', 'surface.elevated', 'surface.border', 'surface.divider',
      ]) expect(parsed!.colorOverrides[required], `missing ${required} in ${name}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  }
});
