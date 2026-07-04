/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/pillarEvents.ts — v4.12.1 Pillar 4 Slice 1, Phase 1.
 *
 * Emit the Pillar 1/2/3 surfaces as events on the SAME live seam the REPL
 * already uses (a live subscriber callback + durable emitEventRich), so the
 * glass dashboard renders ONE stream with no DB round-trip. Reuses the shared
 * `categorizeEvent` taxonomy — never invents a parallel event system.
 *
 *   artifact_verified   — Pillar 3 task verdict (completed / …_unverified /
 *                         verification_failed) + handle count.
 *   autonomy_changed    — Pillar 2 dial level set (Observer/Assistant/Partner).
 *   subagent_escalation — Pillar 2/3 child escalated a mutating op to parent.
 *   needs_confirmation  — Pillar 1 ledger: an external send needs the user.
 *   cost_updated        — throttled (≤1/sec) live cost/token tick.
 */
import { categorizeEvent } from './daemon/eventCategories';

export interface PillarEventSink {
  /** Durable run-event store (optional — absent in tests / headless). */
  runStore?: { emitEventRich(opts: Record<string, unknown>): number };
  runId?:    number | null;
  /** Live in-process subscriber — the dashboard renders from this. */
  onEvent?:  (name: string, payload: Record<string, unknown>) => void;
}

/** Fire one Pillar event: live subscriber first (immediate render), then
 *  durable persistence through the shared taxonomy. Never throws. */
export function emitPillarEvent(
  sink: PillarEventSink,
  name: string,
  payload: Record<string, unknown>,
): void {
  try { sink.onEvent?.(name, payload); } catch { /* subscriber must never break dispatch */ }
  if (sink.runStore && sink.runId !== null && sink.runId !== undefined) {
    try {
      const tags = categorizeEvent(name);
      sink.runStore.emitEventRich({
        runId:      sink.runId,
        category:   tags.category,
        kind:       tags.kind,
        name,
        payload,
        visibility: 'system',
        source:     'repl',
      });
    } catch { /* persistence faults must never break dispatch */ }
  }
}

// ── Typed convenience emitters (payload shape lives in one place) ────────────

export function emitArtifactVerified(
  sink: PillarEventSink,
  v: { verdict: string; verified: boolean; handles: number; taskId?: string },
): void {
  emitPillarEvent(sink, 'artifact_verified', v);
}

export function emitAutonomyChanged(sink: PillarEventSink, v: { level: string; by: 'boot' | 'user' }): void {
  emitPillarEvent(sink, 'autonomy_changed', v);
}

export function emitSubagentEscalation(
  sink: PillarEventSink,
  v: { tool: string; reason?: string; childRunId?: string },
): void {
  emitPillarEvent(sink, 'subagent_escalation', v);
}

export function emitNeedsConfirmation(sink: PillarEventSink, v: { tool: string; target?: string; reason?: string }): void {
  emitPillarEvent(sink, 'needs_confirmation', v);
}

export function emitCostUpdated(sink: PillarEventSink, v: { inputTokens: number; outputTokens: number; totalTokens: number }): void {
  emitPillarEvent(sink, 'cost_updated', v);
}

/**
 * v4.14 Pillar 6 Slice B — a skill that was active in a finalized run, tagged
 * with the run's verdict-derived outcome + the skill's rolling trust. Flows on
 * the SAME stream as artifact_verified so the cockpit reads skill health there.
 */
export function emitSkillOutcome(
  sink: PillarEventSink,
  v: { skill: string; outcome: 'pass' | 'fail'; verdict: string; passRate: number | null; quarantine: boolean },
): void {
  emitPillarEvent(sink, 'skill_outcome', v);
}
