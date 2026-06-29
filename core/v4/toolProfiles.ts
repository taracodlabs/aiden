/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/toolProfiles.ts — v4.11 toolset grouping
 *
 * Profile-based STATIC tool selection. Resolved ONCE at session boot,
 * stable for the lifetime of the agent — never per-turn — so the tool
 * block stays inside the provider prefix cache and the catalog the
 * model sees is deterministic.
 *
 * A profile is a named UNION of toolset groups (`web`, `files`,
 * `browser`, …). `resolveProfile(name)` returns the concrete list of
 * toolset tags; `cli/v4/aidenCLI.ts` feeds that list into
 * `toolRegistry.getSchemas(toolsets, 'repl')` at agent construction.
 *
 * Three built-in profiles ship:
 *
 *   - `minimal`  — ~12-15 tools / target < 2.5K schema tokens.
 *                  Covers a cold "what can you do?" turn on a
 *                  rate-limited free-tier provider (e.g. Groq's 12K
 *                  TPM cap rejected a bare "hi" at 19K because tool
 *                  schemas alone took 7.7K — minimal slashes that to
 *                  the 5 essential groups).
 *   - `standard` — DEFAULT. Adds browser / process / sessions / media
 *                  for normal interactive workflows. ~30 tools.
 *   - `full`     — every registered toolset. Byte-identical to the
 *                  pre-v4.11 behaviour (passes `undefined` to
 *                  `getSchemas` instead of a toolset list — the
 *                  registry preserves insertion order). Power users
 *                  + complex multi-domain tasks.
 *
 * Switching profiles mid-session is allowed via `/tools <profile>`
 * but it INVALIDATES the prefix cache for the next request — the
 * trade-off is acceptable because it's user-initiated. The runtime
 * NEVER swaps profiles automatically per turn (the reference system
 * we absorbed patterns from explicitly rejected per-turn churn for
 * exactly this reason).
 *
 * Env override at boot: `AIDEN_TOOL_PROFILE=minimal|standard|full`
 * wins over the config-stored value.
 *
 * Status: v4.11.
 */

/**
 * Stable identifier for the three built-in profiles. `custom` is
 * reserved — when the user writes `agent.tool_profile_toolsets: [...]`
 * in config.yaml the profile name becomes `custom` and the explicit
 * toolset list is used verbatim.
 */
export type ToolProfileName = 'minimal' | 'standard' | 'full' | 'custom';

/**
 * Definition of one profile. `toolsets` is the source of truth — the
 * list of toolset tags that `getSchemas(filterToolsets)` should pass.
 * `null` means "no filter" (all toolsets — used by `full`).
 *
 * `description` is what `/tools list` shows the user; keep it short.
 */
export interface ToolProfile {
  readonly name:        ToolProfileName;
  readonly toolsets:    readonly string[] | null;
  readonly description: string;
}

/**
 * Minimal — five essential groups for cold-context turns under tight
 * TPM caps. Chosen by audit measurement: covers read/write file ops
 * (`files`), shell (`terminal`), code execution (`execute`), web
 * fetch/search (`web`), and memory persistence (`memory`). Skills
 * deliberately INCLUDED so the user can ask "what skills do you have"
 * without bumping to a heavier profile. UI signals (`ui`) are
 * uiOnly:true and bypass dispatch — they're nearly free to ship.
 */
const MINIMAL_TOOLSETS: readonly string[] = [
  'files',
  'terminal',
  'execute',
  'web',
  'memory',
  'skills',
  'ui',
  // v4.11 — the `clarify` tool is a core interaction primitive (ask the
  // user when blocked rather than guess); it belongs in every profile,
  // including the cold-context minimal one. uiOnly:false but cheap (one
  // schema). REPL-only via the tool's `contexts: ['repl']`.
  'clarify',
];

/**
 * Standard (default) — minimal plus the common workflow surfaces:
 * browser automation, OS process management, session search/recall,
 * subagent spawn, trace introspection. Mirrors what a regular
 * interactive REPL session reaches for; excludes the niche
 * media/apps/system bundles unless the user opts into `full`.
 */
const STANDARD_TOOLSETS: readonly string[] = [
  ...MINIMAL_TOOLSETS,
  'browser',
  'process',
  'sessions',
  'subagent',
  'trace',
];

/**
 * Built-in profiles table. `full` carries `toolsets: null` as a
 * sentinel — `resolveProfileToolsets` returns undefined for that
 * case so `getSchemas(undefined, 'repl')` is called (preserves
 * pre-v4.11 byte-identical behaviour).
 */
