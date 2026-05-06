/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/plugins/pluginPermissions.ts — Aiden v4.0.0 (Phase 17 Task 3+4)
 *
 * Loads and saves the per-plugin granted-permissions file. Lives under
 * the plugin's own directory (`.granted-permissions.json`) so a fresh
 * install starts ungranted and `/plugins remove` cleans it up
 * automatically.
 *
 * Advisory only — Pro-tier trust UX, not a security boundary (per audit).
 * The plugin loader's `isPermissionGranted` hook reads through this; a
 * malicious plugin can bypass.
 *
 * File format: { "version": 1, "granted": ["network", ...] }
 *
 * Hermes has no equivalent — this is net-new for Aiden.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  PERMISSION_TYPES,
  type PluginPermission,
  type PluginManifest,
} from './pluginManifest';

export const GRANTED_FILE = '.granted-permissions.json';
export const GRANTED_VERSION = 1;

interface GrantedFileShape {
  version: number;
  granted: string[];
}

/**
 * Read the granted-permissions file for a plugin. Returns the empty
 * array on missing file or any parse error — failure-safe so a corrupt
 * file becomes "no grants" rather than a load error.
 */
export async function loadGrantedPermissions(
  pluginDir: string,
): Promise<PluginPermission[]> {
  const file = path.join(pluginDir, GRANTED_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as Partial<GrantedFileShape>;
    if (!parsed || !Array.isArray(parsed.granted)) return [];
    return parsed.granted.filter(
      (p): p is PluginPermission =>
        typeof p === 'string' && (PERMISSION_TYPES as readonly string[]).includes(p),
    );
  } catch {
    return [];
  }
}

/**
 * Persist the grant set. Overwrites any existing file. Caller must have
 * already validated permissions (every entry in PERMISSION_TYPES) — we
 * write whatever is given so explicit denial of `[]` is representable.
 */
export async function saveGrantedPermissions(
  pluginDir: string,
  granted: PluginPermission[],
): Promise<void> {
  const file = path.join(pluginDir, GRANTED_FILE);
  const payload: GrantedFileShape = { version: GRANTED_VERSION, granted };
  await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n');
}

/**
 * Permission evaluation outcome. The loader uses this to decide between
 * the four lifecycle states a plugin can land in:
 *
 * - `granted`        — granted set covers every declared permission. Tools
 *                      execute normally.
 * - `pending-grant`  — no granted file on disk. First-install case (and
 *                      first boot for a bundled plugin that has not yet
 *                      been granted). Tools register but execute returns
 *                      a "permissions not granted" refusal so the agent
 *                      learns the tool exists but cannot use it.
 * - `suspended`      — granted file present but the manifest now declares
 *                      permissions not in the granted set. Plugin upgrade
 *                      requested more access; user must re-grant via
 *                      /plugins grant <name>. Tools NOT registered.
 * - `granted-with-extra` (informational only — collapsed to `granted` in
 *                      practice) — granted has more than declared. Treat
 *                      as granted; no harm done.
 */
export type PermissionState =
  | 'granted'
  | 'pending-grant'
  | 'suspended';

export interface PermissionEvaluation {
  state: PermissionState;
  /** Permissions declared by the manifest. */
  declared: PluginPermission[];
  /** Permissions in the persisted granted file (or [] when missing). */
  granted: PluginPermission[];
  /** declared \ granted — the new asks the user has not yet allowed. */
  missing: PluginPermission[];
  /** True iff the granted file exists on disk. */
  grantedFileExists: boolean;
}

interface FsLikeSync {
  readFileSync(p: string, enc: string): string;
  existsSync(p: string): boolean;
}

/**
 * Synchronous variant of loadGrantedPermissions for use inside the
 * loader's permission checker (which the loader calls with a sync API).
 * Same failure-safe semantics as the async version.
 */
