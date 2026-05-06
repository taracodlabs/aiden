/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillBundledRestore.ts — Aiden v4.0.0 (Phase 16b.1)
 *
 * First-run + self-heal copy of bundled skills into `paths.skillsDir`.
 *
 * Phase 10 shipped `BundledManifest.initialize()` for tracking bundled
 * vs. user-modified skills, but no code path ever copied the skills
 * themselves into `~/.aiden/skills` (or %LOCALAPPDATA%\aiden\skills on
 * Windows). The "39 tools · 0 skills" banner Phase 16b's smoke gate
 * surfaced is the symptom: the user's skills dir was empty because
 * the bundled-skills copy step never fired.
 *
 * This module fixes that. Called from `buildAgentRuntime`, it:
 *   1. Resolves the bundled-skills source dir (relative to the package
 *      install — repo `skills/` in dev, `dist/skills/` in production).
 *   2. If `paths.skillsDir` is empty, copies every bundled skill in.
 *   3. Calls `BundledManifest.initialize()` to record hashes.
 *   4. Returns a summary the boot path can log.
 *
 * Idempotent: subsequent runs see the dir is non-empty and no-op. To
 * force a fresh restore, delete `paths.skillsDir` and re-run aiden.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from './paths';
import { BundledManifest } from './skillBundledManifest';

export interface BundledRestoreResult {
  /** Source directory the skills were copied from (null when none found). */
  sourceDir: string | null;
  /** Number of skills copied this run (0 if dir was already populated). */
  copied: number;
  /** Number of skills already present that we left alone. */
  preserved: number;
  /** True when the manifest's `initialize()` ran. */
  manifestInitialized: boolean;
}

/**
 * Try a small list of candidate paths for the bundled-skills directory.
 * Picked to cover:
 *   - dev (`<repo>/skills/`) — `__dirname` is `<repo>/core/v4/`
 *   - tsc build (`<repo>/dist/core/v4/` → still `<repo>/skills/`)
 *   - npm packaged (`node_modules/aiden-runtime/skills/`)
 *
 * The first existing dir wins. Returns null when none match.
 */
export async function resolveBundledSkillsDir(opts: {
  /** Override (used in tests). */
  override?: string;
} = {}): Promise<string | null> {
  if (opts.override) {
    if (await dirExists(opts.override)) return opts.override;
    return null;
  }

  const here = __dirname;
  const candidates = [
    // Dev: core/v4/ → repo root → skills/
    path.resolve(here, '..', '..', 'skills'),
    // Compiled tsc: dist/core/v4/ → dist root → ../skills
    path.resolve(here, '..', '..', '..', 'skills'),
    // Compiled bundle: dist-bundle/ → repo root → skills/
    path.resolve(here, '..', 'skills'),
    // Process cwd fallback (covers tests run from repo root).
    path.resolve(process.cwd(), 'skills'),
  ];

  for (const c of candidates) {
    if (await dirExists(c)) {
      // Sanity check: must contain at least one SKILL.md or single-file *.md.
      try {
        const entries = await fs.readdir(c);
        const hasSkill = entries.some(
          (e) =>
            e.toLowerCase().endsWith('.md') &&
            e.toLowerCase() !== 'aiden_catalog.md' &&
            e.toLowerCase() !== 'skill_template.md',
        );
        if (hasSkill) return c;
        // Or any subdirectory with SKILL.md inside.
        for (const entry of entries) {
          const stat = await fs.stat(path.join(c, entry)).catch(() => null);
          if (stat?.isDirectory()) {
            const hasSkillMd = await fileExists(
              path.join(c, entry, 'SKILL.md'),
            );
            if (hasSkillMd) return c;
          }
        }
      } catch {
        /* ignore — try next candidate */
      }
    }
  }
  return null;
}

/**
 * Restore bundled skills into the user's skills dir if it's empty.
 *
 * Returns a summary even when nothing was copied — callers use the
 * `copied` count for boot-line logging.
 */
export async function restoreBundledSkillsIfNeeded(
  paths: AidenPaths,
  opts: { sourceOverride?: string } = {},
): Promise<BundledRestoreResult> {
  const result: BundledRestoreResult = {
    sourceDir: null,
    copied: 0,
    preserved: 0,
    manifestInitialized: false,
  };

  const sourceDir = await resolveBundledSkillsDir({
    override: opts.sourceOverride,
  });
  result.sourceDir = sourceDir;
  if (!sourceDir) return result;

  // Ensure target exists.
  await fs.mkdir(paths.skillsDir, { recursive: true });

  // Snapshot existing user content so we can preserve it.
  let existing: string[];
  try {
    existing = await fs.readdir(paths.skillsDir);
  } catch {
    existing = [];
  }
  const existingSet = new Set(existing);
  result.preserved = existing.length;

  // Walk bundled source and copy anything that isn't already present
  // in the user's dir. Skip TEMPLATE / CATALOG markers.
  let bundledEntries: string[];
  try {
    bundledEntries = await fs.readdir(sourceDir);
  } catch {
    return result;
  }

  for (const entry of bundledEntries) {
    const lc = entry.toLowerCase();
    if (lc === 'aiden_catalog.md' || lc === 'skill_template.md') continue;
    if (existingSet.has(entry)) continue; // user already has this skill
    const src = path.join(sourceDir, entry);
    const dst = path.join(paths.skillsDir, entry);
    let stat;
    try {
      stat = await fs.stat(src);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // SKILL.md must exist for it to be a real skill dir.
      const skillFile = path.join(src, 'SKILL.md');
      if (!(await fileExists(skillFile))) continue;
      await copyDirRecursive(src, dst);
      result.copied += 1;
    } else if (stat.isFile() && lc.endsWith('.md')) {
      await fs.copyFile(src, dst);
      result.copied += 1;
    }
  }

  // Refresh the manifest so userModified flags stay accurate.
  if (result.copied > 0 || existing.length === 0) {
    try {
      const manifest = new BundledManifest(paths);
      await manifest.initialize(sourceDir);
      result.manifestInitialized = true;
    } catch {
      /* manifest update is best-effort */
    }
  }

  return result;
}

// ─── Internals ──────────────────────────────────────────────────────

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
    // Symlinks intentionally skipped — bundled skills shouldn't contain any.
  }
}
