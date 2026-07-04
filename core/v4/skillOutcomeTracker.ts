/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillOutcomeTracker.ts — Phase v4.1.2-slice4.
 *
 * Track whether skills actually succeed when loaded. The mining-time
 * confidence score (skillMining/skillMiner.ts:computeConfidence) is
 * set once and never updated — skills that consistently produce bad
 * tool-call traces stay confident; skills that consistently work well
 * never accumulate evidence of that.
 *
 * Mechanism:
 *   - When `skill_view` fires (the model just received a skill body),
 *     open an attribution WINDOW for that skill: the next N tool calls
 *     are attributed as that skill's downstream outcomes.
 *   - Tool successes / failures attributed to the skill (counter-bump).
 *   - Another `skill_view` supersedes the window (last-write-wins).
 *   - Window closes after N tool calls or when superseded.
 *
 * What this is NOT:
 *   - Not a quality judge. We don't ask an LLM "did that skill help?".
 *     Tool success is a proxy — a noisy one — but it's deterministic
 *     and free. Per slice4 Phase 3 decision tree: Option A.
 *   - Not a promotion engine. Surfaced via `aiden doctor`; the existing
 *     SkillTeacher.flaggedSkillNames() flagging path stays dead (it
 *     would change SkillLoader behavior — separate decision).
 *
 * Persistence:
 *   `<skillsDir>/.skill-outcomes.json` — sidecar, atomic write
 *   (tmp + rename), best-effort failure handling via slice3
 *   SubsystemHealthTracker. Lazy hydrate on first `onTool` call so
 *   sessions that never load a skill pay zero disk I/O.
 *
 * Status: PHASE v4.1.2-slice4.
 */

