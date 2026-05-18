/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subagent/spawnPause.ts — v4.6 Phase 3A.
 *
 * Operator kill-switch for sub-agent spawning. When PAUSED, any new
 * `spawn_sub_agent` or `subagent_fanout` invocation returns a typed
 * failure envelope (`errorCode: 'SUBAGENT_SPAWN_PAUSED'`) BEFORE any
 * runs row is written, child agent built, or provider hit. In-flight
 * children continue uninterrupted — the gate is at tool-handler
 * entry only.
 *
 * Storage: a file marker at `$aidenHome/spawn.paused` (the
 * `paths.root` returned by `resolveAidenPaths()`). This choice
 * differs deliberately from the reference multi-agent system, whose
 * pause flag is an in-process boolean — Aiden's REPL, daemon, and
 * MCP server can all coexist on the same machine, so a single
 * shared marker file is the cheapest way to coordinate pause state
 * across all three runtimes. The marker survives process restart;
 * the boot card surfaces a "spawn-paused" indicator so an operator
 * who forgot they paused last week doesn't sit confused.
 *
 * Marker format: a single-line JSON document
 *   { pausedAt: number; reason: string | null; pausedBy: string }
 *
 * Atomic writes: every `pause()` writes to a sibling `.tmp` path
 * and renames atomically so a concurrent reader can never observe
 * a half-written file. `status()` tolerates an unreadable marker
 * (returns `{paused: true}` with no metadata) rather than crashing
 * — the marker EXISTING is the durable fact; the JSON payload is
 * forensic detail.
 *
 * Module-level singleton: `initSpawnPause({aidenHome})` then
 * `getSpawnPause()`. Mirrors the `runtimeToggles` pattern in
 * `core/v4/runtimeToggles.ts` but does NOT route through it —
 * runtimeToggles is config-yaml backed (no per-toggle metadata
 * field), and the reason/pausedAt/pausedBy fields are first-class
 * here.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

export interface SpawnPauseMarker {
  /** Epoch milliseconds the pause was applied. */
  pausedAt: number;
  /**
   * Optional human reason ("deploy window", "runaway fanout 11:42",
   * etc). Null when the operator paused without supplying one.
   */
  reason: string | null;
  /**
   * Which runtime applied the pause — `'repl' | 'daemon' | 'mcp' |
   * 'unknown'`. Forensic only; the pause itself is global. Helps
   * operators correlate "I paused via /spawn-pause" vs "the daemon
   * paused itself on a runaway condition" (the latter isn't yet
   * automated but the field reserves the surface).
   */
  pausedBy: string;
}

export interface SpawnPauseStatus {
  paused: boolean;
  pausedAt?: number;
  reason?: string | null;
  pausedBy?: string;
  /** Milliseconds since `pausedAt` — computed at status read. */
  durationMs?: number;
}

export interface SpawnPauseOptions {
  /**
   * Aiden user-data root (`paths.root` from `resolveAidenPaths()`).
   * The marker file lives at `<aidenHome>/spawn.paused`.
   */
  aidenHome: string;
  /** Override the wall clock — used by tests. Defaults to `Date.now`. */
  now?: () => number;
}

// ── Implementation ───────────────────────────────────────────────────────

const MARKER_FILENAME = 'spawn.paused';

/**
 * File-marker-backed pause state. Concurrent processes (REPL, daemon,
 * MCP server) all read/write the same marker, so flipping pause from
 * a REPL slash command is observed by an MCP-mode `subagent_fanout`
 * call within milliseconds (next read).
 */
export class SpawnPauseState {
  private readonly markerPath: string;
  private readonly now: () => number;

