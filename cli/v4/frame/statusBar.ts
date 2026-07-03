/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/frame/statusBar.ts — v4.12.1 Pillar 4 Slice 1.
 *
 * The pinned bottom status bar's PURE model + renderer. No I/O, no ANSI
 * colour, no Ink — it turns a plain snapshot into a single width-budgeted
 * line. The frame (Ink) renderer owns painting it; the legacy renderer can
 * print the same string best-effort. Keeping it pure makes the width-budget
 * priority logic exhaustively unit-testable without a TTY.
 *
 * Width-budget rule (the anti-overflow contract): model + context are PINNED
 * (always shown, model truncated before it's dropped). Everything else is
 * added in ascending priority while it fits; lower-priority segments (cwd,
 * N-behind, subagent count) drop FIRST on a narrow terminal. The busy verb +
 * elapsed segment is BOUNDED so a long verb can never shove model/context off
 * screen. Exact cost is progressive-disclosure — not an always-on segment.
 */

/** Everything the bar can show. Populated from live turn/session state. */
export interface StatusBarModel {
  busy:            boolean;
  /** Verb next to the busy indicator ('thinking', 'calling file_write', …). */
  verb:            string;
  elapsedS:        number;
  /** provider/model label, e.g. 'chatgpt-plus·gpt-5.5'. */
  model:           string;
  /** Tokens used this session/turn (context occupancy). */
  contextTokens:   number;
  /** Context window size, when known — enables the % reading. */
  contextMax?:     number | null;
  /** In-flight subagents (from the coordinator's activeChildren registry). */
  activeSubagents: number;
  cwd:             string;
  /** A tool is parked awaiting the user's approval decision. */
  pendingApproval: boolean;
  /**
   * Update indicator text (e.g. 'v4.13 ↑') or null when up to date / unknown.
   * Comes straight from the existing update-check UpdateStatus — never blocks,
   * silent on failure.
   */
  nBehind?:        string | null;
}

interface Segment { key: string; text: string; priority: number; }

/** Cap the busy verb+elapsed segment so a long verb never dominates the bar. */
const BUSY_SEGMENT_MAX = 28;
const SEP = ' · ';

/** Compact a large token count: 1234 → '1.2k', 999 → '999'. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function contextText(m: StatusBarModel): string {
  const tok = fmtTokens(m.contextTokens);
  if (m.contextMax && m.contextMax > 0) {
    const pct = Math.min(100, Math.round((m.contextTokens / m.contextMax) * 100));
    return `ctx ${tok}/${fmtTokens(m.contextMax)} ${pct}%`;
  }
  return `ctx ${tok}`;
}

function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

/** Compact a cwd to its last path segment (or two) so it never dominates. */
function shortCwd(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return cwd;
  const tail = parts.slice(-1)[0];
  return `~/${tail}`.length < cwd.length ? tail : cwd;
}

/** Build the priority-ordered candidate segments (highest priority = 0). */
export function statusSegments(m: StatusBarModel): Segment[] {
  const segs: Segment[] = [];
  // Pinned essentials.
  segs.push({ key: 'model',   text: m.model || '(no model)', priority: 0 });
  segs.push({ key: 'context', text: contextText(m),          priority: 0 });
  // Pending approval is safety-critical — keep it near the top.
  if (m.pendingApproval) segs.push({ key: 'approval', text: '⚠ approval', priority: 1 });
  // Busy verb + elapsed (bounded).
  if (m.busy) {
    const verb = truncate(m.verb || 'working', BUSY_SEGMENT_MAX - 6);
    segs.push({ key: 'busy', text: `${verb} ${m.elapsedS}s`, priority: 2 });
  } else {
    segs.push({ key: 'busy', text: 'idle', priority: 2 });
  }
  if (m.activeSubagents > 0) {
    segs.push({ key: 'subagents', text: `${m.activeSubagents} sub`, priority: 3 });
  }
  if (m.nBehind) segs.push({ key: 'behind', text: m.nBehind, priority: 4 });
  segs.push({ key: 'cwd', text: shortCwd(m.cwd), priority: 5 });
  return segs;
}

/**
 * Render the bar to a single line within `width` columns. Model + context are
 * always present (truncated before dropped); lower-priority segments are added
 * while they fit and dropped right-to-left otherwise.
 */
export function renderStatusBar(m: StatusBarModel, width: number): string {
  const w = Math.max(0, Math.floor(width));
  const all = statusSegments(m);
  const pinned = all.filter((s) => s.priority === 0);
  const optional = all.filter((s) => s.priority > 0).sort((a, b) => a.priority - b.priority);

  // Start from the pinned set. If even that overflows, truncate the model
  // segment (never context — the % reading is the load-bearing number).
  const chosen: Segment[] = [...pinned];
  const widthOf = (segs: Segment[]) => segs.reduce((n, s) => n + s.text.length, 0) + SEP.length * Math.max(0, segs.length - 1);

  if (widthOf(chosen) > w) {
    const others = chosen.filter((s) => s.key !== 'model');
    const budgetForModel = w - (widthOf(others) + (others.length > 0 ? SEP.length : 0));
    const model = chosen.find((s) => s.key === 'model');
    if (model) model.text = truncate(model.text, Math.max(1, budgetForModel));
    return chosen.map((s) => s.text).join(SEP);
  }

  // Greedily add optional segments in priority order while they fit.
  for (const seg of optional) {
    const trial = [...chosen, seg];
    if (widthOf(trial) <= w) chosen.push(seg);
  }
  // Preserve a stable left-to-right ordering (pinned first, then by priority).
  chosen.sort((a, b) => a.priority - b.priority);
  return chosen.map((s) => s.text).join(SEP);
}
