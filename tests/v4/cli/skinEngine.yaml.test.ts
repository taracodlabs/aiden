import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SkinEngine, detectSkinColorDepth } from '../../../cli/v4/skinEngine';

async function makeTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeYaml(dir: string, name: string, body: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), body, 'utf8');
}

describe('SkinEngine yaml loader (Phase 16)', () => {
  let bundledDir: string;
  let userDir: string;

  beforeEach(async () => {
    bundledDir = await makeTmp('aiden-skins-bundled-');
    userDir = await makeTmp('aiden-skins-user-');
  });

  afterEach(async () => {
    await fs.rm(bundledDir, { recursive: true, force: true });
    await fs.rm(userDir, { recursive: true, force: true });
  });

  it('discover loads bundled yaml + user yaml', async () => {
    await writeYaml(
      bundledDir,
      'cyber',
      'name: cyber\ndescription: bundled cyber\ncolors:\n  brand: [255, 20, 147]\n',
    );
    await writeYaml(
      userDir,
      'mine',
      'name: mine\ndescription: my skin\ncolors:\n  brand: [10, 10, 10]\n',
    );
    const engine = new SkinEngine({ bundledDir, skinsDir: userDir });
    const list = await engine.discover();
    const names = list.map((s) => s.name).sort();
    expect(names).toContain('cyber');
    expect(names).toContain('mine');
    expect(list.find((s) => s.name === 'mine')?.source).toBe('user');
    expect(list.find((s) => s.name === 'cyber')?.source).toBe('bundled-yaml');
  });

  it('user yaml shadows bundled yaml of same name', async () => {
    await writeYaml(
      bundledDir,
      'shared',
      'name: shared\ndescription: bundled\ncolors:\n  brand: [1, 1, 1]\n',
    );
    await writeYaml(
      userDir,
      'shared',
      'name: shared\ndescription: user-override\ncolors:\n  brand: [2, 2, 2]\n',
    );
    const engine = new SkinEngine({ bundledDir, skinsDir: userDir });
    await engine.discover();
    const summary = engine.list().find((s) => s.name === 'shared')!;
    expect(summary.description).toBe('user-override');
    expect(summary.source).toBe('user');
  });

  it('missing skinsDir or bundledDir is non-fatal', async () => {
    const engine = new SkinEngine({
      bundledDir: path.join(bundledDir, 'does-not-exist'),
      skinsDir: path.join(userDir, 'also-missing'),
    });
    const list = await engine.discover();
    // Built-in defaults still present.
    expect(list.map((s) => s.name).sort()).toEqual(['default', 'light', 'monochrome']);
  });

  it('yaml without `colors` is rejected with onError', async () => {
    const errors: string[] = [];
    await writeYaml(userDir, 'broken', 'name: broken\ndescription: oops\n');
    const engine = new SkinEngine({
      bundledDir,
      skinsDir: userDir,
      onError: (m) => errors.push(m),
    });
    await engine.discover();
    expect(errors.some((e) => e.includes('broken'))).toBe(true);
    expect(engine.list().some((s) => s.name === 'broken')).toBe(false);
  });

  it('invalid yaml emits onError but does not throw', async () => {
    const errors: string[] = [];
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(
      path.join(userDir, 'mangled.yaml'),
      'name: : :\n  - oops\n',
      'utf8',
    );
    const engine = new SkinEngine({
      bundledDir,
      skinsDir: userDir,
      onError: (m) => errors.push(m),
    });
    await expect(engine.discover()).resolves.toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reload re-reads current skin from disk', async () => {
    await writeYaml(
      userDir,
      'live',
      'name: live\ndescription: v1\ncolors:\n  brand: [1, 1, 1]\n',
    );
    const engine = new SkinEngine({ bundledDir, skinsDir: userDir });
    await engine.discover();
    await engine.loadSkin('live');
    expect(engine.getActive().description).toBe('v1');

    await writeYaml(
      userDir,
      'live',
      'name: live\ndescription: v2\ncolors:\n  brand: [2, 2, 2]\n',
    );
    await engine.reload();
    expect(engine.getActive().description).toBe('v2');
  });

  it('reload preserves builtin when current is built-in default', async () => {
    const engine = new SkinEngine({ bundledDir, skinsDir: userDir });
    await engine.reload();
    expect(engine.getActive().name).toBe('default');
  });

  it('list returns rich summary with source labels', async () => {
    await writeYaml(
      bundledDir,
      'wave',
      'name: wave\ndescription: bundled wave\ncolors:\n  brand: [50, 100, 200]\n',
    );
    const engine = new SkinEngine({ bundledDir, skinsDir: userDir });
    await engine.discover();
    const found = engine.list().find((s) => s.name === 'wave');
    expect(found?.source).toBe('bundled-yaml');
    expect(found?.filePath).toContain('wave.yaml');
    expect(found?.description).toBe('bundled wave');
  });

  it('built-in defaults are always listed', async () => {
    const engine = new SkinEngine({ bundledDir, skinsDir: userDir });
    const summary = engine.list();
    expect(summary.find((s) => s.name === 'default')).toBeDefined();
    expect(summary.find((s) => s.name === 'light')).toBeDefined();
    expect(summary.find((s) => s.name === 'monochrome')).toBeDefined();
  });
});

