/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/plugins/pluginBundledRestore.ts — Aiden v4.0.0 (Phase 17 Task 5)
 *
 * First-run + self-heal copy of bundled plugins into `paths.pluginsDir`.
 * Mirrors Phase 16b.1's `restoreBundledSkillsIfNeeded` (`skillBundledRestore.ts`)
 * — the npm package ships `plugins/<name>/` directories alongside the
 * compiled JS, but the loader walks the user's data dir, so we need to
 * copy on first boot.
 *
 * Per Phase 17 spec:
 *   - Copy when a bundled plugin name is missing in the user dir.
 *   - Do NOT auto-grant permissions. The user runs /plugins grant
 *     once at first use; the resulting state surface is the trust signal.
 *   - Idempotent: subsequent runs see each name already present and no-op.
 *     This means user changes (e.g. an edit to plugin.json) survive
 *     subsequent boots, matching the skill restore semantics.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from '../paths';
import { MANIFEST_FILENAME } from './pluginManifest';

export interface BundledPluginRestoreResult {
  /** Source dir copied from (null when no bundled-plugins dir was found). */
  sourceDir: string | null;
  /** Plugin names copied this run. */
  copied: string[];
  /** Plugin names already present that we left alone. */
  preserved: string[];
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the bundled-plugins directory. Same candidate-list strategy
 * as skillBundledRestore: dev (`<repo>/plugins/`), tsc (dist nesting),
 * npm install root, and process.cwd() fallback.
 */
export async function resolveBundledPluginsDir(
  override?: string,
): Promise<string | null> {
  if (override) {
    return (await dirExists(override)) ? override : null;
  }

  const here = __dirname;
  const candidates = [
    // Dev: core/v4/plugins/ → repo root → plugins/
    path.resolve(here, '..', '..', '..', 'plugins'),
    // Compiled tsc: dist/core/v4/plugins/ → up to dist root → plugins/
    path.resolve(here, '..', '..', '..', '..', 'plugins'),
    // Compiled bundle: dist-bundle/core/v4/plugins/ → repo root
    path.resolve(here, '..', '..', 'plugins'),
    // process.cwd() fallback (covers tests run from repo root).
    path.resolve(process.cwd(), 'plugins'),
  ];

  for (const c of candidates) {
    if (!(await dirExists(c))) continue;
    // Sanity check: must contain at least one subdir with plugin.json.
    let entries: string[];
    try {
      entries = await fs.readdir(c);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const sub = path.join(c, entry);
      if (await fileExists(path.join(sub, MANIFEST_FILENAME))) {
        return c;
      }
    }
  }
  return null;
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

/**
 * Restore bundled plugins into the user's plugins dir if any are missing.
 * Returns a summary with names copied vs preserved. Errors are non-fatal —
 * a failure to copy any single plugin doesn't abort the rest.
 */
export async function restoreBundledPluginsIfNeeded(
  paths: AidenPaths,
  opts: { sourceOverride?: string } = {},
): Promise<BundledPluginRestoreResult> {
  const result: BundledPluginRestoreResult = {
    sourceDir: null,
    copied: [],
    preserved: [],
  };

  const sourceDir = await resolveBundledPluginsDir(opts.sourceOverride);
  result.sourceDir = sourceDir;
  if (!sourceDir) return result;

  await fs.mkdir(paths.pluginsDir, { recursive: true });

  let bundledEntries: string[];
  try {
    bundledEntries = await fs.readdir(sourceDir);
  } catch {
    return result;
  }

  for (const entry of bundledEntries) {
    const src = path.join(sourceDir, entry);
    if (!(await fileExists(path.join(src, MANIFEST_FILENAME)))) continue;
    const dst = path.join(paths.pluginsDir, entry);
    if (await dirExists(dst)) {
      result.preserved.push(entry);
      continue;
    }
    try {
      await copyDir(src, dst);
      result.copied.push(entry);
    } catch {
      /* per-plugin failure non-fatal */
    }
  }
  return result;
}