function loadGrantedSync(
  pluginDir: string,
  fsSync: FsLikeSync,
): { granted: PluginPermission[]; fileExists: boolean } {
  const file = path.join(pluginDir, GRANTED_FILE);
  if (!fsSync.existsSync(file)) {
    return { granted: [], fileExists: false };
  }
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8')) as Partial<GrantedFileShape>;
    if (!parsed || !Array.isArray(parsed.granted)) {
      return { granted: [], fileExists: true };
    }
    const granted = parsed.granted.filter(
      (p): p is PluginPermission =>
        typeof p === 'string' && (PERMISSION_TYPES as readonly string[]).includes(p),
    );
    return { granted, fileExists: true };
  } catch {
    return { granted: [], fileExists: true };
  }
}

/**
 * Evaluate a manifest against its persisted granted file. Pure function —
 * `fsSync` is injected so tests can substitute. Defaults to node:fs.
 */
export function evaluatePermissionState(
  manifest: PluginManifest,
  fsSync: FsLikeSync = require('node:fs') as FsLikeSync,
): PermissionEvaluation {
  if (!manifest.path) {
    // No path means we can't read a granted file — treat as fresh install.
    return {
      state: manifest.permissions.length === 0 ? 'granted' : 'pending-grant',
      declared: manifest.permissions,
      granted: [],
      missing: manifest.permissions,
      grantedFileExists: false,
    };
  }
  const { granted, fileExists } = loadGrantedSync(manifest.path, fsSync);
  const grantedSet = new Set(granted);
  const missing = manifest.permissions.filter((p) => !grantedSet.has(p));

  if (manifest.permissions.length === 0) {
    return { state: 'granted', declared: [], granted, missing: [], grantedFileExists: fileExists };
  }
  if (!fileExists) {
    return {
      state: 'pending-grant',
      declared: manifest.permissions,
      granted,
      missing,
      grantedFileExists: false,
    };
  }
  if (missing.length > 0) {
    return {
      state: 'suspended',
      declared: manifest.permissions,
      granted,
      missing,
      grantedFileExists: true,
    };
  }
  return {
    state: 'granted',
    declared: manifest.permissions,
    granted,
    missing: [],
    grantedFileExists: true,
  };
}

/**
 * Per-permission boolean checker — kept for callers that still want
 * granular access (and to satisfy the original `isPermissionGranted`
 * loader hook signature). Memoises per plugin path.
 */
export function buildPermissionChecker(
  cache = new Map<string, Set<string>>(),
  fsSync: FsLikeSync = require('node:fs') as FsLikeSync,
): (manifest: PluginManifest, permission: string) => boolean {
  return (manifest, permission) => {
    if (!manifest.path) return false;
    let grants = cache.get(manifest.path);
    if (!grants) {
      const { granted } = loadGrantedSync(manifest.path, fsSync);
      grants = new Set(granted);
      cache.set(manifest.path, grants);
    }
    return grants.has(permission);
  };
}

/**
 * Pretty-print a manifest's install summary for the slash-command
 * confirmation prompt. Pure function — caller owns rendering.
 */
export function formatInstallSummary(manifest: PluginManifest): string {
  const lines: string[] = [];
  lines.push(`Plugin: ${manifest.name} v${manifest.version}`);
  if (manifest.author) lines.push(`Author: ${manifest.author}`);
  if (manifest.description) lines.push(`Description: ${manifest.description}`);
  lines.push(`Tools: ${manifest.tools.length ? manifest.tools.join(', ') : '(none)'}`);
  lines.push(`Skills: ${manifest.skills.length ? manifest.skills.join(', ') : '(none)'}`);
  lines.push(
    `Providers: ${manifest.providers.length ? manifest.providers.join(', ') : '(none)'}`,
  );
  lines.push(
    `Permissions requested: ${
      manifest.permissions.length ? manifest.permissions.join(', ') : '(none)'
    }`,
  );
  return lines.join('\n');
}