import { promises as fs, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import type {
  ToolCallRequest,
  ToolCallResult,
} from '../../providers/v4/types';
import type { SubsystemHealthTracker } from './subsystemHealth';
import {
  foldOutcomes, isQuarantineCandidate, emptyRolling,
  type RollingReliability, type ReliabilityOutcome,
} from './reliability';
import { emitSkillOutcome, type PillarEventSink } from './pillarEvents';

/**
 * Per-skill outcome record persisted to `.skill-outcomes.json`.
 *
 * v4.14 Pillar 6 Slice B — trust now folds through the SAME rolling-reliability
 * record the Pillar-5 eval path uses (rolling pass-rate + quarantine). The
 * primary signal is the run's real task VERDICT (completed → pass,
 * verification_failed → fail), not the old noisy tool-success window; the
 * attribution window survives only to attach a `lastError` for context.
 */
export interface SkillOutcome {
  skillName:   string;
  /** Times `skill_view` fired with this name (usage frequency). */
  loaded:      number;
  /** Rolling trust: last-N verdict outcomes, rolling pass-rate, quarantine. */
  reliability: RollingReliability;
  /** ISO timestamp of the most recent `skill_view` for this skill. */
  lastUsed?:   string;
  /** Length-capped message of the most recent attributed tool failure. */
  lastError?:  { message: string; at: string };
}

/**
 * Attribution window size — number of non-skill_view tool calls
 * following a `skill_view` whose outcomes are attributed to that
 * skill. Hard-coded per slice4 Phase 3 Q1: don't add config knobs
 * we won't tune. If empirical signal shows 5 is wrong, change it
 * here.
 */
export const ATTRIBUTION_WINDOW = 5;

/** Cap for `lastError.message` — keep snapshots small. */
const ERROR_MESSAGE_CAP = 200;

/**
 * The phase argument carried by `AidenAgentOptions.onToolCall` —
 * imported as a string-literal union to avoid a cyclic dep.
 */
export type ToolCallPhase = 'before' | 'after';

export class SkillOutcomeTracker {
  /** Currently-loaded skill (last skill_view, while its window is open). */
  private currentSkill: string | null = null;
  /** Tool calls remaining in the current attribution window (lastError only). */
  private remaining    = 0;
  /** Skills skill_view'd since the last verdict — graded together at finalize. */
  private activeThisTurn: Set<string> = new Set();
  /** In-memory outcomes, keyed by skill name. Hydrated lazily. */
  private outcomes: Map<string, SkillOutcome> = new Map();
  /** True once we've attempted hydration from disk. */
  private hydrated     = false;
  /** Promise of the in-flight persist, if any (we coalesce). */
  private persisting?: Promise<void>;
  /** Pending persist requested while one is in flight. */
  private persistQueued = false;

  /**
   * @param persistPath     Absolute path to the sidecar JSON file.
   * @param healthTracker   Optional slice3 tracker for persist failures.
   */
  constructor(
    private readonly persistPath:    string,
    private readonly healthTracker?: SubsystemHealthTracker,
  ) {}

  /**
   * Unified hook compatible with `AidenAgentOptions.onToolCall`.
   * The agent fires it as `(call, 'before')` then `(call, 'after', result)`.
   */
  onTool(
    call:   ToolCallRequest,
    phase:  ToolCallPhase,
    result?: ToolCallResult,
  ): void {
    if (phase === 'before') this.onToolBefore(call);
    else                     this.onToolAfter(call, result);
  }

  /** Called before each tool. Opens / supersedes the attribution window. */
  onToolBefore(call: ToolCallRequest): void {
    if (call.name !== 'skill_view') return;
    const name = extractSkillName(call.arguments);
    if (!name) return;
    // Hydrate synchronously so the bump below merges with any prior
    // persisted state. The file is small (one row per ever-loaded
    // skill), so the one-time sync read is cheap and avoids the
    // ordering hazard of awaiting in an inherently sync hook.
    this.ensureHydratedSync();
    this.currentSkill = name;
    this.remaining    = ATTRIBUTION_WINDOW;
    this.activeThisTurn.add(name);   // graded at the turn's verdict
    this.bump(name, (o) => {
      o.loaded   += 1;
      o.lastUsed  = new Date().toISOString();
    });
    void this.queuePersist();
  }

  /**
   * Called after each tool. Attributes success/failure to the currently
   * open window. `skill_view` itself does NOT attribute back to itself
   * (the window's purpose is to grade DOWNSTREAM tools).
   */
  onToolAfter(call: ToolCallRequest, result?: ToolCallResult): void {
    if (call.name === 'skill_view')        return;
    if (!this.currentSkill || this.remaining <= 0) return;

    // v4.14 — the window no longer bumps a pass/fail counter (the verdict does
    // that at finalize); it survives only to attach a `lastError` for context.
    if (isFailure(result)) {
      const msg = extractErrorMessage(result);
      if (msg) {
        this.bump(this.currentSkill, (o) => {
          o.lastError = { message: truncate(msg, ERROR_MESSAGE_CAP), at: new Date().toISOString() };
        });
        void this.queuePersist();
      }
    }
    this.remaining -= 1;
    if (this.remaining === 0) this.currentSkill = null;
  }

  /**
   * v4.14 Pillar 6 Slice B — grade every skill used this turn against the run's
   * REAL task verdict, folding one outcome into each skill's rolling record and
   * emitting a `skill_outcome` event. `completed` / `completed_unverified` →
   * pass; `verification_failed` / `failed` → fail. Called once at finalization
   * (chatSession, where computeTaskFinalization runs). Safe: an emit failure
   * never propagates, and the verdict fold never throws into the turn.
   */
  recordTurnVerdict(verdict: string, sink?: PillarEventSink): void {
    if (this.activeThisTurn.size === 0) return;
    try {
      this.ensureHydratedSync();
      const outcome: ReliabilityOutcome =
        (verdict === 'completed' || verdict === 'completed_unverified') ? 'pass' : 'fail';
      for (const name of this.activeThisTurn) {
        this.bump(name, (o) => { o.reliability = foldOutcomes(o.reliability, [outcome]); });
        const rec = this.outcomes.get(name)!;
        if (sink) {
          try {
            emitSkillOutcome(sink, {
              skill:      name,
              outcome,
              verdict,
              passRate:   rec.reliability.rollingPassRate,
              quarantine: isQuarantineCandidate(rec.reliability),
            });
          } catch { /* telemetry must never break the turn */ }
        }
      }
      void this.queuePersist();
    } catch { /* trust bookkeeping must never break the turn */ }
    finally {
      this.activeThisTurn.clear();
      this.currentSkill = null;
      this.remaining    = 0;
    }
  }

  /**
   * Read-only snapshot for `aiden doctor`. Sorted by `loaded` descending
   * so the most-used skills surface first.
   */
  snapshot(): SkillOutcome[] {
    const arr = Array.from(this.outcomes.values());
    arr.sort((a, b) => b.loaded - a.loaded);
    return arr;
  }

  /** Total skills with at least one observation. */
  size(): number {
    return this.outcomes.size;
  }

  // ── private ───────────────────────────────────────────────────────

  private bump(skillName: string, mutator: (o: SkillOutcome) => void): void {
    const cur = this.outcomes.get(skillName) ?? {
      skillName,
      loaded:      0,
      reliability: emptyRolling(),
    };
    mutator(cur);
    this.outcomes.set(skillName, cur);
  }

  /**
   * Synchronous disk-hydration. Called once per instance lifetime on
   * the first `skill_view` observation. The sidecar is small (one row
   * per ever-loaded skill) so a sync read is cheap and removes the
   * race between async hydration and immediately-following bumps.
   *
   * Failures (parse, EACCES) get recorded into the health tracker —
   * doctor surfaces them. ENOENT (no file yet) is the common case on
   * first run and stays silent.
   */
  private ensureHydratedSync(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      if (!existsSync(this.persistPath)) return;
      const raw    = readFileSync(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, val] of Object.entries(parsed as Record<string, unknown>)) {
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const v = val as Partial<SkillOutcome>;
            // v4.14 — tolerate the pre-migration shape (toolSuccesses/Failures,
            // no `reliability`): keep loaded/lastError, start the rolling record
            // fresh. One tracker, migrated cleanly — no parallel sidecar.
            const rel = v.reliability;
            this.outcomes.set(name, {
              skillName:   v.skillName ?? name,
              loaded:      Number(v.loaded ?? 0),
              reliability: rel && typeof rel === 'object' && Array.isArray(rel.lastOutcomes) ? rel : emptyRolling(),
              ...(v.lastUsed  ? { lastUsed:  v.lastUsed  } : {}),
              ...(v.lastError ? { lastError: v.lastError } : {}),
            });
          }
        }
      }
    } catch (err) {
      this.healthTracker?.recordFailure(err);
    }
  }

  /**
   * Test/shutdown seam. Awaits any in-flight or queued persist so the
   * caller knows the sidecar is on disk. The agent runtime doesn't
   * need to call this (writes are durable enough via the coalescing
   * queue); tests use it to deterministically wait for I/O.
   */
  async flush(): Promise<void> {
    while (this.persisting) {
      await this.persisting;
    }
  }

  /**
   * Coalescing persist. If a write is in flight, queue exactly one
   * follow-up; further requests collapse into that single follow-up.
   * Keeps disk I/O cheap when many tool calls happen in a burst.
   */
  private queuePersist(): Promise<void> {
    if (this.persisting) {
      this.persistQueued = true;
      return this.persisting;
    }
    this.persisting = this.persist()
      .finally(() => {
        const wasQueued = this.persistQueued;
        this.persistQueued = false;
        this.persisting    = undefined;
        if (wasQueued) {
          // Fire-and-forget the queued follow-up.
          void this.queuePersist();
        }
      });
    return this.persisting;
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      const payload: Record<string, SkillOutcome> = {};
      for (const [k, v] of this.outcomes) payload[k] = v;
      const tmp = `${this.persistPath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
      await fs.rename(tmp, this.persistPath);
      this.healthTracker?.recordSuccess();
    } catch (err) {
      this.healthTracker?.recordFailure(err);
      // Best-effort: clean up tmp file if it exists. Ignore errors.
      try { await fs.unlink(`${this.persistPath}.tmp`); } catch { /* ignore */ }
    }
  }
}

// ── private helpers ───────────────────────────────────────────────────

function extractSkillName(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const v = (args as { name?: unknown }).name;
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Failure classification rules (per slice4 Phase 3 explicit decision):
 *   - result.success === false   → failure
 *   - result.error truthy        → failure
 *   - everything else            → success
 *
 * "Tool succeeded but result was wrong" is NOT classifiable without an
 * LLM judge and is intentionally out of scope.
 */
export function isFailure(result: ToolCallResult | undefined): boolean {
  if (!result) return false;
  // The ToolCallResult shape from providers/v4/types is { id, name, result }.
  // Tool implementations conventionally return `{ success: boolean, error?, ... }`
  // inside the `result` payload — both are surveyed.
  const top = result as { error?: unknown; success?: unknown };
  if (top.error) return true;
  if (top.success === false) return true;
  const inner = (result as { result?: unknown }).result;
  if (inner && typeof inner === 'object') {
    const i = inner as { error?: unknown; success?: unknown };
    if (i.error)            return true;
    if (i.success === false) return true;
  }
  return false;
}

function extractErrorMessage(result: ToolCallResult | undefined): string {
  if (!result) return '';
  const top = result as { error?: unknown };
  if (typeof top.error === 'string') return top.error;
  if (top.error && typeof top.error === 'object') {
    const m = (top.error as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  const inner = (result as { result?: unknown }).result;
  if (inner && typeof inner === 'object') {
    const i = inner as { error?: unknown };
    if (typeof i.error === 'string') return i.error;
    if (i.error && typeof i.error === 'object') {
      const m = (i.error as { message?: unknown }).message;
      if (typeof m === 'string') return m;
    }
  }
  return '';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