export const BUILT_IN_PROFILES: Readonly<Record<ToolProfileName, ToolProfile>> = {
  minimal: {
    name:        'minimal',
    toolsets:    MINIMAL_TOOLSETS,
    description: 'Cold-context essentials (files, shell, exec, web, memory, skills, ui). Best for rate-limited free-tier providers.',
  },
  standard: {
    name:        'standard',
    toolsets:    STANDARD_TOOLSETS,
    description: 'Default. Minimal + browser, process, sessions, subagent, trace.',
  },
  full: {
    name:        'full',
    toolsets:    null,
    description: 'Every registered toolset (pre-v4.11 default). Power users + complex multi-domain tasks.',
  },
  custom: {
    name:        'custom',
    toolsets:    null,
    description: 'User-defined toolset list from config.yaml agent.tool_profile_toolsets.',
  },
};

/** Discoverable profile names for `/tools list` and config validation. */
export const PROFILE_NAMES: readonly ToolProfileName[] = ['minimal', 'standard', 'full', 'custom'];

/** Default when nothing is configured + nothing is in the env. */
export const DEFAULT_PROFILE_NAME: ToolProfileName = 'standard';

/**
 * Parse + validate a profile name from arbitrary string input (env
 * var, config value, slash command argument). Returns the canonical
 * `ToolProfileName` or `undefined` when the input doesn't match any
 * built-in. Case-insensitive; trims whitespace.
 */
export function parseProfileName(input: unknown): ToolProfileName | undefined {
  if (typeof input !== 'string') return undefined;
  const norm = input.trim().toLowerCase();
  if (norm === '') return undefined;
  if ((PROFILE_NAMES as readonly string[]).includes(norm)) {
    return norm as ToolProfileName;
  }
  return undefined;
}

/**
 * Resolve a profile + an optional custom-toolset override into the
 * concrete toolset list that callers pass to `getSchemas`. When the
 * return value is `undefined`, callers should pass `undefined` to
 * `getSchemas` (= "no filter, ship everything") — that's how `full`
 * stays byte-identical to the pre-v4.11 catalog.
 *
 * For `custom`, the caller MUST supply `customToolsets`; if it's
 * empty / missing, the function falls back to the `standard`
 * profile's toolset list so a malformed config never leaves the
 * agent with zero tools.
 */
export function resolveProfileToolsets(
  profile:        ToolProfileName,
  customToolsets: readonly string[] | undefined,
): readonly string[] | undefined {
  if (profile === 'full') return undefined;
  if (profile === 'custom') {
    if (Array.isArray(customToolsets) && customToolsets.length > 0) {
      // Dedupe while preserving order — duplicate entries are a common
      // hand-edit mistake in config.yaml.
      return [...new Set(customToolsets.map((t) => String(t)))];
    }
    // Malformed custom → fall back to standard rather than ship 0.
    return [...STANDARD_TOOLSETS];
  }
  const def = BUILT_IN_PROFILES[profile];
  return def.toolsets === null ? undefined : [...def.toolsets];
}

/**
 * Boot-time entry point used by `cli/v4/aidenCLI.ts:buildAgentRuntime`.
 *
 * Resolution precedence (highest wins):
 *   1. `AIDEN_TOOL_PROFILE` env var
 *   2. `config.agent.tool_profile` from config.yaml
 *   3. `DEFAULT_PROFILE_NAME` ('standard')
 *
 * Returns the resolved `ToolProfileName` plus the concrete toolset
 * list. The toolset list is `undefined` when the profile is `full`
 * (= "no filter") — callers pass that straight to `getSchemas`.
 *
 * Source of `customToolsets` is `config.agent.tool_profile_toolsets`
 * — only consulted when the resolved name is `custom`.
 */
export interface ResolvedProfile {
  /** Canonical profile name actually in effect. */
  name:            ToolProfileName;
  /** Toolset filter for `getSchemas`. `undefined` ⇔ no filter (full). */
  toolsets:        readonly string[] | undefined;
  /** Where the profile name came from — for boot diagnostics. */
  source:          'env' | 'config' | 'default';
  /** Raw input that triggered the resolution (for boot dim line). */
  rawInput?:       string;
}

export function resolveBootProfile(
  envValue:        string | undefined,
  configValue:     string | undefined,
  customToolsets:  readonly string[] | undefined,
): ResolvedProfile {
  const fromEnv = parseProfileName(envValue);
  if (fromEnv) {
    return {
      name:     fromEnv,
      toolsets: resolveProfileToolsets(fromEnv, customToolsets),
      source:   'env',
      rawInput: envValue,
    };
  }
  const fromConfig = parseProfileName(configValue);
  if (fromConfig) {
    return {
      name:     fromConfig,
      toolsets: resolveProfileToolsets(fromConfig, customToolsets),
      source:   'config',
      rawInput: configValue,
    };
  }
  return {
    name:     DEFAULT_PROFILE_NAME,
    toolsets: resolveProfileToolsets(DEFAULT_PROFILE_NAME, customToolsets),
    source:   'default',
  };
}