  constructor(opts: SpawnPauseOptions) {
    this.markerPath = path.join(opts.aidenHome, MARKER_FILENAME);
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Hot path — called at the top of every `spawn_sub_agent` and
   * `subagent_fanout` invocation. MUST stay cheap (single
   * `fs.existsSync`). The metadata read is deferred to `status()`.
   *
   * Any error (FS busy, permission, etc.) silently returns
   * `false` — failing-open is the right default because a paused
   * state that operators can't query/clear due to FS hiccups would
   * brick the whole spawning surface.
   */
  isPaused(): boolean {
    try {
      return fs.existsSync(this.markerPath);
    } catch {
      return false;
    }
  }

  /**
   * Apply the pause marker. Atomic via tmp-file + rename so a
   * mid-write status read never sees corrupt JSON. Idempotent —
   * pausing while already paused just overwrites the marker (which
   * is the right semantic for "re-pause with a fresh reason").
   */
  pause(opts: { reason?: string | null; pausedBy: string }): void {
    const payload: SpawnPauseMarker = {
      pausedAt: this.now(),
      reason:   opts.reason ?? null,
      pausedBy: opts.pausedBy,
    };
    const tmpPath = `${this.markerPath}.tmp`;
    fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { encoding: 'utf8' });
    fs.renameSync(tmpPath, this.markerPath);
  }

  /**
   * Clear the pause marker. Idempotent — ENOENT (already resumed)
   * is treated as success, so two operators calling resume back-
   * to-back don't error on the second.
   */
  resume(): void {
    try {
      fs.unlinkSync(this.markerPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw e;
    }
  }

  /**
   * Read the current pause state with metadata. When the marker
   * exists but is unreadable / malformed JSON, returns
   * `{paused: true}` with no metadata fields — the EXISTENCE of
   * the marker is the durable contract; the JSON payload is best-
   * effort forensic detail.
   */
  status(): SpawnPauseStatus {
    if (!this.isPaused()) {
      return { paused: false };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.markerPath, 'utf8');
    } catch {
      return { paused: true };
    }
    let parsed: SpawnPauseMarker;
    try {
      parsed = JSON.parse(raw) as SpawnPauseMarker;
    } catch {
      return { paused: true };
    }
    const pausedAt = typeof parsed.pausedAt === 'number' ? parsed.pausedAt : undefined;
    return {
      paused:     true,
      pausedAt,
      reason:     parsed.reason ?? null,
      pausedBy:   parsed.pausedBy ?? 'unknown',
      durationMs: pausedAt !== undefined ? Math.max(0, this.now() - pausedAt) : undefined,
    };
  }
}

// ── Module-level singleton ───────────────────────────────────────────────

let _singleton: SpawnPauseState | null = null;

/**
 * Initialize the process-wide pause state. Called once at boot
 * (REPL: `buildAgentRuntime`; daemon: dispatcher bootstrap; MCP:
 * `wireSubagentFanout`). Subsequent calls REPLACE the singleton —
 * tests rely on this to swap the marker dir cleanly.
 */
export function initSpawnPause(opts: SpawnPauseOptions): SpawnPauseState {
  _singleton = new SpawnPauseState(opts);
  return _singleton;
}

/**
 * Read the current singleton. Throws if `initSpawnPause` hasn't
 * been called yet — the spawn / fanout tool handlers cannot
 * function without it, and a silent fallback to "not paused" would
 * defeat the kill-switch's purpose. Boot wiring is responsible for
 * calling init before any tool handler can fire.
 *
 * For environments that genuinely don't have a marker dir (some
 * test contexts), call `initSpawnPause({aidenHome: <tmp>})` with
 * a throwaway path.
 */
export function getSpawnPause(): SpawnPauseState {
  if (!_singleton) {
    throw new Error(
      'spawnPause: not initialized — call initSpawnPause({aidenHome}) at boot. ' +
      'This usually means a sub-agent tool handler fired before runtime wiring completed.',
    );
  }
  return _singleton;
}

/**
 * Test-only — reset the singleton so the next `initSpawnPause`
 * call wires a fresh state. Production callers should never need
 * this; `initSpawnPause` is already idempotent for re-init.
 */
export function _resetSpawnPauseForTests(): void {
  _singleton = null;
}
