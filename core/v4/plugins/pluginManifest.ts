/**
 * core/v4/plugins/pluginManifest.ts — Aiden v4.0.0 (Phase 17)
 *
 * Parses and validates `plugin.json` manifests for Aiden plugins. Mirrors
 * the field set from Hermes `plugin.yaml` (see docs/sprint/hermes-plugins-audit.md
 * for decisions per surface) with two divergences:
 *
 *   1. JSON not YAML — TS ecosystem default; no extra dep needed.
 *   2. `permissions` field — net-new vs. Hermes. Advisory-only for v4.0
 *      (Pro-tier trust UX, not a security boundary). Manifest validator
 *      catches typos in declared permissions; runtime dispatch (Task 4)
 *      checks actual usage against the granted set.
 *
 * `manifestVersion` is the schema version, currently 1. Future breaking
 * changes bump it; the loader refuses unknown versions.
 *
 * Status: PHASE 17 Task 1.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Schema version this code understands. */
export const MANIFEST_VERSION = 1;

/** Manifest filename inside a plugin directory. */
export const MANIFEST_FILENAME = 'plugin.json';

/**
 * Permissions a plugin may declare.
 *
 * - `network`     — outbound HTTP / DNS / sockets
 * - `shell`       — spawn shell processes
 * - `filesystem`  — read or write outside the plugin's own dir
 * - `subprocess`  — spawn non-shell child processes (e.g. node, python)
 * - `browser`     — automate Chromium / CDP / Playwright
 * - `memory`      — read/write the agent's memory store
 *
 * v4.0 enforcement is advisory: declared at install, checked at dispatch,
 * but a malicious plugin can call any tool. This is UX, not a sandbox.
 */
export const PERMISSION_TYPES = [
  'network',
  'shell',
  'filesystem',
  'subprocess',
  'browser',
  'memory',
] as const;

export type PluginPermission = (typeof PERMISSION_TYPES)[number];

