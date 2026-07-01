/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import { getRuntimeToggles } from './runtimeToggles';

/**
 * core/v4/sandboxConfig.ts — v4.4 Phase 1: execution-guardrail configuration.
 *
 * ★ v4.12 SH.1 honesty note: the filesystem allow/deny lists here are
 * DEFENSE-IN-DEPTH for the file_* tools ONLY — `shell_exec` does NOT consult
 * them, so under the LOCAL backend they are NOT containment (a shell command can
 * reach any path). Real process containment exists only under the Docker
 * backend (`defaultBackend='docker'`); see core/v4/executionPolicy.ts for the
 * honest floor/ceiling/router surface. Do not describe the file ACLs as a
 * "sandbox" on the local backend.
 *
 * Single source of truth for guardrail enablement + resource policies +
 * filesystem allow/deny lists + Docker hardening flags. Read from
 * environment variables at construction time (matches v4.2's TurnState
 * + v4.3's BrowserState env-driven pattern).
 *
 * Phase 1 ships the config types + reader + default-tier inference;
 * downstream phases consume:
 *   - Phase 2 — fsAllowList / fsDenyList used by file_* tools
 *   - Phase 3 — defaultBackend / resourceLimits / networkMode /
 *               persistent / idleReaperMs used by shell_exec + Docker
 *               backend (long-lived container reuse, hardening flags)
 *   - Phase 4 — dryRun used by all `mutates: true` tools
 *   - Phase 5 — riskTier annotations consumed by FailureClassifier +
 *               ApprovalEngine (as a FLOOR; patterns can escalate)
 *
 * v4.4 Phase 6 — default-on transition. AIDEN_SANDBOX is now
 * enabled by default; users opt out with `AIDEN_SANDBOX=0`. The
 * strict `!== '0'` flip mirrors v4.2 Phase 6 (TCE) + v4.3 Phase 6
 * (browser depth) semantics exactly.
 *
 * AIDEN_DRYRUN is orthogonal — independent flag, independent semantics.
 * Phase 6 does NOT flip dry-run; it stays opt-in by design (dry-run
 * is a deliberate "preview-only" mode users opt into, not a default).
 *
 * Pure module — no I/O, no side effects, no Playwright/Docker
 * dependencies. Just env-var reads + path normalization helpers.
 * Easy to unit test by passing a stubbed `env` argument.
 */

import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';

// ── Public types ────────────────────────────────────────────────────────────

/** Three-tier risk classification for tools + commands. */
export type RiskTier = 'safe' | 'caution' | 'dangerous';

export interface SandboxResourceLimits {
  /** Docker `--memory` value (e.g. `'1g'`, `'512m'`). */
  memory:    string;
  /** Docker `--cpus` value (e.g. `'2'`, `'1.5'`). */
  cpus:      string;
  /** Docker `--pids-limit` integer (process count cap inside container). */
  pidsLimit: number;
}

export interface SandboxConfig {
  /**
   * Master enable flag. v4.4 Phase 6 — default-on. Users opt out
   * with `AIDEN_SANDBOX=0`. When false, every consumer
   * short-circuits to pre-v4.4 behavior — zero overhead.
   */
  enabled: boolean;

  // ── Phase 2 — filesystem allow/deny lists ───────────────────────────────

  /**
   * Write-permitted absolute paths. Defaults cover the user's
   * common working surfaces (cwd subtree, Documents, Downloads,
   * Desktop, OS temp). Phase 2's file tools refuse writes outside
   * this list. The deny list always wins on top.
   */
  fsAllowList: ReadonlyArray<string>;
  /**
   * Read/write-denied absolute paths. Defaults cover the canonical
   * sensitive locations (.ssh, .aws, .gnupg, .env, /etc, /var, /usr).
   * Mirrors the consult-shaped deny-list pattern with realpath
   * normalization to defeat symlink bypass.
   */
  fsDenyList: ReadonlyArray<string>;

  // ── Phase 3 — shell execution backend + resource limits ────────────────

