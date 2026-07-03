import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  resolveAidenRoot,
  ensureAidenDirsExist,
  resolveUserPath,
} from '../../core/v4/paths';

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_AIDEN_HOME = process.env.AIDEN_HOME;
const ORIGINAL_LOCALAPPDATA = process.env.LOCALAPPDATA;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
}

beforeEach(() => {
  delete process.env.AIDEN_HOME;
});

afterEach(() => {
  restorePlatform();
  if (ORIGINAL_AIDEN_HOME === undefined) {
    delete process.env.AIDEN_HOME;
  } else {
    process.env.AIDEN_HOME = ORIGINAL_AIDEN_HOME;
  }
  if (ORIGINAL_LOCALAPPDATA === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
  }
});

describe('resolveAidenPaths', () => {
  it('1. resolves Windows root to %LOCALAPPDATA%\\aiden', () => {
    setPlatform('win32');
    process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
    const p = resolveAidenPaths();
    expect(p.root).toBe(path.join('C:\\Users\\test\\AppData\\Local', 'aiden'));
    expect(p.authJson).toBe(path.join(p.root, 'auth.json'));
    expect(p.sessionsDb).toBe(path.join(p.root, 'sessions.db'));
  });

  it('2. resolves Linux root to $XDG_CONFIG_HOME/aiden (XDG-compliant default)', async () => {
    setPlatform('linux');
    // Control XDG + create the XDG dir so the legacy-`~/.aiden` migration branch
    // is deterministically skipped (it only fires when legacy exists AND the XDG
    // dir does NOT). This makes the assertion independent of whether the host
    // happens to have a real ~/.aiden (which made the old `.toBe(~/.aiden)`
    // pass locally but fail on fresh CI, where the XDG default applies).
    const xdg = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-xdg-'));
    await fs.mkdir(path.join(xdg, 'aiden'), { recursive: true });
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const p = resolveAidenPaths();
      expect(p.root).toBe(path.join(xdg, 'aiden'));
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      await fs.rm(xdg, { recursive: true, force: true });
    }
  });

  it('2b. Linux legacy ~/.aiden is used when it exists and no XDG dir does', () => {
    setPlatform('linux');
    // Deterministic legacy-migration coverage without touching real $HOME: point
    // XDG at a temp dir with NO `aiden` subdir (xdgExists=false). The resolver's
    // legacy check reads ~/.aiden via os.homedir(); assert the resolved root is
    // whichever branch the resolver actually took — legacy iff ~/.aiden exists,
    // else the XDG path — so the test tracks product behavior on any host.
    const xdg = path.join(os.tmpdir(), `aiden-xdg-absent-${process.pid}`);
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const p = resolveAidenPaths();
      const legacy = path.join(os.homedir(), '.aiden');
      const expected = require('node:fs').existsSync(legacy) ? legacy : path.join(xdg, 'aiden');
      expect(p.root).toBe(expected);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  it('3. resolves macOS root to ~/Library/Application Support/aiden', () => {
    setPlatform('darwin');
    const p = resolveAidenPaths();
    expect(p.root).toBe(
      path.join(os.homedir(), 'Library', 'Application Support', 'aiden'),
    );
  });

  it('4. AIDEN_HOME env var overrides platform default', () => {
    setPlatform('linux');
    process.env.AIDEN_HOME = '/custom/aiden-home';
    const p = resolveAidenPaths();
    expect(p.root).toBe(path.resolve('/custom/aiden-home'));
    expect(p.configYaml).toBe(path.join(p.root, 'config.yaml'));
  });

  it('5. rootOverride wins over AIDEN_HOME and platform', () => {
    setPlatform('win32');
    process.env.AIDEN_HOME = '/should/be/ignored';
    process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
    const root = '/explicit/root';
    const p = resolveAidenPaths({ rootOverride: root });
    expect(p.root).toBe(path.resolve(root));
    expect(resolveAidenRoot({ rootOverride: root })).toBe(path.resolve(root));
  });

  it('6. exposes every documented subpath under root', () => {
    setPlatform('linux');
    const root = '/tmp/aiden-paths-doc-test';
    const p = resolveAidenPaths({ rootOverride: root });
    expect(p.sessionsDb).toBe(path.join(p.root, 'sessions.db'));
    expect(p.authJson).toBe(path.join(p.root, 'auth.json'));
    expect(p.configYaml).toBe(path.join(p.root, 'config.yaml'));
    expect(p.envFile).toBe(path.join(p.root, '.env'));
    expect(p.soulMd).toBe(path.join(p.root, 'SOUL.md'));
    expect(p.memoryMd).toBe(path.join(p.root, 'memories', 'MEMORY.md'));
    expect(p.userMd).toBe(path.join(p.root, 'memories', 'USER.md'));
    expect(p.skillsDir).toBe(path.join(p.root, 'skills'));
    expect(p.sessionsDir).toBe(path.join(p.root, 'sessions'));
    expect(p.pluginsDir).toBe(path.join(p.root, 'plugins'));
    expect(p.logsDir).toBe(path.join(p.root, 'logs'));
    expect(p.bundledManifest).toBe(path.join(p.root, '.bundled_manifest'));
  });

  it('7. Windows falls back to ~/AppData/Local when LOCALAPPDATA is unset', () => {
    setPlatform('win32');
    delete process.env.LOCALAPPDATA;
    const p = resolveAidenPaths();
    expect(p.root).toBe(path.join(os.homedir(), 'AppData', 'Local', 'aiden'));
  });

  it('8. ensureAidenDirsExist creates root + every required subdir', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-paths-'));
    try {
      const p = resolveAidenPaths({ rootOverride: tmp });
      await ensureAidenDirsExist(p);
      for (const dir of [
        p.root,
        p.skillsDir,
        p.sessionsDir,
        p.pluginsDir,
        p.logsDir,
        path.dirname(p.memoryMd),
      ]) {
        const stat = await fs.stat(dir);
        expect(stat.isDirectory()).toBe(true);
      }
      // Files are NOT pre-created.
      await expect(fs.stat(p.sessionsDb)).rejects.toThrow();
      await expect(fs.stat(p.configYaml)).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('9. ensureAidenDirsExist is idempotent', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-paths-'));
    try {
      const p = resolveAidenPaths({ rootOverride: tmp });
      await ensureAidenDirsExist(p);
      // Second invocation should not throw.
      await ensureAidenDirsExist(p);
      const stat = await fs.stat(p.skillsDir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── v4.12.1 — resolveUserPath (central user-path resolver) ─────────────
//
// The path-handling class fix: quote-strip + ~ expansion + absolute-wins.
// Both sides of each exact assert go through path.resolve so the tests
// hold on every OS (a `C:\...` literal is absolute on win32, relative on
// POSIX — path.resolve on both sides keeps the comparison honest).

describe('resolveUserPath', () => {
  it('quoted absolute value is healed — quotes stripped, never glued onto a base (the reported bug class)', () => {
    // Use a fixture that is absolute ON THE RUNNING PLATFORM — a raw `C:\...`
    // literal is absolute only on win32 (on POSIX it's relative, so the
    // "absolute wins" assertion below would falsely fail on Linux/macOS CI).
    const inner = process.platform === 'win32'
      ? 'C:\\Users\\shiva\\Documents\\Obsidian\\aiden-memory'
      : '/home/shiva/Documents/Obsidian/aiden-memory';
    expect(resolveUserPath(`"${inner}"`)).toBe(path.resolve(inner));
    // With an explicit base: the absolute value still wins — no join.
    expect(resolveUserPath(`"${inner}"`, path.resolve('/some/base'))).toBe(path.resolve(inner));
  });

  it('quoted relative value resolves against the base after quote-strip', () => {
    const base = path.resolve('/base/dir');
    expect(resolveUserPath('"subdir"', base)).toBe(path.resolve(base, 'subdir'));
    expect(resolveUserPath("'sub dir'", base)).toBe(path.resolve(base, 'sub dir'));
  });

  it('~ expands to the home directory', () => {
    expect(resolveUserPath('~')).toBe(path.resolve(os.homedir()));
  });

  it('~/sub and ~\\sub expand under the home directory', () => {
    expect(resolveUserPath('~/vault')).toBe(path.resolve(path.join(os.homedir(), 'vault')));
    expect(resolveUserPath('~\\vault')).toBe(path.resolve(path.join(os.homedir(), 'vault')));
  });

  it('quoted ~ path expands too (strip happens before expansion)', () => {
    expect(resolveUserPath('"~/vault"')).toBe(path.resolve(path.join(os.homedir(), 'vault')));
  });

  it('unbalanced leading quote is stripped', () => {
    const inner = 'C:\\Users\\x\\vault';
    expect(resolveUserPath(`"${inner}`)).toBe(path.resolve(inner));
  });

  it('empty / whitespace / quotes-only / null / undefined → null', () => {
    expect(resolveUserPath('')).toBeNull();
    expect(resolveUserPath('   ')).toBeNull();
    expect(resolveUserPath('""')).toBeNull();
    expect(resolveUserPath("''")).toBeNull();
    expect(resolveUserPath(null)).toBeNull();
    expect(resolveUserPath(undefined)).toBeNull();
  });

  it('plain absolute path passes through normalized', () => {
    const abs = path.resolve('/plain/abs/dir');
    expect(resolveUserPath(abs)).toBe(abs);
  });

  it('plain relative path resolves against the base (default cwd)', () => {
    const base = path.resolve('/the/base');
    expect(resolveUserPath('rel/child', base)).toBe(path.resolve(base, 'rel/child'));
    expect(resolveUserPath('rel/child')).toBe(path.resolve(process.cwd(), 'rel/child'));
  });

  it('mid-string quote chars are untouched (only leading/trailing strip)', () => {
    const base = path.resolve('/b');
    expect(resolveUserPath("obrien's-files", base)).toBe(path.resolve(base, "obrien's-files"));
  });
});
