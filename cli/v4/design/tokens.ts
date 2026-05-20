/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/design/tokens.ts — v4.8.0 Slice 2 design-system foundation.
 *
 * Color, glyph, and spacing tokens consumed by every subsequent slice
 * (tables, panels, status bar, markdown, loading state). Hex strings
 * here parallel the RGB tuples in `skinEngine.ts` — tokens.ts is the
 * design intent, skinEngine is the runtime color authority for
 * `applyColors(text, kind)`. Renderer slices (3+) consume these.
 * isVerbose() reads env at call time (Ollama-options precedent).
 */

// Re-export so consumers can import the trail gutter from tokens
// alongside the rest of the design system. The original constant
// stays at its current home for backward compatibility with code
// that imports from `display/toolTrail` directly.
export { TRAIL_PIPE } from '../display/toolTrail';

// ── Colors ────────────────────────────────────────────────────────────────

/**
 * Hex color tokens. Mirrors skinEngine RGB tuples for existing kinds;
 * adds `content.tertiary`, `semantic.info`, `surface.*` (renderer
 * slices propagate these to skinEngine). Content primary lifted
 * `#e0e0e0` → `#e8ebf0` for legibility on dark terminals.
 */
export const colors = {
  brand: {
    /** Aiden signature orange — already used by skinEngine's `brand`. */
    primary: '#FF6B35',
    /** 30%-luma brand orange for borders and dim brand surfaces. */
    muted:   '#7a3119',
  },
  content: {
    /** Brightest text — primary reply content, headings on dark bg. */
    primary:   '#e8ebf0',
    /** Warm muted — gutter, secondary detail, post-action timeline. */
    secondary: '#b8a89a',
    /** Least-important text — captions, dim status, deprecated rows. */
    tertiary:  '#6a6a6a',
  },
  semantic: {
    success: '#7fc28b',
    warn:    '#e0a040',
    error:   '#e05a5a',
    info:    '#7da7c7',
  },
  /**
   * v4.8.0 Slice 7 hotfix #2 — per-metric accent palette for the
   * packed status footer. Each metric gets a stable colour so
   * cross-glance reading stays consistent: cyan model, amber tokens,
   * purple turn count, teal timer. Maps to skinEngine ColorKinds at
   * runtime: tool / warn / metric_turn / success.
   */
  metrics: {
    model:     '#9cdcfe',
    tokens:    '#e0a040',
    turnCount: '#a48be0',
    timer:     '#7fc28b',
  },
  surface: {
    /** Terminal background reference; tokens never paint bg directly. */
    bg:       '#0d0e10',
    /** Elevated panel fill (Slice 4 cards / boxed surfaces). */
    elevated: '#16181b',
    /** Panel borders — frames around tables, capability cards. */
    border:   '#2a2a2a',
    /** Section dividers — between boot card and REPL, between events. */
    divider:  '#3a3a3a',
  },
} as const;

// ── Glyphs ────────────────────────────────────────────────────────────────

/**
 * Centralized glyph vocabulary. Four namespaces — `event` (ui_* row
 * glyphs), `status` (boot/footer chrome), `util` (bullets, dividers,
 * checks), `trail` (tool-trail row prefix). Renderer slices (3+)
 * replace inline literals with these references.
 */
