/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/greeter/types.ts — v4.9.3 SLICE 1a.
 *
 * Shared types for the boot greeter. Kept in one file so the rest of
 * the module imports a single typed surface — no circular-import risk
 * when scan / history / selectOffer / templates reference each other.
 */

// ── Offer + Template ----------------------------------------------------

/**
 * Stable template ids. Each maps to exactly one template function in
 * cli/v4/greeter/templates.ts. Tier-1 ids (daemon-crashed,
 * hook-auto-disabled) are wired here as forward declarations — v4.10
 * will ship the daemon-log + hook-registry scanners that actually
 * produce these offers. Slice 1 never selects them.
 */
export type TemplateId =
  | 'daemon-crashed'           // Tier 1 (stub — scanner deferred to v4.10)
  | 'hook-auto-disabled'       // Tier 1 (stub — scanner deferred to v4.10)
  | 'continuity-open-item'     // Tier 2
  | 'continuity-decision'      // Tier 2
  | 'welcome-back'             // Tier 2 (always fires when no other tier 2 wins)
  | 'time-of-day-evening'      // Tier 3
  | 'cwd-changed'              // Tier 3
  | 'update-available';        // Tier 4

/** Selection-tier ordering. 1 wins over 2 wins over 3 wins over 4. */
export type Tier = 1 | 2 | 3 | 4;

/**
 * The thing the greeter is about to render — already-rendered text plus
 * the metadata needed to persist it into history for next-boot
 * reconciliation.
 */
export interface Offer {
  /**
   * Unique offer id — includes date / version / cwd-hash so decay
   * applies per-context, not blanket. Examples:
   *   "update-available-4.9.4"
   *   "welcome-back-2026-05-24"
   *   "cwd-changed-2026-05-24"
   */
  id:               string;
  templateId:       TemplateId;
  tier:             Tier;
  /**
   * Optional slash-command-shape string the user would type to "accept"
   * this offer. Null for greeting-only offers (welcome-back,
   * time-of-day-evening, cwd-changed). Used by reconciliation on the
   * next boot to detect passive acceptance — e.g. "update-available-4.9.4"
   * has expectedAction "/update install"; if next-boot scan shows
   * installed >= 4.9.4 the offer is marked accepted.
   */
  expectedAction?:  string;
  /** Final rendered text. Already paint-decorated. No trailing newline. */
  speech:           string;
}

// ── Template context ----------------------------------------------------

/**
 * Bag passed to template functions. Holds the data fields plus two
 * paint helpers (muted from display.paint, accent from core/v4/ui/theme).
 * Templates accept these as parameters so the templates themselves are
 * pure functions — no module-level imports of the paint engine, no
 * environment reads. Identical ctx in → identical string out.
 */
export interface TemplateContext {
  installed?:   string;
  latest?:      string;
  hoursAgo?:    number;
  openItem?:    string;
  decision?:    string;
  cwd?:         string;
  previousCwd?: string;
  paintMuted:   (s: string) => string;
  paintAccent:  (s: string) => string;
}

// ── Scan result ---------------------------------------------------------

/**
 * Aggregate output of all scanners. Fed into selectOffer. Pure value
 * type — no IO, no callbacks.
 */
export interface ScanResult {
  /** Local hour [0..23]. */
  hourOfDay:              number;
  /** True iff cwd differs from history.lastCwd. False on first launch. */
  cwdChanged:             boolean;
  cwd:                    string;
  /** Hours since the most recent distillation file. null = no prior session. */
  hoursSinceLastSession:  number | null;
  /** Set when an update check found a newer version. Null otherwise. */
  update:                 { latest: string; installed: string } | null;
}

// ── Greeter history (persisted) -----------------------------------------

export interface GreeterOfferRecord {
  id:              string;
  offeredAt:       string;          // ISO-8601
  /**
   * What action the user would have to take to "accept" this offer.
   * Null for greeting-only offers. Reconciliation uses this to decide
   * whether to look for an acceptance signal on the next boot.
   */
  expectedAction?: string;
  /**
   * Set during reconciliation on a later boot. Undefined while pending;
   * 'accepted' or 'ignored' after the reconcile pass runs.
   */
  response?:       'ignored' | 'accepted';
}

export interface GreeterHistory {
  v:               1;
  firstLaunchAt:   string;          // ISO-8601 — never mutated after first write
  lastGreetingAt:  string;          // ISO-8601 — updated on every renderGreeter call
  /**
   * ISO-8601 — the durable "last real session" marker. Written = now on
   * EVERY boot (session start), so on the NEXT boot the value read here is
   * the previous session's start time — the reliable basis for the
   * "welcome back" time-gap. Session-start is chosen over clean-exit because
   * boot always happens; an exit handler can be skipped by a crash, a
   * `kill -9`, or a closed terminal. Optional for back-compat: files written
   * before this field existed fall back to `lastGreetingAt` (which the
   * greeter has always rewritten every boot).
   *
   * Bug-fix note (v4.14): the pre-fix greeter derived "hours since last
   * session" from the newest distillation file's mtime — a value that only
   * refreshes when a distillation is written, NOT on ordinary use. That made
   * the banner freeze on a stale number ("934h ago") every boot. This field
   * is the durable replacement.
   */
  lastSessionAt?:  string;
  lastCwd?:        string;
  offers:          GreeterOfferRecord[];
  /** Kill switch from /greeter off. Defaults to false. */
  disabled:        boolean;
}

// ── Decay windows -------------------------------------------------------

/** Days an "ignored" update offer remains suppressed. */
export const DECAY_DAYS_UPDATE      = 7;
/** Days an "ignored" environment offer (cwd, time-of-day) remains suppressed. */
export const DECAY_DAYS_ENVIRONMENT = 3;
/** Hours since last session before welcome-back fires. */
export const WELCOME_BACK_THRESHOLD_HOURS = 24;