/** Plugin kind. v4.0 has two; Hermes has four (we collapse). */
export const PLUGIN_KINDS = ['standalone', 'bundled'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/** Lifecycle hooks v4.0 fires. Per-tool-call hooks deferred to v4.1. */
export const LIFECYCLE_HOOKS = ['onLoad', 'onActivate', 'onTeardown'] as const;
export type LifecycleHook = (typeof LIFECYCLE_HOOKS)[number];

/**
 * Parsed representation of a plugin.json manifest. Field names mirror
 * Hermes `PluginManifest` (plugins.py:179) where possible.
 */
export interface PluginManifest {
  /** Schema version. Currently must equal MANIFEST_VERSION. */
  manifestVersion: number;
  /** Unique plugin name (kebab-case recommended). */
  name: string;
  /** Semver-ish version string. */
  version: string;
  /** Author name or org. */
  author: string;
  /** Short human description. */
  description: string;
  /**
   * Plugin kind. `bundled` ships in core and auto-loads (no opt-in needed).
   * `standalone` is user-installed and opt-in.
   */
  kind: PluginKind;
  /** Tools this plugin contributes. Names registered into ToolRegistry. */
  tools: string[];
  /** Skill IDs this plugin contributes (paths to SKILL.md files within plugin dir). */
  skills: string[];
  /** Provider configs (model providers). v4.0 reserves but does not register. */
  providers: string[];
  /** Declared capability set. See PERMISSION_TYPES. */
  permissions: PluginPermission[];
  /** Required env vars; surfaced at install for the user to fill. */
  requiresEnv: string[];
  /**
   * Source classification. Set by the loader, not by the manifest author —
   * any value in the JSON is overwritten.
   */
  source?: 'bundled' | 'user';
  /** Absolute path to the plugin's directory on disk. Set by loader. */
  path?: string;
}

export interface ManifestValidationOk {
  ok: true;
  manifest: PluginManifest;
}
export interface ManifestValidationError {
  ok: false;
  errors: string[];
}
export type ManifestValidationResult =
  | ManifestValidationOk
  | ManifestValidationError;

/**
 * Validate a parsed manifest object. Returns the typed manifest on success
 * or a flat list of error strings — every offending field is reported in
 * one pass so the install flow can surface them all.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const m = raw as Record<string, unknown>;

  // manifestVersion
  if (m.manifestVersion === undefined) {
    errors.push('missing required field: manifestVersion');
  } else if (typeof m.manifestVersion !== 'number') {
    errors.push('manifestVersion must be a number');
  } else if (m.manifestVersion !== MANIFEST_VERSION) {
    errors.push(
      `unsupported manifestVersion ${m.manifestVersion} (this runtime supports ${MANIFEST_VERSION})`,
    );
  }

  // name
  if (typeof m.name !== 'string' || m.name.trim().length === 0) {
    errors.push('name must be a non-empty string');
  } else if (!/^[a-z0-9][a-z0-9-_]*$/i.test(m.name)) {
    errors.push(
      'name must be alphanumeric with - or _ (no spaces, slashes, or dots)',
    );
  }

  // version
  if (typeof m.version !== 'string' || m.version.trim().length === 0) {
    errors.push('version must be a non-empty string');
  }
  // author
  if (typeof m.author !== 'string') {
    errors.push('author must be a string');
  }
  // description
  if (typeof m.description !== 'string') {
    errors.push('description must be a string');
  }

  // kind
  const kind = m.kind ?? 'standalone';
  if (typeof kind !== 'string' || !(PLUGIN_KINDS as readonly string[]).includes(kind)) {
    errors.push(
      `kind must be one of: ${PLUGIN_KINDS.join(', ')} (got ${JSON.stringify(kind)})`,
    );
  }

  // string array helpers
  const checkStringArray = (field: string, val: unknown): void => {
    if (val === undefined) return;
    if (!Array.isArray(val) || !val.every((x) => typeof x === 'string')) {
      errors.push(`${field} must be an array of strings`);
    }
  };
  checkStringArray('tools', m.tools);
  checkStringArray('skills', m.skills);
  checkStringArray('providers', m.providers);
  checkStringArray('requiresEnv', m.requiresEnv);

  // permissions — every entry must be in PERMISSION_TYPES
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      errors.push('permissions must be an array of strings');
    } else {
      for (const p of m.permissions) {
        if (typeof p !== 'string' || !(PERMISSION_TYPES as readonly string[]).includes(p)) {
          errors.push(
            `unknown permission ${JSON.stringify(p)} — valid: ${PERMISSION_TYPES.join(', ')}`,
          );
        }
      }
      // Reject duplicates so the install summary stays clean.
      const seen = new Set<string>();
      for (const p of m.permissions) {
        if (typeof p === 'string') {
          if (seen.has(p)) errors.push(`duplicate permission ${JSON.stringify(p)}`);
          seen.add(p);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const manifest: PluginManifest = {
    manifestVersion: m.manifestVersion as number,
    name: (m.name as string).trim(),
    version: (m.version as string).trim(),
    author: (m.author as string) ?? '',
    description: (m.description as string) ?? '',
    kind: kind as PluginKind,
    tools: (m.tools as string[]) ?? [],
    skills: (m.skills as string[]) ?? [],
    providers: (m.providers as string[]) ?? [],
    permissions: (m.permissions as PluginPermission[]) ?? [],
    requiresEnv: (m.requiresEnv as string[]) ?? [],
  };
  return { ok: true, manifest };
}

/**
 * Read and parse the manifest file at `<pluginDir>/plugin.json`.
 * Returns a structured result; never throws on bad JSON or missing file.
 */
export async function readManifest(
  pluginDir: string,
): Promise<ManifestValidationResult> {
  const file = path.join(pluginDir, MANIFEST_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return { ok: false, errors: [`no ${MANIFEST_FILENAME} in ${pluginDir}`] };
    }
    return { ok: false, errors: [`failed to read manifest: ${e.message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [`invalid JSON in ${file}: ${(err as Error).message}`],
    };
  }
  const result = validateManifest(parsed);
  if (result.ok) {
    result.manifest.path = pluginDir;
  }
  return result;
}
