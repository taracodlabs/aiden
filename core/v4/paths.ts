/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/paths.ts — Aiden v4.0.0
 *
 * Cross-platform path constants for Aiden user data.
 *
 * Layout (per docs/v4.0.0-architecture.md "Cross-platform strategy"):
 *
 *   Windows : %LOCALAPPDATA%\aiden\
 *             (fallback %USERPROFILE%\AppData\Local\aiden\ when LOCALAPPDATA
 *              is unset, e.g. cygwin/MINGW shells without env passthrough)
 *   Linux   : ~/.aiden/
 *   macOS   : ~/Library/Application Support/aiden/
 *
 * `AIDEN_HOME` env var overrides everything (single source of truth, used
 * for tests, Docker overlays, multi-profile workflows). When set we never
 * touch the platform-specific defaults.
 *
 * Native Windows paths are first-class — Aiden does not require WSL
 * or a Unix-flavoured home dir.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Resolved on-disk paths for the Aiden user-data root and every subpath
 * the v4 runtime touches.  Members are absolute paths.
 */
export interface AidenPaths {
  /** Aiden user-data root. Platform-specific unless overridden via AIDEN_HOME. */
  root: string;
  /** SQLite session/message database (Phase 6+). */
  sessionsDb: string;
  /** OAuth + API key store (managed by CredentialResolver, Phase 4+). */
  authJson: string;
  /** User-editable config (Phase 6+). */
  configYaml: string;
  /** Secret env file (Phase 6+). */
  envFile: string;
  /** Phase 16f: persistent approval allowlist — `[{tool, signature}]`. */
  approvalsJson: string;
  /** Identity prompt slot #1 (Phase 9+). */
  soulMd: string;
  /** Agent's curated environment notes (Phase 6+). */
  memoryMd: string;
  /** User profile / preferences (Phase 6+). */
  userMd: string;
  /** root/skills/ — bundled + user skills. */
  skillsDir: string;
  /** root/personalities/ — user personality `.md` overlays (Phase 16). */
  personalitiesDir: string;
  /** root/skins/ — user skin `.yaml` themes (Phase 16). */
  skinsDir: string;
  /** root/.recent-commands.json — per-user slash command history (Phase 16). */
  recentCommandsFile: string;
  /**
   * root/sessions/ — legacy file-based session jsonl directory.  Phase 6+
   * persists messages to sessions.db; this dir may remain empty but the
   * path is exposed for migration tooling and aiden doctor.
   */
  sessionsDir: string;
  /**
   * v4.9.0 Slice 9 — root/distillations/ holds per-session JSON
   * distillations consumed by `recall_session`. Previously reconstructed
   * ad-hoc at the `recallSession.ts` call site; now centralised here so
   * any consumer can reach it via the paths object.
   */
  distillationsDir: string;
  /**
   * v4.9.0 Slice 9 — root/memory-backups/<YYYYMMDD-HHMMSS>/ holds
   * `aiden memory backup` snapshots. Per-snapshot subdirs carry
   * `memory.md` + `user.md` + `manifest.json`.
   */
  memoryBackupsDir: string;
  /** root/plugins/ — third-party plugins. */
  pluginsDir: string;
  /** root/logs/ — auto-redacted runtime logs. */
  logsDir: string;
  /** root/.bundled_manifest — sha map of skills shipped with the package. */
  bundledManifest: string;
  /**
   * root/.skills-bundle-version — single-line text file recording the
   * package version whose bundled skills were last synced into
   * `skillsDir`. On boot, syncBundledSkillsIfStale compares this to the
   * current package.json version and re-copies bundled skills (skipping
   * user-modified ones per BundledManifest) when they differ. Phase 22
   * Group C smoke-fix #2 — without this, bundle-side description /
   * SKILL.md updates never reached existing installs.
   */
  skillsBundleVersion: string;
}

export interface ResolveAidenPathsOptions {
  /**
   * Hard override for the root.  When provided, every returned path is
   * computed from this directory and AIDEN_HOME / platform defaults are
   * ignored.  Tests use this for isolation.
   */
  rootOverride?: string;
}

/**
 * v4.12.1 — central resolver for USER-SUPPLIED paths (env vars, config
 * values, slash-command args). Fixes a path-handling class bug: a value
 * carrying literal surrounding quotes (e.g. `"C:\Users\me\Obsidian"` baked
 * in by `setx`, a hand-edited config, or a quoted slash arg) does not start
 * with a root, so `path.resolve` classified it RELATIVE and glued it onto
 * the base — producing `C:\...\DevOS\"C:\Users\...`. Same class: `~/vault`
 * resolved to a literal `<cwd>/~/vault` directory on every OS.
 *
 * Pipeline: trim → strip leading/trailing quote chars → expand `~` /
 * `~/…` / `~\…` via os.homedir() → empty → null → resolve (absolute value
 * wins as-is and is normalized; relative resolves against `baseDir`,
 * default cwd). Separators normalize per-OS via path.resolve.
 *
 * Trade-off (documented, accepted): a POSIX name genuinely ENDING in a
 * quote char would be stripped — vanishingly rare vs. the paste-artifact
 * frequency. Mid-string quotes (O'Brien) are untouched.
 *
 * Every site consuming a user-controlled path routes through this helper;
 * do not hand-roll `path.join(base, userValue)` for config/env paths.
 */
