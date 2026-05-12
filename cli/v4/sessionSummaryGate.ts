/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/sessionSummaryGate.ts — Phase v4.1.2-followup-2.
 *
 * Pure decision helpers extracted from `ChatSession.maybeAutoSummarize`
 * so the threshold + mtime/size-grew logic is unit-testable without
 * standing up a full ChatSession + mocked agent loop.
 *
 *   shouldAutoSummarize → returns {fire: true} or
 *                         {fire: false, reason: 'short'|'unconfigured'|'no-paths'}.
 *                         ChatSession uses the reason tag to log the right
 *                         user-visible message.
 *
 *   memoryGrewBetween → strict size-or-mtime comparison so the caller can
 *                       detect "the model actually fired session_summary"
 *                       even when the tool wrote without growing the file
 *                       length (e.g. replaced a previous same-length entry).
 *
 * No I/O here. ChatSession owns the fs.stat + display.warn / display.dim.
 */

/** Minimum user-message turns required before auto-summary triggers. */
export const SESSION_SUMMARY_MIN_TURNS = 3;

export interface SessionSummaryGateInput {
  userTurns:     number;
  unconfigured:  boolean;
  memoryPath:    string | undefined;
}

export type SessionSummaryGateResult =
  | { fire: true }
  | { fire: false; reason: 'short' | 'unconfigured' | 'no-paths' };

/**
 * Decide whether the /quit auto-summary should fire. Threshold lives
 * here as the single source of truth; ChatSession imports the constant
 * so the user-facing log message ("need 3+") cites the exact value.
 */
export function shouldAutoSummarize(
  input: SessionSummaryGateInput,
): SessionSummaryGateResult {
  if (input.userTurns < SESSION_SUMMARY_MIN_TURNS) {
    return { fire: false, reason: 'short' };
  }
  if (input.unconfigured) {
    return { fire: false, reason: 'unconfigured' };
  }
  if (!input.memoryPath) {
    return { fire: false, reason: 'no-paths' };
  }
  return { fire: true };
}

export interface MemoryStat {
  size:  number;
  mtime: number;
}

/**
 * True iff MEMORY.md grew (longer) or was touched (newer mtime) between
 * the two snapshots. Used to detect whether the agent actually fired
 * the session_summary tool inside the synthetic turn — if not, the
 * user sees a warning instead of a misleading "saved" message.
 *
 * The size-OR-mtime disjunction (not just size>before) covers the case
 * where session_summary replaces an existing same-length entry: file
 * size stays the same but mtime advances.
 */
export function memoryGrewBetween(
  before: MemoryStat,
  after:  MemoryStat,
): boolean {
  if (after.size > before.size) return true;
  if (after.mtime > before.mtime) return true;
  return false;
}
