/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/greeter/selectOffer.ts — v4.9.3 SLICE 1a.
 *
 * Pure-function priority selector. Given the post-reconcile scan +
 * history + (optional) distillation snippet, returns at most one
 * `Offer` to render. Returns null when nothing wins (silence rule).
 *
 * Tier ordering: 1 > 2 > 3 > 4. Within a tier, the first detected
 * candidate wins (no scoring beyond the order listed below).
 *
 * Decay (applied per tier): an offer whose `id` exists in history.offers
 * with response === 'ignored' AND whose offeredAt is newer than the
 * per-tier window is SUPPRESSED. Exception: welcome-back has no decay —
 * it always fires when the threshold is crossed.
 */

import {
  type GreeterHistory,
  type Offer,
  type ScanResult,
  type TemplateContext,
  type TemplateId,
  DECAY_DAYS_ENVIRONMENT,
  DECAY_DAYS_UPDATE,
  WELCOME_BACK_THRESHOLD_HOURS,
} from './types';
import { TEMPLATES } from './templates';
import { buildWelcomeLine } from './welcomeLine';

/**
 * The selector takes a `paint` bag rather than building one — keeps the
 * function pure (no display dependency). Orchestrator supplies the
 * paint helpers from the live Display.
 *
 * Continuity inputs (openItem / lastDecision) are passed in
 * pre-extracted from the last distillation; this file does not touch
 * the distillation store directly so it stays pure.
 */
export interface SelectOfferInput {
  scan:           ScanResult;
  history:        GreeterHistory;
  now:            Date;
  paintMuted:     (s: string) => string;
  paintAccent:    (s: string) => string;
  /** Most-recent distillation's open_items[0] (or null when none). */
  openItem?:      string | null;
  /** Most-recent distillation's decisions[0] (or null when none). */
  lastDecision?:  string | null;
  /**
   * v4.14 Bug 1 — the durable "previous session" timestamp (ISO-8601) or
   * null. This is the RELIABLE basis for the welcome-back time-gap; the old
   * distillation-mtime path (scan.hoursSinceLastSession) froze on a stale
   * value. Supplied by the orchestrator from history.lastSessionAt.
   */
  lastSessionAt?: string | null;
  /** v4.14 Bug 1 — deterministic rotation seed for the no-history fallback. */
  rotateSeed?:    number;
}

export function selectOffer(input: SelectOfferInput): Offer | null {
  // Greeter respects the kill switch absolutely.
  if (input.history.disabled) return null;

  const today = isoDateLocal(input.now);

  // ── Tier 2: welcome / continuity ------------------------------------
  // v4.14 Bug 1 — one warm, recall-aware line via the pure buildWelcomeLine,
  // replacing the three old templates (continuity-open-item /
  // continuity-decision / the raw-hours welcome-back). It fires when EITHER:
  //   • a recall summary exists (open item preferred over last decision —
  //     open work is more actionable), regardless of elapsed time, OR
  //   • the durable last-session gap has crossed the welcome threshold.
  // The gap is computed from history.lastSessionAt (reliable), NOT the
  // frozen distillation mtime that caused the stuck "934h ago".
  const recallSummary =
    (input.openItem && input.openItem.length > 0) ? input.openItem :
    (input.lastDecision && input.lastDecision.length > 0) ? input.lastDecision :
    null;
  const gapHours = hoursSince(input.lastSessionAt ?? null, input.now);
  if (recallSummary || (gapHours !== null && gapHours >= WELCOME_BACK_THRESHOLD_HOURS)) {
    const speech = buildWelcomeLine({
      now:           input.now,
      lastSessionAt: input.lastSessionAt ?? null,
      recallSummary,
      paintMuted:    input.paintMuted,
      paintAccent:   input.paintAccent,
      rotateSeed:    input.rotateSeed,
    });
    return {
      id:         `welcome-back-${today}`,
      templateId: 'welcome-back',
      tier:       2,
      speech,
    };
  }

  // ── Tier 3: environment ---------------------------------------------
  // Both gated on no-tier-2-fired (handled implicitly by being later in
  // the function) AND not-in-3-day-decay-window.
  if (input.scan.hourOfDay >= 18) {
    const id = `time-of-day-evening-${today}`;
    if (!isDecayedRecently(id, input.history, DECAY_DAYS_ENVIRONMENT, input.now)) {
      return buildOffer('time-of-day-evening', 3, undefined, {}, input, id);
    }
  }
  if (input.scan.cwdChanged) {
    const id = `cwd-changed-${today}`;
    if (!isDecayedRecently(id, input.history, DECAY_DAYS_ENVIRONMENT, input.now)) {
      return buildOffer('cwd-changed', 3, undefined, {
        cwd:         input.scan.cwd,
        previousCwd: input.history.lastCwd,
      }, input, id);
    }
  }

  // ── Tier 4: update --------------------------------------------------
  if (input.scan.update) {
    const id = `update-available-${input.scan.update.latest}`;
    if (!isDecayedRecently(id, input.history, DECAY_DAYS_UPDATE, input.now)) {
      return buildOffer('update-available', 4, '/update install', {
        installed: input.scan.update.installed,
        latest:    input.scan.update.latest,
      }, input, id);
    }
  }

  return null;  // silence rule
}

// ── helpers ----------------------------------------------------------

/**
 * True iff history contains an `ignored` record for `id` whose age is
 * within the decay window. Pending offers do NOT suppress — only
 * ignored ones do (caller has logic for re-firing if the user just
 * didn't see it).
 */
function isDecayedRecently(
  id:        string,
  history:   GreeterHistory,
  days:      number,
  now:       Date,
): boolean {
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  return history.offers.some((o) =>
    o.id === id &&
    o.response === 'ignored' &&
    Date.parse(o.offeredAt) >= cutoffMs,
  );
}

/**
 * Elapsed hours since an ISO-8601 timestamp, or null when the timestamp is
 * missing / unparseable. v4.14 Bug 1 — drives the welcome-back time gate off
 * the durable last-session marker instead of the frozen distillation mtime.
 */
function hoursSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (now.getTime() - then) / (1000 * 60 * 60));
}

/** YYYY-MM-DD in the local timezone (matches the "good evening at 6pm
 *  local time" intent of the time-of-day scanner). */
function isoDateLocal(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function buildOffer(
  templateId:     TemplateId,
  tier:           1 | 2 | 3 | 4,
  expectedAction: string | undefined,
  data:           Omit<TemplateContext, 'paintMuted' | 'paintAccent'>,
  input:          SelectOfferInput,
  customId?:      string,
): Offer {
  const ctx: TemplateContext = {
    ...data,
    paintMuted:  input.paintMuted,
    paintAccent: input.paintAccent,
  };
  return {
    id:             customId ?? `${templateId}-${isoDateLocal(input.now)}`,
    templateId,
    tier,
    expectedAction,
    speech:         TEMPLATES[templateId](ctx),
  };
}
