/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/envSources.ts — Phase 16c.2
 *
 * Tracks where each `process.env` entry came from so `/providers` can
 * tell users whether a key is from their shell, Windows User-level env,
 * or the aiden-managed `.env` at `paths.envFile`.
 *
 * Lives in its own module to break a circular import:
 *   `commands/providers.ts` → `aidenCLI.ts` (had this) → `commands/`
 *
 * Source tags:
 *   - 'preset'    — already in process.env when aiden booted
 *                   (Windows User env, parent shell, prior dotenv layer)
 *   - 'aiden-env' — populated by `loadAidenEnvFile()` from `paths.envFile`
 *   - 'unset'     — not in process.env
 */
import * as fs from 'node:fs';

export type EnvSource = 'preset' | 'aiden-env';

const ENV_SOURCE_TAG = Symbol.for('aiden.envSource');

function getMap(): Map<string, EnvSource> {
  let m: Map<string, EnvSource> | undefined = (globalThis as any)[ENV_SOURCE_TAG];
  if (!m) {
    m = new Map<string, EnvSource>();
    (globalThis as any)[ENV_SOURCE_TAG] = m;
  }
  return m;
}

/**
 * Load aiden's managed `.env` file into `process.env`. Fill-only — keys
 * already set in process.env (the user's shell, Windows User env, etc.)
 * are NOT overwritten, and they're tagged 'preset' for diagnostics.
 *
 * Silent on parse errors and missing files; the resolver surfaces missing
 * keys later with a clearer error than dotenv would.
 */
export function loadAidenEnvFile(envFile: string): void {
  const sources = getMap();
  // Tag everything currently in process.env as 'preset' BEFORE we touch
  // the file, so we don't misattribute pre-existing keys.
  for (const k of Object.keys(process.env)) {
    if (!sources.has(k)) sources.set(k, 'preset');
  }
  let body: string;
  try {
    body = fs.readFileSync(envFile, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.endsWith('"')) ||
        (value[0] === "'" && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      sources.set(key, 'aiden-env');
    }
  }
}

/** Read the source of a given env var (for `/providers` diagnostics). */
export function getEnvSource(key: string): EnvSource | 'unset' {
  if (process.env[key] === undefined) return 'unset';
  return getMap().get(key) ?? 'preset';
}

/** Test-only: clear the source map. */
export function __resetEnvSources(): void {
  getMap().clear();
}