  /**
   * Default backend for shell_exec when no per-call override is set.
   * Phase 3 changes this default to `'docker'` when `enabled === true`
   * AND Docker is available; falls back to `'local'` with a warning
   * when Docker is unreachable.
   */
  defaultBackend: 'local' | 'docker';
  /**
   * Persistent filesystem toggle. When true (default), Phase 3's
   * Docker backend bind-mounts cwd to /workspace so file changes
   * survive across containers. When false, Phase 3 uses tmpfs for
   * /workspace — fully ephemeral, nothing escapes the container.
   */
  persistent: boolean;
  /**
   * Phase 3 — Docker resource caps. Applied as `--memory`, `--cpus`,
   * `--pids-limit` flags on the long-lived container.
   */
  resourceLimits: SandboxResourceLimits;
  /**
   * Phase 3 — Docker network mode. `bridge` (default) keeps network
   * access for package installs / curl; `none` is full isolation.
   * The consult-derived production default is `bridge` — `none`
   * breaks routine workflows like `npm install` / `apt-get update`.
   */
  networkMode: 'bridge' | 'none';
  /**
   * Phase 3 — container idle reap timeout in milliseconds. The
   * long-lived `docker exec` container is reused across commands
   * within a session. When no commands run for this long, a
   * background async sweep tears it down. Default 5 minutes.
   */
  idleReaperMs: number;
  /**
   * Phase 3 — Docker image used for the long-lived sandbox container.
   * Default `node:22-alpine` (small, fast pull, covers Aiden's main
   * workflows). Override via `AIDEN_SANDBOX_IMAGE` for Python-heavy
   * or polyglot workflows (e.g. `python:3.12-slim`, `debian:stable-slim`).
   */
  image: string;

  // ── Phase 4 — dry-run mode ─────────────────────────────────────────────

  /**
   * When true, all `mutates: true` tools return a `{ dryRun: true,
   * wouldRun/wouldWrite: ... }` preview instead of executing.
   * Independent of `enabled` — dry-run can run with or without
   * sandbox semantics. Phase 6 does NOT flip this default; dry-run
   * stays opt-in.
   */
  dryRun: boolean;
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_RESOURCE_LIMITS: SandboxResourceLimits = {
  memory:    '1g',
  cpus:      '2',
  pidsLimit: 256,
};

const DEFAULT_IDLE_REAPER_MS = 5 * 60 * 1000;   // 5 minutes
const DEFAULT_IMAGE          = 'node:22-alpine';

/**
 * v4.4 Phase 2 — default write-permitted paths. Real-resolved at
 * config-build time to handle symlinked HOME / cwd. Caller can
 * extend via `AIDEN_SANDBOX_ALLOW=p1:p2:...`.
 */
function buildDefaultAllowList(): string[] {
  const home    = os.homedir();
  const tmp     = os.tmpdir();
  const cwd     = process.cwd();
  const paths = [
    cwd,
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    tmp,
  ];
  return resolveRealPaths(paths);
}

/**
 * v4.4 Phase 2 — default write-denied paths. Always wins over the
 * allow list. Mirrors the consult-shaped deny-list pattern (sensitive
 * configs, system dirs).
 */
function buildDefaultDenyList(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = os.homedir();
  const paths = [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.env'),
    path.join(home, '.netrc'),
    path.join(home, '.pgpass'),
    path.join(home, '.npmrc'),
    path.join(home, '.pypirc'),
    path.join(home, '.bashrc'),
    path.join(home, '.zshrc'),
    path.join(home, '.profile'),
    // v4.12 SH.1 — cross-platform cloud/cluster credential stores.
    path.join(home, '.kube'),
    path.join(home, '.docker'),        // config.json holds registry creds
    path.join(home, '.azure'),
    path.join(home, '.config', 'gcloud'),
    '/etc',
    // v4.12 CI-green — `/var` narrowed to its actually-sensitive subdirs.
    // Denying ALL of `/var` swallowed the OS temp dir on macOS (os.tmpdir() =
    // `/var/folders/…` → realpath `/private/var/folders`, under `/private/var`),
    // which is ALLOW-listed by intent — so file_* tools were wrongly denied on
    // macOS temp files. Every sensitive `/var` location stays denied; only the
    // scratch temp dirs (`/var/folders`, `/var/tmp`) are freed.
    '/var/log',       // system + app logs (may contain secrets)
    '/var/spool',     // cron / at / print / mail spools
    '/var/mail',      // user mailboxes
    '/var/root',      // macOS root account home
    '/var/db',        // macOS system dbs (sudo, dslocal user db, …)
    '/var/audit',     // BSD/macOS audit trail
    '/var/backups',   // Debian backups (shadow/passwd snapshots)
    '/var/lib',       // Linux app state (docker, dpkg, mysql, … — creds/state)
    '/usr',
    '/boot',
    '/sys',
    '/proc',
  ];
  // v4.12 SH.1 — Windows-native credential/system stores (Aiden is Windows-first).
  // Guarded on presence (undefined env → skipped on non-Windows).
  const appData = env.APPDATA;
  const localAppData = env.LOCALAPPDATA;
  const winDir = env.SystemRoot ?? env.windir;
  if (appData) {
    paths.push(path.join(appData, 'Microsoft', 'Credentials'));
    paths.push(path.join(appData, 'Microsoft', 'Protect'));   // DPAPI master keys
    paths.push(path.join(appData, 'gcloud'));
    paths.push(path.join(appData, 'npm'));                     // may carry .npmrc
  }
  if (localAppData) {
    paths.push(path.join(localAppData, 'Microsoft', 'Credentials'));
    paths.push(path.join(localAppData, 'Google', 'Cloud SDK'));
  }
  if (winDir) {
    paths.push(path.join(winDir, 'System32', 'config'));       // SAM/SYSTEM/SECURITY hives
  }
  return resolveRealPaths(paths);
}

// ── Path normalization ──────────────────────────────────────────────────────

const _realPathCache: Map<string, string> = new Map();

/**
 * Resolve a path to its canonical absolute form. `path.resolve` first
 * (handles relative + `..`); then `fs.realpathSync` to follow symlinks.
 * Symlink resolution defeats the bypass attack where an allowlisted
 * directory contains a symlink to a denied path.
 *
 * Results cached for the lifetime of the module (paths rarely change
 * during a process; the cache hit rate is high on the file-tool path
 * where every call resolves the same handful of allowlist entries).
 *
 * Falls back gracefully when the path doesn't exist (returns the
 * resolved-but-unrealpath form) — caller may be checking a path
 * about to be created.
 */
export function resolveRealPath(input: string): string {
  if (_realPathCache.has(input)) return _realPathCache.get(input)!;
  const resolved = path.resolve(input);
  let real = resolved;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    // Path may not exist yet (e.g. file_write target). Use the
    // resolved form; symlink-bypass on a non-existent path isn't
    // a real attack vector.
  }
  _realPathCache.set(input, real);
  return real;
}

