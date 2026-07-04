/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/greeter/welcomeLine.ts — v4.14 UX polish (Bug 1).
 *
 * The warm, recall-aware "welcome back" line. Replaces the old raw-hours
 * template ("Last session ended 934h ago") with a single PURE function:
 * identical ctx in ⇒ identical string out. No clock peek (now is a param),
 * no IO, no randomness — the fallback rotation is a deterministic function
 * of `rotateSeed`.
 *
 * Three tiers, in priority order:
 *   1. RECALL  — a one-line summary of last session is known:
 *        "Welcome back! Last time: <summary>. Continue, or something new?"
 *   2. TIME-GAP — no summary, but a durable last-session timestamp exists.
 *        A HUMAN phrase only (never raw hours): earlier today / yesterday /
 *        a few days ago / last week / been a while (30d+).
 *   3. FALLBACK — no useful history at all → a short friendly line, rotated
 *        by `rotateSeed` so it isn't the same string every boot.
 *
 * One logical line. Width-safe (the recall summary is clamped). ≤1 emoji.
 */

export interface WelcomeLineContext {
  /** The reference clock. */
  now:            Date;
  /**
   * ISO-8601 timestamp of the PREVIOUS session (durable marker), or null
   * when unknown. Drives the time-gap tier.
   */
  lastSessionAt:  string | null;
  /**
   * One-line title/summary of what last session was about (from the newest
   * distillation's open item or last decision), or null when none. Drives
   * the recall tier.
   */
  recallSummary:  string | null;
  paintMuted:     (s: string) => string;
  paintAccent:    (s: string) => string;
  /**
   * Deterministic rotation index for the no-history fallback. Same seed ⇒
   * same friendly line; a changing seed (e.g. day-of-month) rotates it.
   * Defaults to 0.
   */
  rotateSeed?:    number;
}

/** Max width for the recalled summary before it's clamped with an ellipsis. */
const SUMMARY_MAX = 60;

/**
 * No-history friendly lines. Short, Aiden's voice, width-safe, ≤1 emoji.
 * Rotated deterministically by rotateSeed so the greeter doesn't say the
 * exact same thing every single boot.
 */
export const WELCOME_FALLBACKS: readonly string[] = [
  'Ready when you are.',
  "Let's build something.",
  'What are we working on?',
  'Fresh start — where to?',
];

/** Collapse whitespace/newlines to a single line and clamp the width. */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUMMARY_MAX) return flat;
  return flat.slice(0, SUMMARY_MAX - 1).trimEnd() + '…';
}

/**
 * Human phrase for an elapsed gap. Bucketed purely by elapsed duration
 * (NOT calendar boundaries) so the mapping is deterministic and matches the
 * documented contract: 23h → "earlier today", 40d → "been a while".
 *
 * Returns null when the timestamp is missing or unparseable (caller then
 * falls through to the rotate tier rather than inventing a gap).
 */
export function humanGap(lastSessionAt: string | null, now: Date): string | null {
  if (!lastSessionAt) return null;
  const then = Date.parse(lastSessionAt);
  if (Number.isNaN(then)) return null;
  const ms = now.getTime() - then;
  if (ms < 0) return 'earlier today';                 // clock skew → safest phrase
  const hours = ms / (1000 * 60 * 60);
  const days  = hours / 24;
  if (hours < 24) return 'earlier today';
  if (hours < 48) return 'yesterday';
  if (days  < 7)  return 'a few days ago';
  if (days  < 30) return 'last week';
  return 'been a while';
}

/**
 * Build the one-line welcome. Always returns a non-empty line; WHEN the
 * greeter chooses to show it (vs stay silent) is the orchestrator's call.
 */
export function buildWelcomeLine(ctx: WelcomeLineContext): string {
  // ── Tier 1: recall-aware ────────────────────────────────────────────
  const summary = ctx.recallSummary && ctx.recallSummary.trim().length > 0
    ? oneLine(ctx.recallSummary)
    : null;
  if (summary) {
    return `Welcome back! Last time: ${ctx.paintMuted(summary)}. Continue, or something new?`;
  }

  // ── Tier 2: human time-gap ──────────────────────────────────────────
  const gap = humanGap(ctx.lastSessionAt, ctx.now);
  if (gap) {
    return `Welcome back — ${gapSentence(gap)}`;
  }

  // ── Tier 3: rotate a friendly fallback ──────────────────────────────
  const seed = Number.isFinite(ctx.rotateSeed) ? Math.abs(Math.trunc(ctx.rotateSeed as number)) : 0;
  return WELCOME_FALLBACKS[seed % WELCOME_FALLBACKS.length];
}

/**
 * Wrap a bucket phrase in a natural sentence tail. Each tail CONTAINS the
 * canonical phrase verbatim so downstream copy checks stay stable.
 */
function gapSentence(gap: string): string {
  switch (gap) {
    case 'earlier today':  return 'you were here earlier today.';
    case 'yesterday':      return 'last session was yesterday.';
    case 'a few days ago': return 'last time was a few days ago.';
    case 'last week':      return 'last session was last week.';
    default:               return "it's been a while.";      // 'been a while'
  }
}
