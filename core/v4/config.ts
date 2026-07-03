/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/config.ts — Aiden v4.0.0
 *
 * config.yaml parser + ConfigProvider implementation.
 *
 * Replaces the Phase 5 stub used by RuntimeResolver. Behaviour:
 *
 * - Loads `config.yaml` from `paths.configYaml`. Missing file → defaults.
 * - YAML parsed via `js-yaml` (already a transitive dep, now direct).
 * - `${ENV_VAR}` interpolation runs at `get()` / `getValue()` time.
 *   Unset vars are left as `${X}` so callers can detect-and-fail rather
 *   than silently use empty strings (, _expand_env_vars).
 * - Schema is permissive: unknown top-level keys log a warning and are
 *   preserved on disk so a future Aiden version can pick them up.
 * - `set()` mutates the in-memory copy; persistence is `save()`.
 * - `reload()` re-reads the file and reports whether anything changed,
 *   feeding the hot-reload check (full filesystem watch lands Phase 13).
 *
 * Status: PHASE 6.
 *
 * save_config). Aiden trims hot-reload + the `aiden config` slash
 * commands to Phase 13 — only the parser surface is needed now.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import type { AidenPaths } from './paths';
import type { ConfigProvider } from '../../providers/v4/runtimeResolver';
import { type AutonomyLevel, isAutonomyLevel, levelFromApprovalMode } from '../../moat/autonomy';

export type ApprovalMode = 'manual' | 'smart' | 'off';

export interface AidenConfig {
  model: {
    provider: string;
    modelId: string;
    context_length?: number;
  };
  agent: {
    max_turns: number;
    approval_mode: ApprovalMode;
    /**
     * v4.12.1 Pillar 2 — the autonomy dial: 'Observer' | 'Assistant' |
     * 'Partner'. When unset, derived from `approval_mode` for back-compat
     * (default 'Assistant'). `--yolo` remains a SEPARATE dev bypass, not a
     * dial level. See `resolveConfiguredAutonomyLevel`.
     */
    autonomy?: AutonomyLevel;
    personalities?: Record<string, string>;
    /**
     * v4.11 toolset grouping — selects which built-in tool profile the
     * REPL agent loads at boot. One of `minimal`, `standard`, `full`,
     * `custom`. Default `standard`. Env override:
     * `AIDEN_TOOL_PROFILE=…` wins over this value. See
     * `core/v4/toolProfiles.ts` for the toolset-list each profile
     * resolves to.
     */
    tool_profile?: string;
    /**
     * v4.11 toolset grouping — only consulted when `tool_profile` is
     * `custom`. Explicit list of toolset tags (e.g.
     * `['files', 'terminal', 'web']`) that override every built-in
     * profile. Malformed / empty falls back to the `standard` profile.
     */
    tool_profile_toolsets?: string[];
    /**
     * v4.11 Obsidian-compatible vault mirror. When set, Aiden's memory
     * artifacts (MEMORY.md / USER.md / PROJECT.md entries + session
     * distillations + SOUL.md mirror) export as per-entry markdown
     * notes under `<vault_path>/aiden-memory/`. Read-only export —
     * vault edits do NOT flow back into Aiden's memory in v1.
     * Env override: `AIDEN_VAULT_PATH=...` wins over this value.
     * Empty / unset disables the exporter entirely (no-op).
     */
    vault_path?: string;
  };
  display: {
    skin: string;
    streaming: boolean;
    /**
     * v4.11 Slice 1 — renderer selection.
     *   undefined | 'legacy' → existing aidenPrompt path (default)
     *   'frame'              → renderer-owned composer (cli/v4/frame)
     * Env var `AIDEN_RENDERER` overrides this at runtime.
     */
    renderer?: 'legacy' | 'frame';
  };
  providers?: Record<
    string,
    { apiKey?: string; baseUrl?: string } & Record<string, unknown>
  >;
  memory: {
    provider: string;
  };
  /**
   * Forward-compatibility bucket: any unknown top-level keys land here so
   * round-trip save() doesn't drop user-managed fields.
   */
  [extra: string]: unknown;
}

export const DEFAULT_CONFIG: AidenConfig = {
  model: {
    provider: 'anthropic',
    modelId: 'claude-opus-4-7',
  },
  agent: {
    max_turns: 90,
    // Phase 16f: 'smart' default short-circuits BUILTIN_SAFE_TOOLS /
    // BUILTIN_SAFE_DOMAINS and uses the recorded allowlist; only unseen
    // non-safe calls prompt. Was 'manual' through Phase 16e.
    approval_mode: 'smart',
  },
  display: {
    skin: 'default',
    // v4.10 Slice 10.9 — flipped from `false` (Phase 16c opt-in default
    // since v4.0) to `true`. The Slice 10.9 Phase A audit caught that
    // EVERY wizard install since v4.0 baked `streaming: false` into the
    // written config.yaml via the wizard's `...DEFAULT_CONFIG` spread.
    // chatSession.ts already had `true` as its runtime fallback when
    // the key was absent — but the wizard never let that fallback fire
    // for fresh installs. Users reported "feels slow" because they
    // were waiting for full provider responses with no visible
    // feedback. Fresh wizard installs now opt INTO streaming by
    // default; existing users with explicit `streaming: false` in their
    // config keep their setting (and see a one-time per-session
    // disclosure from chatSession.ts — see runAgentTurn's
    // streaming-warning logic).
    streaming: true,
  },
  memory: {
    provider: 'default',
  },
};