/** Resolve an array of paths to their canonical forms; deduplicate. */
function resolveRealPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const real = resolveRealPath(p);
    if (!seen.has(real)) {
      seen.add(real);
      out.push(real);
    }
  }
  return out;
}

/** Public for tests — clears the realpath cache so env-var changes
 *  in test isolation pick up fresh resolutions. Production code never
 *  calls this. */
export function _clearRealPathCacheForTests(): void {
  _realPathCache.clear();
}

// ── Env-var parsing helpers ─────────────────────────────────────────────────

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(':').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseIntSafe(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNetworkMode(raw: string | undefined): 'bridge' | 'none' {
  if (raw === 'none') return 'none';
  return 'bridge';  // bridge for unset / 'bridge' / junk
}

// ── Risk-tier inference ─────────────────────────────────────────────────────

/**
 * Default risk tier for a tool that doesn't carry an explicit
 * `riskTier` annotation. Leverages the existing `mutates: boolean`
 * field — mutating tools default to `caution`, read-only tools
 * default to `safe`. Plugin tools without annotation get a safe
 * default for free.
 *
 * Phase 5 ApprovalEngine integration treats explicit annotations as
 * a FLOOR — DANGEROUS_PATTERNS can escalate but never demote. The
 * inference here is the floor when no annotation exists at all.
 */
export function inferDefaultRiskTier(mutates: boolean): RiskTier {
  return mutates ? 'caution' : 'safe';
}

// ── Reader ──────────────────────────────────────────────────────────────────

/**
 * Pure factory. Reads env vars + defaults into a frozen-snapshot
 * SandboxConfig. Idempotent for a given env. The CLI calls this
 * once at boot via the singleton factory below; tests pass a custom
 * `env` argument.
 */
export function readSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
): SandboxConfig {
  // v4.4 Phase 6 — default-on transition. AIDEN_SANDBOX is now
  // enabled by default; users opt out with `AIDEN_SANDBOX=0`.
  //
  // v4.5 Phase 8a — the actual read goes through the runtimeToggles
  // singleton so /sandbox slash-command flips and config.yaml
  // overrides take effect without restart. When the singleton was
  // initialised by the CLI it consults env > config.yaml > default;
  // when not initialised (test bench) it falls back to env > default
  // — the existing semantics.
  //   unset / '1' / 'true' / junk → enabled
  //   '0'                          → disabled
  // Mirrors v4.2 Phase 6 (TCE) + v4.3 Phase 6 (browser depth)
  // semantics exactly. The strict `!== '0'` check matches the
  // pattern those phases set: any explicit "off" value disables;
  // everything else (including unset) enables.
  // v4.5 Phase 8a — when env (the readSandboxConfig input) is not the
  // process env (test bench passing a custom env), honour the input
  // directly to keep test isolation. Otherwise route through the
  // runtimeToggles singleton.
  const enabled = env === process.env
    ? getRuntimeToggles().isEnabled('sandbox')
    : env.AIDEN_SANDBOX !== '0';

  // Allow/deny lists: defaults + user-provided extensions.
  const customAllow = parseList(env.AIDEN_SANDBOX_ALLOW).map(resolveRealPath);
  const customDeny  = parseList(env.AIDEN_SANDBOX_DENY).map(resolveRealPath);
  const fsAllowList = Array.from(new Set([...buildDefaultAllowList(), ...customAllow]));
  const fsDenyList  = Array.from(new Set([...buildDefaultDenyList(env),  ...customDeny ]));

  // Resource limits — string values pass through Docker as-is.
  const resourceLimits: SandboxResourceLimits = {
    memory:    env.AIDEN_SANDBOX_MEMORY ?? DEFAULT_RESOURCE_LIMITS.memory,
    cpus:      env.AIDEN_SANDBOX_CPUS   ?? DEFAULT_RESOURCE_LIMITS.cpus,
    pidsLimit: parseIntSafe(env.AIDEN_SANDBOX_PIDS, DEFAULT_RESOURCE_LIMITS.pidsLimit),
  };

  const networkMode  = parseNetworkMode(env.AIDEN_SANDBOX_NETWORK);
  const persistent   = env.AIDEN_SANDBOX_PERSISTENT !== '0';  // default true
  const idleReaperMs = parseIntSafe(env.AIDEN_SANDBOX_IDLE_MS, DEFAULT_IDLE_REAPER_MS);
  const dryRun       = env.AIDEN_DRYRUN === '1';
  const image        =
    typeof env.AIDEN_SANDBOX_IMAGE === 'string' && env.AIDEN_SANDBOX_IMAGE.trim().length > 0
      ? env.AIDEN_SANDBOX_IMAGE.trim()
      : DEFAULT_IMAGE;

  // Phase 3 will route to 'docker' when enabled AND docker is
  // available. Phase 1 reports the abstract default — Phase 3's
  // runtime probe decides the actual route.
  const defaultBackend: 'local' | 'docker' = enabled ? 'docker' : 'local';

  return {
    enabled,
    fsAllowList,
    fsDenyList,
    defaultBackend,
    persistent,
    resourceLimits,
    networkMode,
    idleReaperMs,
    dryRun,
    image,
  };
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _singleton: SandboxConfig | null = null;
let _toggleHookInstalled = false;

/**
 * Read the singleton sandbox config. Initialized on first call from
 * `process.env` (matches v4.2 TurnState / v4.3 BrowserState lifecycle).
 * Tests construct fresh configs via `readSandboxConfig(env)` directly
 * — the singleton path is for production CLI startup.
 */
export function getSandboxConfig(): SandboxConfig {
  if (!_toggleHookInstalled) {
    // v4.5 Phase 8a — invalidate the singleton when /sandbox toggles.
    // Registered lazily on first read so test benches that build
    // their own runtimeToggles + reset between cases don't carry
    // hooks across instances.
    try {
      getRuntimeToggles().onChange('sandbox', () => { _singleton = null; });
      _toggleHookInstalled = true;
    } catch { /* runtimeToggles import / init race — best-effort */ }
  }
  if (!_singleton) _singleton = readSandboxConfig();
  return _singleton;
}

/**
 * v4.12 — invalidate the cached config so the next `getSandboxConfig()` rebuilds
 * it from the current `process.cwd()`. Used by `/home` after `process.chdir()`
 * so the filesystem allow-list (which snapshots cwd at build time) includes the
 * new working directory — otherwise writes into the new cwd would stay blocked
 * under an enabled sandbox. Mirrors the `/sandbox`-toggle invalidation hook.
 */
export function invalidateSandboxConfig(): void {
  _singleton = null;
}

/** Reset the singleton for test isolation. Production code never calls this. */
export function _resetSandboxConfigForTests(): void {
  _singleton = null;
  _toggleHookInstalled = false;
  _clearRealPathCacheForTests();
}