export const glyphs = {
  event: {
    /** ui_task_update status:'running' */
    running:    '⟳',
    /** ui_task_done status:'success' */
    done:       '✓',
    /** ui_task_done status:'failure' */
    fail:       '✗',
    /** ui_task_done status:'blocked' / hard-blocked */
    blocked:    '⊘',
    /** ui_task_update status:'paused' */
    paused:     '⏸',
    /** ui_task_update status:'blocked' (soft block, awaiting input) */
    hardBlock:  '⛔',
    /** ui_approval_request leading glyph + ui_toast kind:'warning' */
    warning:    '⚠',
    /** ui_toast kind:'info' */
    info:       'ℹ',
    /** ui_command_result header glyph */
    cmd:        '▸',
    /** ui_artifact_created kind:'file' */
    file:       '📄',
    /** ui_artifact_created kind:'skill' */
    skill:      '🛠',
    /** ui_artifact_created kind:'directory' */
    directory:  '📁',
  },
  status: {
    /** User-prompt prefix + Aiden brand triangle (activityIndicator). */
    triangle: '▲',
    /** Solid filled dot — used for `●` status markers. */
    dot:      '●',
    /** Hollow dot — companion to `dot` for inactive states. */
    dotOpen:  '○',
    /** Status footer column separator. */
    sep:      '│',
    /** Slice 7 — turn counter prefix. Slice 9 hotfix: glyph dropped
     *  entirely. The bare colored number (purple `metric_turn` kind)
     *  carries the meaning, matching the timer pattern. */
    turn:     '',
    /** Slice 7 — session timer prefix. Slice 9 hotfix: `⌛` (U+231B
     *  HOURGLASS WITH FLOWING SAND) restored. The font set Shiva
     *  confirmed renders ●/○/▲ also renders this widely-supported
     *  emoji-class hourglass. Trailing space owned by the segment
     *  composition site to keep the token minimal. */
    timer:    '⌛',
  },
  util: {
    /** Section / row divider. */
    divider:    '─',
    /** Solid bullet for list rows. */
    bullet:     '●',
    /** Hollow bullet (inactive / unselected). */
    bulletOpen: '○',
    /** Mid-dot — existing skin bullet for compact lists. */
    midDot:     '•',
    /** Check-success — heavier than ui-event `✓` for emphasis. Slice 8
     *  hotfix: VS16 (U+FE0F) appended to force emoji-presentation width
     *  = 2 cells so `✔` renders with the same visual heft as `●`/`○`
     *  bullets and doesn't sit flush against following text. Same fix
     *  pattern as Slice 5 for `✏`/`👁`. */
    check:      '✔️',
    /** Inline arrow — submenu, breadcrumb. */
    arrow:      '›',
    /** Trail-style horizontal arrow — ui_command_result header. */
    triArrow:   '▸',
  },
  trail: {
    /** Tool-trail gutter character. Re-exported from toolTrail.ts. */
    gutter: '┊' as const,
  },
  /**
   * Box-drawing chrome for table + panel surfaces (Slice 3+). Renders
   * sharp ASCII so wide-display terminals and narrow ConPTYs both
   * align cleanly. Slice 4 reuses `hLine` for the panel divider.
   */
  chrome: {
    topLeft: '┌', topRight: '┐', botLeft: '└', botRight: '┘',
    teeDown: '┬', teeUp:    '┴', teeRight: '├', teeLeft:  '┤',
    cross:   '┼', hLine:    '─', vLine:    '│',
  },
  /**
   * Aiden-native framed-panel chrome (Slice 4). Left-edge accent bar
   * gives panels brand identity without a closing box; asymmetric
   * chrome (top + bottom dividers, no corners) reads as intentional
   * Aiden signature rather than borrowed pattern. `bar` is the
   * one-eighth solid block — widely supported in fonts; falls back
   * gracefully to `|` on dumb sinks.
   */
  panel: {
    bar: '▎',
  },
  /**
   * Status footer progress bar pair. v4.8.0 Slice 7 hotfix #3 — moved
   * from hex dots (⬢/⬡) back to the U+25CF/U+25CB circle pair: those
   * codepoints render in every monospace font (Consolas, Cascadia,
   * SF Mono, JetBrains Mono, etc.) whereas the hex dots required
   * Nerd Font / Apple Symbols fallback chains and rendered as `□`
   * boxes on many setups. Colour still carries the meaning; the
   * glyph just needs to render at all.
   */
  bar: {
    filled: '●',
    empty:  '○',
  },
} as const;

// ── Spacing ───────────────────────────────────────────────────────────────

/**
 * Integer spacing tokens. 0-indexed column counts; subagent depth
 * indent is INSIDE the gutter (`┊` stays at col 0, indent shifts the
 * glyph + content right).
 */
export const spacing = {
  indent: {
    /** Column where the trail gutter `┊` lands. */
    gutter:           0,
    /** Column where the event glyph lands (after `┊` + space). */
    glyph:            2,
    /** Column where primary content text lands (after glyph + space). */
    content:          4,
    /** Column where secondary detail text lands (after primary + space). */
    detail:           6,
    /** Spaces per subagent depth level (inside the gutter). */
    subagentPerDepth: 2,
  },
  between: {
    /** Blank rows between related events in the same group. */
    sameGroup:    0,
    /** Blank rows between event groups. */
    groups:       1,
    /** Blank rows between top-level sections (boot card → REPL → events). */
    sections:     2,
  },
} as const;

// ── Verbose-mode env-gated flag ───────────────────────────────────────────

/** Env var name; Slice 5 consumes via isVerbose() to gate debug surfaces. */
export const VERBOSE_MODE_ENV = 'AIDEN_VERBOSE';

/**
 * Verbose flag, read at call time. Only literal `'1'` enables; any
 * other value (`'true'`, `'yes'`, etc.) is off so the gate stays
 * unambiguous. Matches the Ollama-options env-time-read precedent.
 */
export function isVerbose(): boolean {
  return process.env[VERBOSE_MODE_ENV] === '1';
}