export function resolveUserPath(
  raw: string | undefined | null,
  baseDir?: string,
): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  s = s.replace(/^["']+/, '').replace(/["']+$/, '').trim();
  if (s.length === 0) return null;
  if (s === '~') {
    s = os.homedir();
  } else if (s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(os.homedir(), s.slice(2));
  }
  // path.resolve ignores baseDir when `s` is fully absolute, completes
  // drive-relative forms (`/x` on Windows), and normalizes separators.
  return path.resolve(baseDir ?? process.cwd(), s);
}

/** Compute the Aiden user-data root without computing the rest of the layout. */
export function resolveAidenRoot(opts: ResolveAidenPathsOptions = {}): string {
  if (opts.rootOverride && opts.rootOverride.length > 0) {
    return path.resolve(opts.rootOverride);
  }

  // v4.12.1 — routed through resolveUserPath so a quoted / ~-prefixed
  // AIDEN_HOME cannot glue the entire data root onto the cwd.
  const fromEnv = resolveUserPath(process.env.AIDEN_HOME);
  if (fromEnv) {
    return fromEnv;
  }

  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA;
      const base =
        localAppData && localAppData.length > 0
          ? localAppData
          : path.join(home, 'AppData', 'Local');
      return path.join(base, 'aiden');
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'aiden');
    case 'linux':
    default: {
      // Phase 19: honor XDG_CONFIG_HOME on Linux + other POSIX-likes,
      // default to freedesktop-spec `~/.config/aiden` for XDG
      // compliance. Migration: if a legacy `~/.aiden` dir exists and
      // the XDG path doesn't, prefer the legacy dir
      // so a power user mid-migration is not surprised. AIDEN_HOME
      // env override above wins regardless.
      // v4.12.1 — XDG_CONFIG_HOME routed through resolveUserPath (quote
      // strip + ~ expansion) like every other user-supplied path.
      const xdg = resolveUserPath(process.env.XDG_CONFIG_HOME);
      const xdgRoot = xdg
        ? path.join(xdg, 'aiden')
        : path.join(home, '.config', 'aiden');
      const legacyRoot = path.join(home, '.aiden');
      // Synchronous existence check — this runs at boot, before any
      // async I/O is set up. fs.existsSync is acceptable here.
      try {
        const fsSync = require('node:fs') as typeof import('node:fs');
        const legacyExists = fsSync.existsSync(legacyRoot);
        const xdgExists = fsSync.existsSync(xdgRoot);
        if (legacyExists && !xdgExists) return legacyRoot;
      } catch {
        // fs unavailable (vanishingly unlikely) — fall through to XDG.
      }
      return xdgRoot;
    }
  }
}

/** Build the full set of paths from a (possibly overridden) root. */
export function resolveAidenPaths(opts: ResolveAidenPathsOptions = {}): AidenPaths {
  const root = resolveAidenRoot(opts);
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    approvalsJson: path.join(root, 'approvals.json'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'memories', 'MEMORY.md'),
    userMd: path.join(root, 'memories', 'USER.md'),
    skillsDir: path.join(root, 'skills'),
    personalitiesDir: path.join(root, 'personalities'),
    skinsDir: path.join(root, 'skins'),
    recentCommandsFile: path.join(root, '.recent-commands.json'),
    sessionsDir: path.join(root, 'sessions'),
    distillationsDir: path.join(root, 'distillations'),
    memoryBackupsDir: path.join(root, 'memory-backups'),
    pluginsDir: path.join(root, 'plugins'),
    logsDir: path.join(root, 'logs'),
    bundledManifest: path.join(root, '.bundled_manifest'),
    skillsBundleVersion: path.join(root, '.skills-bundle-version'),
  };
}

/**
 * Create every directory in `paths` that should exist on disk.  Idempotent —
 * existing dirs are left alone.  Files (sessionsDb, authJson, configYaml,
 * envFile, the .md files, bundledManifest) are NOT pre-created — owners
 * create them lazily on first write.
 */
export async function ensureAidenDirsExist(paths: AidenPaths): Promise<void> {
  const dirs = [
    paths.root,
    paths.skillsDir,
    paths.sessionsDir,
    paths.pluginsDir,
    paths.logsDir,
    path.dirname(paths.memoryMd), // root/memories/
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}
