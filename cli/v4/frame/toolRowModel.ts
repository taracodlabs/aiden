/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/frame/toolRowModel.ts — v4.12.1 Pillar 4 Slice 1.
 *
 * The tool-row lane's PURE state machine — one of the separate live buckets
 * (streaming text / active tools / completed trail / transcript never share a
 * string). Rows are keyed by the STABLE tool-call id (never array index) so
 * parallel calls are distinct rows and a completion updates the right one.
 *
 * Lifecycle: start(id) → active row (renders a live elapsed timer even while
 * the model is silent during a long call) → complete(id, outcome) → a
 * completed trail row → on turn end, finalizeTranscript() assembles ALL rows
 * (trail + any still-active, marked interrupted) into transcript lines BEFORE
 * clearing live state, so nothing vanishes from history. A still-running row
 * at turn end is recorded as `interrupted` — that is the render-side half of
 * the "an interrupted turn still leaves a valid transcript" guarantee.
 */

export type ToolOutcome = 'ok' | 'fail' | 'blocked' | 'cancelled' | 'interrupted';

export interface ActiveRow { id: string; name: string; startedMs: number; detail?: string; }
export interface TrailRow  { id: string; name: string; outcome: ToolOutcome; durationMs: number; detail?: string; }

const GLYPH: Record<ToolOutcome, string> = {
  ok: '✓', fail: '✗', blocked: '⛔', cancelled: '⊘', interrupted: '⊘',
};

export class ToolRowModel {
  /** Live rows, keyed by tool-call id. Order preserved for stable rendering. */
  private active = new Map<string, ActiveRow>();
  /** Completed rows in completion order. */
  private trail: TrailRow[] = [];

  /** Begin a live row. Idempotent per id (a duplicate start is ignored). */
  start(id: string, name: string, nowMs: number, detail?: string): void {
    if (this.active.has(id)) return;
    this.active.set(id, { id, name, startedMs: nowMs, detail });
  }

  /** Complete a live row → move it to the trail. Unknown id is a no-op. */
  complete(id: string, outcome: ToolOutcome, nowMs: number, detail?: string): void {
    const row = this.active.get(id);
    if (!row) return;
    this.active.delete(id);
    this.trail.push({
      id, name: row.name, outcome,
      durationMs: Math.max(0, nowMs - row.startedMs),
      detail: detail ?? row.detail,
    });
  }

  hasActive(): boolean { return this.active.size > 0; }
  activeCount(): number { return this.active.size; }
  activeIds(): string[] { return [...this.active.keys()]; }

  /** Live rows rendered with a running elapsed timer (whole seconds). */
  renderActive(nowMs: number): string[] {
    return [...this.active.values()].map((r) => {
      const s = Math.floor(Math.max(0, nowMs - r.startedMs) / 1000);
      const d = r.detail ? ` ${r.detail}` : '';
      return `⟳ ${r.name}${d} · ${s}s`;
    });
  }

  /** Completed-trail rows (glyph + name + duration). */
  renderTrail(): string[] {
    return this.trail.map((r) => {
      const d = r.detail ? ` ${r.detail}` : '';
      return `${GLYPH[r.outcome]} ${r.name}${d} · ${r.durationMs}ms`;
    });
  }

  /**
   * Assemble the FULL transcript for this turn, THEN clear live state. Any row
   * still active is recorded as `interrupted` (turn ended before it finished)
   * so history shows every call's outcome and nothing disappears. Pass
   * `{ interrupted: true }` to label still-active rows `cancelled` (user esc)
   * instead of `interrupted`.
   */
  finalizeTranscript(nowMs: number, opts: { interrupted?: boolean } = {}): string[] {
    const stragglerOutcome: ToolOutcome = opts.interrupted ? 'cancelled' : 'interrupted';
    for (const row of this.active.values()) {
      this.trail.push({
        id: row.id, name: row.name, outcome: stragglerOutcome,
        durationMs: Math.max(0, nowMs - row.startedMs), detail: row.detail,
      });
    }
    this.active.clear();
    const lines = this.renderTrail();
    this.trail = [];
    return lines;
  }
}