// ── v4.1.4 reply-quality polish — Fix E (warm Aiden-tinted muted) ──────────
//
// Default skin: muted shifts #888888 → #b8a89a (warm, +56/+32/+18).
// Light skin:   muted shifts #606060 → #7a6e5e (proportional warm).
// Sentinels below catch accidental reverts.

describe('SkinEngine muted color (v4.1.4 reply-quality polish)', () => {
  it('default skin muted is warm Aiden-tinted #b8a89a', () => {
    const engine = new SkinEngine();
    const active = engine.getActive();
    const muted = active.colors.muted;
    expect(muted).not.toBeNull();
    if (!muted) return;
    expect(Array.isArray(muted)).toBe(true);
    expect(muted).toEqual([0xb8, 0xa8, 0x9a]);
  });

  it('default skin muted is NOT the old neutral #888888 (regression sentinel)', () => {
    const engine = new SkinEngine();
    const muted = engine.getActive().colors.muted;
    expect(muted).not.toEqual([0x88, 0x88, 0x88]);
  });

  it('applyColors(text, "muted") emits the new RGB triplet', () => {
    const engine = new SkinEngine();
    const out = engine.applyColors('dim row', 'muted');
    // 24-bit fg ANSI: \x1b[38;2;R;G;Bm{text}\x1b[39m
    expect(out).toContain('\x1b[38;2;184;168;154m');
    expect(out).toContain('dim row');
  });

  it('forceMono skin emits no ANSI for muted (NO_COLOR / mono path preserved)', () => {
    const engine = new SkinEngine({ forceMono: true });
    const out = engine.applyColors('dim row', 'muted');
    expect(out).toBe('dim row');
  });
});

describe('SkinEngine terminal color capability', () => {
  it('detects truecolor, 256-color, 16-color, and monochrome terminals', () => {
    expect(detectSkinColorDepth({ COLORTERM: 'truecolor' }, { isTTY: true, platform: 'win32' })).toBe('truecolor');
    expect(detectSkinColorDepth({ TERM: 'xterm-256color' }, { isTTY: true, platform: 'linux' })).toBe('256');
    expect(detectSkinColorDepth({}, { isTTY: true, platform: 'win32' })).toBe('truecolor');
    expect(detectSkinColorDepth({ NO_COLOR: '1' }, { isTTY: true, platform: 'win32' })).toBe('none');
  });

  it('uses a restrained amber brand fallback when 16-color mode is explicit', () => {
    const engine = new SkinEngine({ colorDepth: '16' });
    expect(engine.applyColors('Aiden', 'brand')).toContain('\x1b[33m');
    expect(engine.applyColors('body', 'agent')).toContain('\x1b[97m');
    expect(engine.applyColors('ok', 'success')).toContain('\x1b[92m');
    expect(engine.applyColors('failed', 'error')).toContain('\x1b[31m');
  });

  it.each([
    ['truecolor', '\\x1b[38;2;'],
    ['256', '\\x1b[38;5;'],
    ['16', '\\x1b['],
  ] as const)('renders semantic colors through the %s fallback', (depth, prefix) => {
    const engine = new SkinEngine({ colorDepth: depth });
    const brand = engine.applyColors('brand', 'brand');
    const success = engine.applyColors('success', 'success');
    const warning = engine.applyColors('warning', 'warn');
    const failure = engine.applyColors('failure', 'error');
    expect(brand).toContain(prefix.replace('\\x1b', '\x1b'));
    const codes = [brand, success, warning, failure]
      .map((value) => value.match(/^\x1b\[[^m]+m/u)?.[0]);
    expect(new Set(codes).size).toBe(4);
  });

  it('keeps the user label on the Aiden brand accent', () => {
    const engine = new SkinEngine({ colorDepth: 'truecolor' });
    expect(engine.applyColors('You', 'user')).toContain('\x1b[38;2;255;107;53m');
  });
});