const KNOWN_KEYS = new Set([
  'model',
  'agent',
  'display',
  'providers',
  'memory',
  // Phase 10 introduced the terminal toolset — its config block lands
  // under the top-level `terminal` key (e.g. terminal.backend = 'auto').
  'terminal',
  // v4.12 — MCP client config lives under `mcp.servers.<name>`. The value
  // is read via getDotted/getValue regardless of this set; listing it here
  // only silences the "unknown top-level key" boot warning.
  'mcp',
]);

const ENV_REF_RE = /\$\{([^}]+)\}/g;

/** Recursively interpolate `${VAR}` against `process.env`, leaving misses literal. */
function expandEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF_RE, (whole, name: string) => {
      const v = process.env[name];
      return v !== undefined ? v : whole;
    });
  }
  if (Array.isArray(value)) return value.map(expandEnvVars);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVars(v);
    }
    return out;
  }
  return value;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function getDotted(obj: unknown, key: string): unknown {
  const parts = key.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setDotted(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    const next = cur[p];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * v4.12.1 Pillar 2 — resolve the configured autonomy level. Explicit
 * `agent.autonomy` wins; otherwise derive from `approval_mode` (back-compat,
 * → 'Assistant'). Invalid values fall back to the derived default rather than
 * throwing — a typo must never silently RAISE autonomy.
 */
export function resolveConfiguredAutonomyLevel(config: {
  getValue<T = unknown>(key: string, fallback?: T): T;
}): AutonomyLevel {
  const raw = config.getValue<string | undefined>('agent.autonomy', undefined);
  if (isAutonomyLevel(raw)) return raw;
  const mode = config.getValue<'manual' | 'smart' | 'off'>('agent.approval_mode', 'smart');
  return levelFromApprovalMode(mode);
}

export class ConfigManager implements ConfigProvider {
  private cfg: AidenConfig = deepClone(DEFAULT_CONFIG);
  private rawText: string | null = null;

  constructor(private readonly paths: AidenPaths) {}

  /** Read config.yaml from disk and merge over the defaults. */
  async load(): Promise<AidenConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(this.paths.configYaml, 'utf8');
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        this.cfg = deepClone(DEFAULT_CONFIG);
        this.rawText = null;
        return this.cfg;
      }
      throw err;
    }
    this.rawText = raw;
    this.cfg = parseAndMerge(raw);
    return this.cfg;
  }

  /** Persist the in-memory config back to disk (creates the directory). */
  async save(config?: AidenConfig): Promise<void> {
    if (config) this.cfg = config;
    await fs.mkdir(path.dirname(this.paths.configYaml), { recursive: true });
    const dumped = yaml.dump(this.cfg, { lineWidth: 120, noRefs: true });
    await fs.writeFile(this.paths.configYaml, dumped, 'utf8');
    this.rawText = dumped;
  }

  /**
   * ConfigProvider — used by RuntimeResolver to fetch
   * `providers.{id}.apiKey` and similar dotted keys. Returns the env-
   * expanded string value, or undefined when missing / not a string.
   */
  get(key: string): string | undefined {
    const v = getDotted(this.cfg, key);
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') {
      const expanded = expandEnvVars(v);
      return typeof expanded === 'string' ? expanded : undefined;
    }
    return undefined;
  }

  /** Typed getter with default fallback. */
  getValue<T = unknown>(key: string, defaultValue?: T): T | undefined {
    const v = getDotted(this.cfg, key);
    if (v === undefined || v === null) return defaultValue;
    return expandEnvVars(v) as T;
  }

  /** Set a dotted key; persistence happens on save(). */
  set(key: string, value: unknown): void {
    setDotted(this.cfg as Record<string, unknown>, key, value);
  }

  /** Re-read from disk. Returns true when the parsed config differs. */
  async reload(): Promise<boolean> {
    const previous = JSON.stringify(this.cfg);
    await this.load();
    return JSON.stringify(this.cfg) !== previous;
  }

  /** Read access to the merged config (for tests + diagnostic surfaces). */
  snapshot(): AidenConfig {
    return deepClone(this.cfg);
  }
}

function parseAndMerge(raw: string): AidenConfig {
  let parsed: unknown = {};
  try {
    parsed = yaml.load(raw) ?? {};
  } catch (err) {
    // Surface a clearer error than js-yaml's stack — config.yaml is
    // user-edited, so a syntax error must be visible.
    throw new Error(
      `Failed to parse config.yaml: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return deepClone(DEFAULT_CONFIG);
  }

  const out = deepClone(DEFAULT_CONFIG) as AidenConfig;
  const userObj = parsed as Record<string, unknown>;

  for (const [k, v] of Object.entries(userObj)) {
    if (!KNOWN_KEYS.has(k)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[config] Unknown top-level key '${k}' in config.yaml — preserved verbatim. ` +
          'Ignore if this is from a newer Aiden version.',
      );
      out[k] = v;
      continue;
    }
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === 'object' &&
      !Array.isArray(out[k])
    ) {
      out[k] = {
        ...(out[k] as Record<string, unknown>),
        ...(v as Record<string, unknown>),
      };
    } else {
      out[k] = v;
    }
  }
  return out;
}
