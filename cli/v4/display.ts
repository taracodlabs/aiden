/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display.ts — Aiden v4.0.0 (Phase 14a)
 *
 * Aiden's CLI display layer.
 *
 * Responsibilities:
 *   - render the welcome banner
 *   - render markdown to ANSI for the terminal (marked + marked-terminal)
 *   - format user/agent/tool/error turns with skin-aware colour
 *   - drive a lightweight spinner that works on Windows ConPTY
 *
 */

import { marked } from 'marked';
// marked-terminal exports a CommonJS factory.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer: new (opts?: unknown) => unknown = require('marked-terminal').default ?? require('marked-terminal');

import { SkinEngine, getSkinEngine, type ColorKind } from './skinEngine';
import { visibleLength, truncateVisible } from './box';
import { glyphs } from './design/tokens';
import {
  iconForTool as trailIconForTool,
  padVerb,
  truncDetail,
  TRAIL_PIPE,
  TRAIL_VERB_PAD,
  TRAIL_DETAIL_CAP,
} from './display/toolTrail';
// v4.1.3-essentials — capability card renderer (auth/platform failures).
// v4.10 Slice 10.3 — brand prefix in the full-density status bar tier.
import { VERSION as AIDEN_VERSION } from '../../core/version';
import { renderCapabilityCard } from './display/capabilityCard';
import type { CapabilityCardData } from '../../providers/v4/types';
// Phase v4.1-reply-formatting: skin-aware markdown renderer that
// replaces marked-terminal's defaults with structured headers, lists,
// code blocks, blockquotes, and links.
import { getReplyRenderer } from './replyRenderer';
// Optional "Sources" footer when AIDEN_CITATIONS=1 (default off).
import { renderCitationFooter } from './citationFooter';
import { buildToolPreview } from './toolPreview';
// v4.1.4 reply-quality polish: shared frame math for width + indent.
// `cols()`, `rule()`, `agentTurn`, and `tryRerenderInPlace` all route
// through frame helpers so the visible left edge / right margin / wrap
// targets are consistent across streaming, rerender, and one-shot
// reply paths. See `cli/v4/display/frame.ts` for the math.
import {
  getTerminalCols      as frameGetTerminalCols,
  getBodyWidth         as frameGetBodyWidth,
  getIndent            as frameGetIndent,
  wrap                 as frameWrap,
} from './display/frame';

export interface SpinnerHandle {
  stop(finalText?: string): void;
  setText(text: string): void;
}

/**
 * v4.1.4 reply-quality polish — Part 1.6 activity indicator.
 *
 * Surfaces a `▲ verb. (Ns)` indicator on the same physical line during
 * the "model is working but nothing is being painted" gaps:
 *   - Pre-first-token (before first delta arrives)
 *   - Between tools (paused while a tool row is live, resumed after
 *     the tool completes)
 *   - Post-all-tools, pre-reply (a tool batch finished but the final
 *     content hasn't started streaming yet)
 *
 * The handle exposes pause/resume so the caller can hide the indicator
 * while a tool row owns the screen, then bring it back without losing
 * the cumulative elapsed time. `stop()` is terminal — cursor moves to
 * a clean line and no more ticks fire.
 *
 * Differs from `SpinnerHandle` (kept for legacy callers) in three ways:
 *   - Pulsing dots instead of glyph rotation (▲ stays fixed)
 *   - Elapsed-time suffix `(Ns)` for spans >= 1s
 *   - Pause/resume for cooperation with tool rows
 *
 * Implementation lives in `Display.activityIndicator()`. Pure builder —
 * caller decides when to start/pause/resume/stop.
 */
export interface ActivityIndicatorHandle {
  /**
   * Stop ticking and erase the indicator line. State preserved so a
   * later `resume(verb?)` continues from the same elapsed counter.
   * Idempotent.
   */
  pause(): void;
  /**
   * Re-render the indicator on a fresh line below the current cursor
   * and restart the tick. Optional `verb` overrides the active verb
   * (e.g. transition from "thinking" → "drafting"). Idempotent.
   */
  resume(verb?: string): void;
  /** Swap the verb without pausing — picked up on the next tick. */
  setVerb(verb: string): void;
  /**
   * Terminal: erase the indicator line, stop the tick, refuse any
   * further pause/resume calls. Idempotent.
   */
  stop(): void;
  /** Test/inspection — current state snapshot. Pure read. */
  isPaused(): boolean;
  isStopped(): boolean;
}

/**
 * Phase 26.2.4 — a labelled section for the boot card's two-column
 * Environment/Capabilities block. `key` is rendered in muted, `value`
 * in default text. Title is rendered in brand orange.
 */
export interface ColumnSection {
  title: string;
  rows: Array<{ key: string; value: string }>;
}

/**
 * v4.1.3-repl-polish — category emoji icons for the tool-row trail.
 * Icons are ON by default (AIDEN_UI_ICONS !== '0'). Set
 * `AIDEN_UI_ICONS=0` to disable them (CI / dumb terminals).
 *
 * Kept as a flat Record for backward-compat with smoke tests that
 * import it directly. The canonical lookup now lives in
 * `./display/toolTrail` (supports verb too); this map is derived
 * from it for legacy reference.
 *
 * Matching order: exact lowercased name, then substring, then 'default'.
 */
export const TOOL_ICONS: Readonly<Record<string, string>> = {
  // Observe / read
  file_read: '👁', read_file: '👁', file_list: '👁', list_directory: '👁',
  observe: '👁', read: '👁', list: '👁',
  // Write / edit
  file_write: '✏', write_file: '✏', edit_file: '✏',
  write: '✏', edit: '✏', create: '✏',
  // Execute / run
  bash: '⚡', powershell: '⚡', execute_code: '⚡', skill_view: '⚡',
  execute: '⚡', run: '⚡',
  // Web / browse
  web_search: '🌐', web_fetch: '🌐', fetch_url: '🌐', open_url: '🌐',
  navigate: '🌐', browser: '🌐', fetch: '🌐', search: '🌐',
  // Memory / recall
  recall_session: '🧠', session_search: '🧠', memory: '🧠', recall: '🧠',
  // Think
  session_summary: '🧠', analyze: '🧠', think: '🧠',
  // Skills / catalog
  skills_list: '📋', skill: '📋',
  // Screen / capture
  screenshot: '🖥', computer: '🖥',
  // Media / launch
  now_playing: '▶', app_launch: '▶', media: '▶',
  // Deploy / build
  deploy: '📦', build: '📦', push: '📦',
  // Message / send
  send: '💬', message: '💬', notify: '💬',
  // Verify / test
  verify: '🛡', test: '🛡', doctor: '🛡', health: '🛡',
  // Default fallback
  default: '·',
};

/**
 * Return the category emoji for `toolName`, or '·' when nothing matches.
 * Delegates to the canonical toolTrail lookup (returns icon only).
 * Exported for backward-compat with existing smoke / unit tests.
 */
export function iconForTool(toolName: string): string {
  return trailIconForTool(toolName).icon;
}

/**
 * Phase 26.2.6 — pool of fun spinner phrases that the chat REPL
 * picks from per-turn. Replaces the static "Initializing agent…"
 * text with a touch of personality. Single-pick-per-turn (not a
 * mid-spin rotation) — keeps the line stable while the model thinks.
 */
export const SPINNER_PHRASES: readonly string[] = [
  'Thinking',
  'Pondering',
  'Brewing',
  'Cogitating',
  'Reasoning',
  'Computing',
  'Reflecting',
  'Considering',
  'Processing',
  'Brain yakka',
  'Untangling',
  'Synthesizing',
  'Working',
  'Crunching',
  'Plotting',
  'Hatching plans',
  'Caffeinating',
  'Thinking hard',
  'Smelting',
  'Conjuring',
];

/**
 * Phase v4.1-1 — boot card "channels" pill helpers. The CLI process
 * doesn't actually run channel adapters (those live in the API server)
 * so we report what we *can* honestly know from the environment: how
 * many of the nine channel adapters have their credentials present.
 *
 * `summarizeConfiguredChannels` returns a render-ready label like
 * `"3 configured (incl. telegram)"` for the Environment column.
 */
const CHANNEL_ENV_VARS: ReadonlyArray<{ id: string; vars: readonly string[] }> = [
  { id: 'telegram', vars: ['TELEGRAM_BOT_TOKEN'] },
  { id: 'discord',  vars: ['DISCORD_BOT_TOKEN'] },
  { id: 'slack',    vars: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] },
  { id: 'whatsapp', vars: ['WHATSAPP_BUSINESS_API_KEY'] },
  { id: 'twilio',   vars: ['TWILIO_AUTH_TOKEN'] },
  { id: 'imessage', vars: ['BLUEBUBBLES_PASSWORD'] },
  { id: 'email',    vars: ['EMAIL_IMAP_PASSWORD', 'EMAIL_SMTP_PASSWORD'] },
];

export interface ChannelConfiguredCount {
  /** Total number of channels with at least one credential env var set. */
  total: number;
  /** Provider ids that count toward `total` (helpful for tests). */
  ids: string[];
  /** True when `TELEGRAM_BOT_TOKEN` is present — drives the boot pill suffix. */
  telegram: boolean;
}

export function detectConfiguredChannels(
  env: NodeJS.ProcessEnv = process.env,
): ChannelConfiguredCount {
  const ids: string[] = [];
  for (const c of CHANNEL_ENV_VARS) {
    if (c.vars.some((v) => typeof env[v] === 'string' && env[v]!.trim() !== '')) {
      ids.push(c.id);
    }
  }
  return { total: ids.length, ids, telegram: ids.includes('telegram') };
}

export function summarizeConfiguredChannels(
  detection: ChannelConfiguredCount = detectConfiguredChannels(),
): string {
  if (detection.total === 0) return '0 configured';
  const suffix = detection.telegram ? ' (incl. telegram)' : '';
  return `${detection.total} configured${suffix}`;
}

/**
 * Phase v4.1-1.1 — boot-card "channels" pill that distinguishes
 * "configured but offline" from "active". The CLI now hosts a
 * `ChannelManager` directly (not just env-var counting), so we can
 * report real liveness:
 *
 *   ● 0 configured (run /channel telegram add to enable)
 *   ● 1 active: telegram (@bot)
 *   ● 1 configured: telegram (offline — run /channel telegram status)
 *   ● 2 active: telegram (@bot), discord
 *
 * The label always renders — empty state is a teaching surface, not
 * something to hide. When no manager is supplied we fall back to the
 * env-only summary so non-CLI callers still get a sensible string.
 */
export interface ChannelStateProbe {
  /** Per-adapter liveness — pass adapters whose isHealthy() can be queried. */
  adapters: ReadonlyArray<{
    id:          string;
    healthy:     boolean;
    /** Optional friendly handle (e.g. Telegram bot @username). */
    botHandle?:  string | null;
    /**
     * Phase v4.1-1.2 — coarse state for adapters that distinguish
     * `conflict` (another aiden instance is polling) from a generic
     * unhealthy. Only the Telegram adapter currently emits this; other
     * adapters will adopt it as Phase 2 lands.
     */
    state?:      'inactive' | 'connecting' | 'active' | 'degraded' | 'conflict';
  }>;
}

export function summarizeChannelState(
  probe: ChannelStateProbe | null,
  envFallback: ChannelConfiguredCount = detectConfiguredChannels(),
): string {
  // No live probe (e.g. test harness with no manager) → env-only count.
  if (!probe) {
    if (envFallback.total === 0) {
      return '0 configured (run /channel telegram add to enable)';
    }
    return `${envFallback.total} configured${envFallback.telegram ? ' (incl. telegram)' : ''}`;
  }

  // Phase v4.1-1.2 — conflict takes priority over the generic active /
  // offline split. If any adapter is in the conflict state, surface
  // that explicitly so the user has an unambiguous remediation hint.
  const conflicted = probe.adapters.filter((a) => a.state === 'conflict');
  if (conflicted.length > 0) {
    const names = conflicted.map((a) => a.id).join(', ');
    return `${conflicted.length} degraded: ${names} (conflict — /channel telegram takeover)`;
  }

  const active   = probe.adapters.filter((a) => a.healthy);
  const inactive = probe.adapters.filter((a) => !a.healthy);

  if (active.length === 0) {
    if (envFallback.total === 0) {
      return '0 configured (run /channel telegram add to enable)';
    }
    // Token in env but adapter not healthy — frame it as offline so
    // the user knows /channel telegram status is the next step.
    const offlineNames = inactive
      .filter((a) => envFallback.ids.includes(a.id))
      .map((a) => a.id)
      .join(', ');
    return offlineNames
      ? `${envFallback.total} configured: ${offlineNames} (offline — /channel telegram status)`
      : `${envFallback.total} configured`;
  }

  const parts = active.map((a) => (a.botHandle ? `${a.id} (@${a.botHandle})` : a.id));
  return `${active.length} active: ${parts.join(', ')}`;
}

export interface AgentTurnOptions {
  /** Render markdown via `markdown()` before printing. Default: true. */
  markdown?: boolean;
  /** Optional reasoning preface (rendered muted). */
  reasoning?: string;
}

const AIDEN_BANNER = String.raw`
█████╗  ██╗██████╗ ███████╗███╗   ██╗
██╔══██╗██║██╔══██╗██╔════╝████╗  ██║
███████║██║██║  ██║█████╗  ██╔██╗ ██║
██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║
██║  ██║██║██████╔╝███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝
`;

/**
 * v4.9.0 pre-ship UI hotfix — pure context-bar helpers. Extracted
 * for testability + to fix the "always empty" symptom. Scale:
 * 0% → 0 cells, 1-19% → 1, 20-39% → 2, 40-59% → 3, 60-79% → 4,
 * 80-100% → 5. `renderContextBar` returns the glyph array.
 */
export function computeContextBarFill(pct: number, barW = 5): number {
  if (pct <= 0)   return 0;
  if (pct >= 100) return barW;
  return Math.min(barW, Math.floor(pct / 20) + 1);
}
export function renderContextBar(filled: number, barW = 5): string[] {
  return Array.from({ length: barW }, (_, i) =>
    i < filled ? glyphs.bar.filled : glyphs.bar.empty,
  );
}

export class Display {
  private skin: SkinEngine;
  private out: NodeJS.WriteStream;
  private err: NodeJS.WriteStream;

  constructor(opts: { skin?: SkinEngine; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {}) {
    this.skin = opts.skin ?? getSkinEngine();
    this.out = opts.stdout ?? process.stdout;
    this.err = opts.stderr ?? process.stderr;
    try {
      marked.setOptions({ renderer: new TerminalRenderer() as never });
    } catch {
      // marked-terminal optional — markdown() falls back to raw text below
    }
  }

  /**
   * v4.1.3-repl-polish — public colour gate so callers (e.g. session-end
   * card renderer) can colour text without importing SkinEngine directly.
   * Delegates to the active skin's applyColors(). Monochrome mode is
   * respected the same way as internal calls.
   */
  applyColors(text: string, kind: ColorKind): string {
    return this.skin.applyColors(text, kind);
  }

  /**
   * Build the welcome banner string (does not write).
   *
   * Phase 23.6 (v3 visual style port): banner is the AIDEN block ASCII
   * art only, in brand orange, indented two columns to match the rest
   * of the boot card.  Status / session / version / ready lines are
   * emitted by chatSession.renderStartupCard so the banner stays a
   * typographic anchor, not a catalog.  `opts.tip` is accepted for
   * backward compat but ignored.
   */
  banner(_version = '4.0.0', _opts: { tip?: string } = {}): string {
    const sk = this.skin;
    const lines = AIDEN_BANNER.split('\n').map((l) =>
      l ? `  ${sk.applyColors(l, 'brand')}` : '',
    );
    return `${lines.join('\n')}\n`;
  }

  /** Print the banner. `opts.tip` accepted for backward compat; unused. */
  printBanner(version?: string, opts: { tip?: string } = {}): void {
    this.out.write(this.banner(version, opts));
  }

  // ── Phase 23.6 — v3 visual primitives ──────────────────────────────────
  // Pure renderers (return strings, don't write) so chatSession can
  // compose the boot card and turn rhythm without owning ANSI escapes.

  /**
   * Terminal column count. v4.1.4 reply-quality polish: delegates to
   * `frame.getTerminalCols()` so all width math shares one formula.
   * Retains the 100-col cap via `Math.min` so existing callers that
   * paint full-width chrome (boot card, footer) keep their visual
   * identity — `frame.BODY_WIDTH_MAX` is the tunable.
   */
  cols(): number {
    return Math.min(frameGetTerminalCols(this.out), 100);
  }

  /**
   * Thin horizontal rule (`──…──`) in muted colour, full body width.
   * v4.1.4 reply-quality polish: width sourced from `frame.getBodyWidth()`
   * so the rule sits at the same right margin as wrapped prose and
   * code blocks. Returns the line WITHOUT a trailing newline; caller
   * adds one + the leading gutter.
   */
  rule(width?: number): string {
    const w = Math.max(8, width ?? frameGetBodyWidth(this.out));
    return this.skin.applyColors('─'.repeat(w), 'muted');
  }

  /** Render `▲` (brand-orange filled triangle) — Aiden's identity motif. */
  triangle(): string {
    return this.skin.applyColors('▲', 'brand');
  }

  /** Render `●` filled dot in success green (active state). */
  dotOn(): string {
    return this.skin.applyColors('●', 'success');
  }

  /** Render `○` hollow dot in muted (inactive state). */
  dotOff(): string {
    return this.skin.applyColors('○', 'muted');
  }

  /** Wrap text in success colour. */
  success_(text: string): string {
    return this.skin.applyColors(text, 'success');
  }

  /** Wrap text in warn colour. */
  warn_(text: string): string {
    return this.skin.applyColors(text, 'warn');
  }

  /** Wrap text in error colour. */
  error_(text: string): string {
    return this.skin.applyColors(text, 'error');
  }

  /**
   * Phase 26.2.8 — HH:MM:SS muted timestamp prefix used when
   * `AIDEN_UI_TIMESTAMPS=1`. Returns the wrapped 8-char string
   * (`12:41:02`) in muted; the caller owns the trailing spacer.
   * `d` is injectable so tests can pin the time.
   */
  timestampPrefix(d: Date = new Date()): string {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return this.skin.applyColors(`${hh}:${mm}:${ss}`, 'muted');
  }

  /**
   * Phase 26.2.3 — single-line assistant header in the
   * `┃ Aiden` style. `┃` (U+2503 heavy vertical) and `Aiden` are
   * both brand-orange. The thin rule that previously sat under the
   * label is gone — the per-turn separator (printed BEFORE the user
   * prompt by chatSession) carries that visual weight now.
   *
   * Phase 26.2.8 — when `AIDEN_UI_TIMESTAMPS=1`, prepends a muted
   * `HH:MM:SS  ` prefix in front of the indented `┃ Aiden`. The
   * existing 2-space indent is replaced by the 10-char timestamp
   * gutter so the bar and label shift right to align with the
   * gutter. Default OFF preserves the exact current shape.
   *
   * Returns one indented line with a trailing newline.
   */
  agentHeader(): string {
    // v4.8.0 Slice 7 hotfix — replace v4.7 ┃ heavy-vertical with the
    // Slice 4 framedPanel bar `▎` so reply chrome matches /help,
    // approval prompt, and other Slice 4+ surfaces. Trailing `\n\n`
    // (was `\n`) puts one blank between header and first content row.
    const bar = this.skin.applyColors(glyphs.panel.bar, 'brand');
    const head = this.skin.applyColors('Aiden', 'brand');
    if (process.env.AIDEN_UI_TIMESTAMPS === '1') {
      return `${this.timestampPrefix()}  ${bar} ${head}\n\n`;
    }
    return `  ${bar} ${head}\n\n`;
  }

  /**
   * Phase 26.2.3 — turn boundary marker. Writes a thin muted rule
   * followed by a blank line. Called by `chatSession` BEFORE each
   * user-input read except the first (boot card already emits a
   * rule + blank). Single canonical separator for the conversation
   * surface.
   */
  printTurnSeparator(): void {
    // v4.8.0 Slice 7 hotfix — drop the trailing blank line. Inquirer's
    // own prompt leading newline + the Aiden header's leading 2-space
    // indent provide enough breathing room; the extra blank was
    // stacking with other emit points to produce 3+ blank lines
    // between user prompt and reply.
    this.out.write(`  ${this.rule()}\n`);
  }

  /**
   * Render the v3-style boot status line:
   *
   *   ● <provider> <model>  ·  ● 56/72 skills  ·  43 tools  ·  ○ 0 mem
   *
   * Dots colour-graded: green ● when count > 0, muted ○ when 0.  Provider
   * dot also tracks "active" — green when provider is reachable, error
   * red otherwise (caller passes `providerOk`).
   */
  bootStatusLine(args: {
    provider: string;
    model: string;
    providerOk?: boolean;
    skillsLoaded: number;
    skillsTotal?: number;
    tools: number;
    memCount?: number;
  }): string {
    const sk = this.skin;
    const sep = sk.applyColors(' · ', 'muted');
    const provDot = args.providerOk === false
      ? sk.applyColors('●', 'error')
      : this.dotOn();
    const skillsDot = args.skillsLoaded > 0 ? this.dotOn() : this.dotOff();
    const memCount = args.memCount ?? 0;
    const memDot = memCount > 0 ? this.dotOn() : this.dotOff();
    const provModel =
      `${provDot} ${sk.applyColors(args.provider, 'brand')} ` +
      `${sk.applyColors(args.model, 'muted')}`;
    const skillCount =
      typeof args.skillsTotal === 'number' && args.skillsTotal !== args.skillsLoaded
        ? `${args.skillsLoaded}/${args.skillsTotal}`
        : `${args.skillsLoaded}`;
    const skillsSeg = `${skillsDot} ${sk.applyColors(`${skillCount} skills`, 'muted')}`;
    const toolsSeg = sk.applyColors(`${args.tools} tools`, 'muted');
    const memSeg = `${memDot} ${sk.applyColors(`${memCount} mem`, 'muted')}`;
    return `  ${provModel}${sep}${skillsSeg}${sep}${toolsSeg}${sep}${memSeg}`;
  }

  // ── Phase 26.2.4 — neofetch-style sectioned boot card helpers ─────
  // Four pure renderers used by chatSession.renderStartupCard. Each
  // returns a string with no trailing newline so the caller controls
  // vertical rhythm. None of them branch on detection — chatSession
  // is responsible for collecting the data; Display just paints it.

  /**
   * Status pills row — one line, four pills separated by 4 spaces.
   * Format: `● core online    ● mode auto    ● model X    ● memory active`.
   * Dot is success-green when on, muted when off. Label is muted, value
   * is rendered in `agent` (off-white) for legibility without competing
   * with the banner orange.
   */
  statusPillsRow(args: {
    coreOnline: boolean;
    mode: string;
    model: string;
    memoryActive: boolean;
    /**
     * Phase 30.2 (v4.0.2) — when explicitly false, the model pill renders
     * "not configured" instead of the supplied model id, and its dot fades
     * to muted. Defaults to true (no behavioural change for callers that
     * don't pass it). Used by the post-wizard / fallback paths so a
     * stale model name from config.yaml cannot mislead a fresh user.
     */
    providerOk?: boolean;
    /**
     * Phase v4.1.2-version-display — when present, append a fifth pill
     * `● v<version>` so users see the running version at boot without
     * invoking `aiden --version`. No label (the `v` prefix carries it).
     * Omitted → no version pill rendered, status row stays four-wide
     * for callers that don't thread version yet.
     */
    version?: string;
  }): string {
    const sk = this.skin;
    const dot = (on: boolean): string => sk.applyColors('●', on ? 'success' : 'muted');
    const lab = (s: string): string => sk.applyColors(s, 'muted');
    const val = (s: string): string => sk.applyColors(s, 'agent');
    const pill = (on: boolean, label: string, value: string): string =>
      `${dot(on)} ${lab(label)} ${val(value)}`;
    const providerOk = args.providerOk !== false;
    const modelValue = providerOk ? args.model : 'not configured';
    const pills = [
      pill(args.coreOnline, 'core', args.coreOnline ? 'online' : 'starting'),
      pill(true, 'mode', args.mode),
      pill(providerOk, 'model', modelValue),
      pill(args.memoryActive, 'memory', args.memoryActive ? 'active' : 'off'),
    ];
    if (args.version) {
      // Version pill: dot + value, no label (the `v` prefix is the label).
      // Always-on dot — informational, not a health indicator.
      pills.push(`${dot(true)} ${val(`v${args.version}`)}`);
    }
    return '  ' + pills.join('    ');
  }

  /**
   * Two-column block (Environment + Capabilities). Side-by-side when
   * `cols() >= 80`, stacked vertically below that. Title in brand,
   * keys in muted (padded to 11 visible chars), values in `agent`.
   */
  twoColumnBlock(
    left: ColumnSection,
    right: ColumnSection,
    opts: { sideBySideThreshold?: number } = {},
  ): string {
    const sk = this.skin;
    const cols = this.cols();
    // Tier-3.1b: callers can raise the side-by-side threshold (boot
    // card prefers stacked at 70-119 cols, side-by-side only at ≥120).
    // Default 80 preserves prior behaviour for any other caller.
    const stacked = cols < (opts.sideBySideThreshold ?? 80);
    const indent = '  ';
    const KEY_PAD = 11;

    const renderRows = (sec: ColumnSection): string[] => {
      const rows = [sk.applyColors(sec.title, 'brand')];
      for (const r of sec.rows) {
        const k = sk.applyColors(r.key.padEnd(KEY_PAD), 'muted');
        const v = sk.applyColors(r.value, 'agent');
        rows.push(`${k}${v}`);
      }
      return rows;
    };

    if (stacked) {
      const out: string[] = [];
      for (const ln of renderRows(left)) out.push(`${indent}${ln}`);
      out.push('');
      for (const ln of renderRows(right)) out.push(`${indent}${ln}`);
      return out.join('\n');
    }

    // Side-by-side. Each column capped at 40 visible chars; separator
    // is 4 spaces. At cols=80 the right column has 32 chars to work
    // with, which fits all hardcoded capability values.
    const colW = Math.min(40, Math.floor((cols - indent.length - 4) / 2));
    const sep = '    ';
    const leftRows = renderRows(left);
    const rightRows = renderRows(right);
    const maxRows = Math.max(leftRows.length, rightRows.length);
    const out: string[] = [];
    for (let i = 0; i < maxRows; i += 1) {
      const l = leftRows[i] ?? '';
      const r = rightRows[i] ?? '';
      const lVis = visibleLength(l);
      const lPadded = lVis < colW ? l + ' '.repeat(colW - lVis) : l;
      out.push(`${indent}${lPadded}${sep}${r}`);
    }
    return out.join('\n');
  }

  /**
   * Phase 26.2.5 — parchment-shaped credits footer. Replaces the
   * earlier scroll ASCII whose diagonals wouldn't align reliably in
   * a monospace cell. Layout:
   *
   *       ___________________________________________________________
   *      |                                                           |
   *      |   ♥  Built solo                                           |
   *      |   GitHub:  github.com/taracodlabs/aiden                   |
   *      |   Web:     aiden.taracod.com                              |
   *      |   Contact: contact@taracod.com                            |
   *      |___________________________________________________________|
   *
   * Top underscore lid floats one column past the left wall (the lid
   * sits *between* the pipes, not over them) — gives the parchment a
   * lifted-corner feel without using corner glyphs. Bottom is sealed.
   *
   * Width-responsive:
   *   cols >= 80 → full parchment (interior 63 chars)
   *   cols <  80 → plain 4-line text fallback (no border)
   *
   * Colours: borders in muted, ♥ in brand, field labels in brand,
   * field values in `agent` (off-white). Each colour span is its own
   * SGR open/close — no nesting — so the closing reset doesn't bleed
   * across lines.
   */
  scrollFooter(): string {
    // v4.8.0 Slice 10d — rounded heavy frame for identity / credits.
    // The Slice 10b/c orange-bar chrome lacked visual containment for
    // an identity surface (the bar reads as panel-content, not as a
    // credits card). This restores a heavy frame — but with rounded
    // corners (╭╮╰╯) sourced from glyphs.box, and muted chrome so the
    // brand `♥` + brand kv labels carry the visual weight inside.
    const sk = this.skin;
    const m = (s: string): string => sk.applyColors(s, 'muted');
    const lab = (s: string): string => sk.applyColors(s, 'brand');
    const val = (s: string): string => sk.applyColors(s, 'agent');
    const heart = sk.applyColors('♥', 'brand');

    if (this.cols() < 80) {
      // Narrow fallback unchanged — single-line credits stays compact.
      return `  ${heart} ${m('built solo · github.com/taracodlabs/aiden · aiden.taracod.com')}`;
    }

    const indent = '  ';
    const innerW = Math.min(this.cols() - 4, 70);
    const tL = m(glyphs.box.topLeft);
    const tR = m(glyphs.box.topRight);
    const bL = m(glyphs.box.bottomLeft);
    const bR = m(glyphs.box.bottomRight);
    const side = m(glyphs.chrome.vLine);
    const hRun = m(glyphs.chrome.hLine.repeat(innerW));
    const pad = (visible: string, width: number): string => {
      const v = visibleLength(visible);
      return visible + ' '.repeat(Math.max(0, width - v));
    };
    const row = (content: string): string =>
      `${indent}${side} ${pad(content, innerW - 2)} ${side}`;

    return [
      '',
      `${indent}${tL}${hRun}${tR}`,
      row(`${heart}  ${val('Built solo')}`),
      row(''),
      row(`${lab('GitHub:'.padEnd(10))}${val('github.com/taracodlabs/aiden')}`),
      row(`${lab('Web:'.padEnd(10))}${val('aiden.taracod.com')}`),
      row(`${lab('Contact:'.padEnd(10))}${val('contact@taracod.com')}`),
      `${indent}${bL}${hRun}${bR}`,
      '',
    ].join('\n');
  }

  /**
   * Bottom prompt hint that replaces the prior `ready ▸  /help` +
   * `✦ Tip:` lines.
   *
   * v4.8.0 Slice 11 — dropped the leading `▲` glyph. The inquirer
   * prompt that paints immediately below this hint already carries
   * the brand triangle as its input prefix (`display.promptPrefix()`),
   * so the hint's own `▲` read as a duplicate orphan sitting one row
   * above the active cursor. Hint is now text-only-muted; `▲` stays
   * exclusively as the user-input identity glyph.
   */
  bottomPromptHint(): string {
    const sk = this.skin;
    const text = sk.applyColors(
      'Type your message · /help for commands · /skills to add more',
      'muted',
    );
    return `    ${text}`;
  }

  /**
   * v3-style "ready" line:
   *
   *   ready ▸  /help for commands
   *
   * "ready" + ▸ in brand orange; trailing hint in muted.
   */
  readyLine(hint = '/help for commands'): string {
    const sk = this.skin;
    const ready = sk.applyColors('ready', 'brand');
    const arrow = sk.applyColors('▸', 'brand');
    return `  ${ready} ${arrow}  ${sk.applyColors(hint, 'muted')}`;
  }

  /**
   * v3-style post-turn status footer, extended in v4.8.0 Slice 7 with
   * packed info density (turn counter, session uptime, per-turn state
   * dot) and progressive disclosure based on terminal width.
   *
   * Layout tiers:
   *   ≥120 cols: ▲ provider · model │ N/M <bar> N% │ ⌘ N │ ⏱ Hms │ ● state
   *   ≥100 cols: ▲ provider · model │ N/M <bar> N% │ ⌘ N │ Ns
   *   < 100:     ▲ provider · model │ <bar> N% │ Ns
   *
   * `turnCount`, `sessionMs`, `state` are optional for backward compat;
   * old call sites continue to work unchanged.
   */
  statusFooter(args: {
    provider:    string;
    model:       string;
    ctxUsed:     number;
    ctxMax:      number;
    elapsedMs:   number;
    turnCount?:  number;
    sessionMs?:  number;
    state?:      'ok' | 'warn' | 'error' | 'muted';
  }): string {
    const sk = this.skin;
    const SEP = sk.applyColors(' │ ', 'muted');
    // v4.9.0 pre-ship UI hotfix — dropped the leading `▲` from
    // provModel (prompt `▲` owns the marker; footer `▲` read as
    // a duplicate orphan). Slice 7 per-metric palette preserved.
    const provModel =
      `${sk.applyColors(args.provider, 'muted')}` +
      `${sk.applyColors(' · ', 'muted')}` +
      sk.applyColors(args.model, 'tool');

    const pct = args.ctxMax > 0
      ? Math.min(100, Math.round((args.ctxUsed / args.ctxMax) * 100))
      : 0;
    // v4.9.0 pre-ship UI hotfix — bar math extracted to
    // `computeContextBarFill` (1 cell per 20% bucket, ≥1 when any
    // context used). Old `Math.round(pct/100 * barW)` floored to 0
    // below ~10% so the bar stayed empty all session at typical use.
    const barW = 5;
    const filled = computeContextBarFill(pct, barW);
    const ctxKind: 'success' | 'warn' | 'error' =
      pct < 60 ? 'success' : pct < 85 ? 'warn' : 'error';
    const cells = renderContextBar(filled, barW);
    const bar = sk.applyColors(cells.join(' '), ctxKind);
    const ctxRatio = sk.applyColors(
      `${formatCompactTokens(args.ctxUsed)}/${formatCompactTokens(args.ctxMax)}`,
      'warn',
    );
    const ctxPctText = sk.applyColors(`${pct}%`, ctxKind);

    const elapsed = sk.applyColors(formatElapsedShort(args.elapsedMs), 'success');

    // Progressive disclosure: pick layout based on RAW terminal width.
    // `this.cols()` caps at 100 (frame budget for body content), but
    // the footer wants the full physical width to choose its tier.
    const cols = (typeof this.out.columns === 'number' && this.out.columns >= 1)
      ? this.out.columns
      : 100;
    // Tier ≥120: full density (ratio + bar + pct + turn + session + state).
    // Tier ≥100: ratio + bar + pct + turn + elapsed.
    // Tier <100: bar + pct + elapsed.
    const stateDot = args.state
      ? sk.applyColors(glyphs.status.dot, this.stateKind(args.state))
      : '';
    // v4.9.0 pre-ship UI: turn counter retired entirely — value-to-pixel
    // ratio too low. `args.turnCount` stays in the signature for caller
    // back-compat; ignored here.
    void args.turnCount;
    // v4.8.0 Slice 9 hotfix — ⌛ restored ahead of the bare elapsed
    // string. Wider font support than the retired ⏱. `sessionMs` arg
    // stays plumbed-but-unused for backward compat with the field name.
    const sessionSeg = args.elapsedMs !== undefined
      ? `${sk.applyColors(glyphs.status.timer, 'success')} ${sk.applyColors(formatElapsedShort(args.elapsedMs), 'success')}`
      : '';
    // ctxRatio + ctxPctText are pre-painted (warn + ctxKind respectively).
    const ctxSegFull = `${ctxRatio} ${bar} ${ctxPctText}`;
    const ctxSegCompact = `${bar} ${ctxPctText}`;

    // v4.10 Slice 10.3 — full-density-tier extras:
    //   - brand prefix `Aiden v4.X`
    //   - spelled-out `last <elapsed>` for last-turn time
    //   - session uptime `<elapsed>` from sessionMs (re-enabled; the
    //     v4.9.0 comment retired it but Slice 10.3 brings it back
    //     because it's signal users want during long sessions)
    const brandSeg = `${sk.applyColors(`Aiden v${AIDEN_VERSION}`, 'brand')}`;
    const lastTurnSpelled = args.elapsedMs !== undefined
      ? `${sk.applyColors(glyphs.status.timer, 'success')} ${sk.applyColors(`last ${formatElapsedShort(args.elapsedMs)}`, 'success')}`
      : '';
    const sessionUptimeSeg = (typeof args.sessionMs === 'number' && args.sessionMs > 0)
      ? sk.applyColors(formatElapsedShort(args.sessionMs), 'muted')
      : '';

    let segments: string[];
    if (cols >= 120 && stateDot && sessionSeg) {
      // Full density — v4.10 Slice 10.3 adds brand + session uptime
      // + spelled-out "last <elapsed>" for the per-turn timer. Order:
      //   Aiden v4.X · provider · model │ ctx │ session-uptime │ last 18s │ state
      segments = [brandSeg, provModel, ctxSegFull];
      if (sessionUptimeSeg) segments.push(sessionUptimeSeg);
      segments.push(lastTurnSpelled, stateDot);
    } else if (cols >= 100) {
      // v4.8.1 Slice 2 hotfix — sessionSeg keeps the ⌛ identity glyph
      // (single-cell, cheap) even at this tier. v4.9.0 pre-ship UI:
      // turn counter retired; mid tier collapses to 2 separators.
      // v4.10 Slice 10.3: brand + spell-out withheld here (width budget).
      segments = [provModel, ctxSegFull, sessionSeg || elapsed];
    } else {
      segments = [provModel, ctxSegCompact, sessionSeg || elapsed];
    }
    return `  ${segments.join(SEP)}`;
  }

  /** Map a per-turn outcome to the colour kind used by the state dot. */
  private stateKind(state: 'ok' | 'warn' | 'error' | 'muted'): ColorKind {
    if (state === 'ok')    return 'success';
    if (state === 'warn')  return 'warn';
    if (state === 'error') return 'error';
    return 'muted';
  }

  /**
   * Tier-3.1 (v4.1-tier3.1): pre-prompt status line.
   *
   * Single-line summary written ABOVE the input prompt on every
   * fresh turn. Format (full, ≥76 cols):
   *
   *   <provider>:<model> · ctx <N>/<M>k · MCP <state> · cron <state>
   *
   * Width-tier degrade:
   *   <52 cols  → only `<provider>:<model> · ctx N/Mk`
   *   <76 cols  → drop voice indicator
   *   ≥76 cols  → full
   *
   * MCP serve mode: this helper is a pure builder; callers MUST
   * gate the actual write on `isMcpServeMode()` from
   * `cli/v4/uiBuild.ts`. The function itself never writes.
   */
  renderStatusLine(args: {
    provider:    string;
    model:       string;
    ctxUsed?:    number;
    ctxMax?:     number;
    mcpState?:   'active' | 'configured' | 'broken' | 'off';
    cronState?:  'active' | 'configured' | 'broken' | 'off';
    voiceRecording?: boolean;
    cols?:       number;
  }): string {
    const sk = this.skin;
    const cols = args.cols ?? this.cols();
    const SEP = sk.applyColors(' · ', 'muted');

    const colourForState = (s?: string): 'success' | 'muted' | 'error' => {
      if (s === 'active') return 'success';
      if (s === 'broken') return 'error';
      return 'muted';
    };
    const glyphForState = (s?: string): string => {
      if (s === 'active') return '✓';      // ✓
      if (s === 'broken') return '✗';      // ✗
      return '-';
    };

    const provModel =
      sk.applyColors(args.provider, 'muted') +
      sk.applyColors(':', 'muted') +
      sk.applyColors(args.model, 'agent');

    const ctxSeg = (() => {
      if (args.ctxMax == null || args.ctxUsed == null) return '';
      const usedK = Math.round(args.ctxUsed / 1000);
      const maxK  = Math.max(1, Math.round(args.ctxMax / 1000));
      return sk.applyColors(`ctx ${usedK}/${maxK}k`, 'muted');
    })();

    const mcpSeg = args.mcpState
      ? sk.applyColors(`MCP ${glyphForState(args.mcpState)}`, colourForState(args.mcpState))
      : '';
    const cronSeg = args.cronState
      ? sk.applyColors(`cron ${glyphForState(args.cronState)}`, colourForState(args.cronState))
      : '';
    const voiceSeg = args.voiceRecording
      ? sk.applyColors('[REC]', 'error')
      : '';

    // Compose with width-tier degrade.
    const segs: string[] = [provModel];
    if (ctxSeg)   segs.push(ctxSeg);
    if (cols >= 52) {
      if (mcpSeg)  segs.push(mcpSeg);
      if (cronSeg) segs.push(cronSeg);
    }
    if (cols >= 76 && voiceSeg) segs.push(voiceSeg);

    return '  ' + segs.join(SEP);
  }

  /**
   * Optional provider-switch indicator line — emitted only when this
   * turn ran on a different provider than the previous one.  Format
   * matches v3:
   *
   *   groq ──→ openrouter
   */
  providerSwitchLine(prev: string, next: string): string {
    return `  ${this.skin.applyColors(`${prev} ──→ ${next}`, 'muted')}`;
  }

  /**
   * Inquirer prompt prefix — "▲ " in brand orange (Phase 26.2.6 lock:
   * reverted from the brief Phase 26.2.3 `●` swap to keep the prompt
   * glyph aligned with the bottom hint's `▲ Type your message …` and
   * with Aiden's brand mark from v3). Inquirer prepends its own
   * padding, so we only ship the bare 2-char prefix.
   *
   * Phase 26.2.8 — when `AIDEN_UI_TIMESTAMPS=1`, prepends a muted
   * `HH:MM:SS  ` so the user's input line reads
   * `12:41:02  ▲ <input>`. Default OFF preserves `▲ <input>`.
   */
  promptPrefix(): string {
    // v4.8.0 Slice 7 hotfix #2 — 2-space lead matches the rest of the
    // surface family (▎ Aiden header, status footer, bottom hint).
    // Timestamp variant unchanged — the timestamp gutter already
    // provides its own consistent left edge.
    const tri = this.skin.applyColors('▲', 'brand');
    if (process.env.AIDEN_UI_TIMESTAMPS === '1') {
      return `${this.timestampPrefix()}  ${tri} `;
    }
    return `  ${tri} `;
  }

  /**
   * Phase 26.2.6 — pick a random phrase from `SPINNER_PHRASES`,
   * append `…`, and wrap in brand orange. `rand` is injectable so
   * tests can pin the selection (and the chat REPL passes the
   * default Math.random for live use).
   */
  thinkingPhrase(rand: () => number = Math.random): string {
    const idx = Math.floor(rand() * SPINNER_PHRASES.length);
    const phrase = SPINNER_PHRASES[Math.max(0, Math.min(SPINNER_PHRASES.length - 1, idx))];
    return this.skin.applyColors(`${phrase}…`, 'brand');
  }

  /**
   * Start a spinner. The implementation is a tiny custom one (no `ora`
   * dependency) so it survives non-TTY pipes and Windows ConPTY without
   * extra config. When stdout is not a TTY the spinner becomes a no-op
   * apart from emitting `text\n` once.
   */
  startSpinner(text: string): SpinnerHandle {
    const skin = this.skin;
    const frames = skin.getActive().glyphs?.spinner ?? ['|', '/', '-', '\\'];
    const isTty = !!this.out.isTTY;
    let current = text;
    let stopped = false;
    let frame = 0;
    let timer: NodeJS.Timeout | null = null;

    const render = (): void => {
      if (!isTty || stopped) return;
      // Phase 23.5: spinner glyph in soft cyan (muted), not brand orange.
      // Quiet color, not loud.
      const glyph = skin.applyColors(frames[frame % frames.length], 'muted');
      this.out.write(`\r${glyph} ${current}   `);
      frame += 1;
    };

    if (isTty) {
      render();
      timer = setInterval(render, 90);
    } else {
      this.out.write(`${text}\n`);
    }

    return {
      setText(next: string): void {
        current = next;
      },
      stop: (finalText?: string): void => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        if (isTty) {
          // clear the spinner line and write the final text on its own line
          this.out.write('\r\x1b[K');
        }
        if (finalText) this.out.write(`${finalText}\n`);
      },
    };
  }

  /**
   * v4.1.4 reply-quality polish — Part 1.6 activity indicator.
   *
   * Renders `▲ {verb}{dots} (Ns)    ▸▸ Ctrl+C cancel` on a single
   * line. `verb` is the activity label; the dots pulse 0→1→2→3→0
   * every 400ms; elapsed time `(Ns)` appears only once N >= 1 (avoids
   * the `(0s)` flash). The "▸▸ Ctrl+C cancel" hint is folded into the
   * same line so cursor management stays simple (single-line write,
   * single-line erase).
   *
   * Pause/resume semantics:
   *   - `pause()` erases the line + stops the tick + sets paused=true.
   *     Elapsed time keeps accumulating wall-clock — when a later
   *     `resume()` re-renders, the indicator shows the TOTAL elapsed
   *     since the original `activityIndicator()` call, not just since
   *     the last resume.
   *   - `resume(verb?)` re-renders on a fresh line below the current
   *     cursor and restarts the tick. Optional `verb` swap is the
   *     supported way to transition phases ("thinking" → "drafting").
   *   - `stop()` is terminal — erases the line, marks stopped, refuses
   *     further pause/resume.
   *
   * Non-TTY: completely silent. No initial paint, no ticks, no erases.
   * Pipes / CI / MCP serve mode get clean output by default.
   *
   * Cursor invariant on render: the indicator OWNS one line. After
   * each render the cursor sits at column 0 of the indicator line
   * (NOT a new line below it) — that way the next render erases the
   * line and rewrites in place. Callers that want to write OTHER
   * content below MUST call `pause()` first; otherwise their content
   * lands on the indicator line and the next tick clobbers it.
   */
  /**
   * v4.1.5 Issue K — wave-bar option.
   *
   * When `opts.waveBar === true` (DEFAULT), the indicator paints a
   * second row BELOW the verb line — a 10-cell `▰▱` snake-scroll
   * heartbeat that gives visible motion during long pre-first-token
   * gaps even when the verb doesn't change. The bar is NOT progress:
   * it's a constant-cadence heartbeat (250ms shared with the dot
   * pulse), explicitly not a percentage indicator.
   *
   * Pass `{ waveBar: false }` for back-compat with v4.1.4 tests that
   * assert single-row geometry. Production callers (chatSession) get
   * the wave bar by default.
   */
  activityIndicator(
    initialVerb: string = 'thinking',
    opts: { waveBar?: boolean } = {},
  ): ActivityIndicatorHandle {
    const sk     = this.skin;
    const out    = this.out;
    const isTty  = !!out.isTTY;
    const startTime = Date.now();

    let verb        = initialVerb;
    let dotFrame    = 0;
    let paused      = !isTty;  // non-TTY = effectively pre-paused (silent)
    let stopped     = false;
    let printed     = false;
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    // v4.8.1 Slice 2 hotfix #4 — true once the indicator has paused
    // and resumed at least once (i.e. a tool row interrupted it). When
    // false at stop() time, the indicator is still in its initial-paint
    // row immediately below the leading blank, so stop()'s erase can
    // safely consume BOTH rows. When true, the leading blank is far
    // above and stop() erases only the current indicator row.
    let movedFromInitial = false;

    // Tunable cadence. v4.1.4 Phase 3b' (Issue G): bumped from 400ms
    // to 250ms after visual smoke — 400ms felt sluggish, made the
    // indicator look static between seconds. 250ms gives ~4 dot
    // updates per second so motion is always visible even when the
    // (Ns) counter hasn't ticked. Slow enough not to flicker on SSH
    // / slow ConPTY refresh.
    const TICK_MS = 250;

    // v4.8.0 Slice 11 — leading glyph is no longer a static `⌛` (or
    // a separate 2nd-row wave bar). Now it's a single-row sliding
    // shimmer: a 4-cell brand-orange `█` segment that scrolls L→R
    // across a muted `─` track, wrapping at the right edge. The dots
    // pulse + (Ns) timer keep their roles as secondary motion cues;
    // the shimmer is the primary "something is happening" affordance
    // in TTFT space. Token-sourced from `glyphs.shimmer` so the glyph
    // pair lives next to the rest of the v4.8.0 design system.
    //
    // `opts.waveBar` is preserved as a back-compat option that maps
    // to "shimmer enabled". Pass `{ waveBar: false }` to drop the
    // shimmer cluster and render the bare verb row (the legacy
    // v4.1.4 single-row indicator). Default ON.
    const shimmerEnabled = opts.waveBar !== false;
    const SHIMMER_CELLS  = 10;
    const SHIMMER_BLOCK  = 4;
    let shimmerFrame = 0;

    /**
     * v4.8.0 Slice 11 — render the sliding-block shimmer. A 4-cell
     * `█` (U+2588 FULL BLOCK) segment at positions `[frame,
     * frame+1, frame+2, frame+3]` mod 10, on a muted `─` track.
     * Brand-orange block, muted track. Token-sourced glyphs;
     * cell-by-cell paint keeps glyph order true to position so
     * the wrap visibly slides rather than jumping.
     *
     * Heartbeat semantics: this is NOT progress. The block moves
     * at a constant 250ms cadence regardless of any backend metric.
     * It exists purely so the user sees motion during the
     * unobservable TTFT (time-to-first-token) wait. The verb +
     * dot pulse + (Ns) timer carry the real lifecycle signal.
     */
    const buildShimmer = (): string => {
      const filled = new Set<number>();
      for (let i = 0; i < SHIMMER_BLOCK; i += 1) {
        filled.add((shimmerFrame + i) % SHIMMER_CELLS);
      }
      const cells: string[] = [];
      for (let c = 0; c < SHIMMER_CELLS; c += 1) {
        cells.push(filled.has(c)
          ? sk.applyColors(glyphs.shimmer.block, 'brand')
          : sk.applyColors(glyphs.shimmer.track, 'muted'));
      }
      return cells.join('');
    };

    const buildLine = (): string => {
      const dots = '.'.repeat(dotFrame); // 0..3 dots
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      const elapsedStr = elapsedSec >= 1
        ? ` ${sk.applyColors(`(${elapsedSec}s)`, 'muted')}`
        : '';
      // Shimmer prefix (or none, when opts.waveBar === false).
      const prefix = shimmerEnabled ? `${buildShimmer()} ` : '';
      // v4.8.1 Slice 2 hotfix #4 — 2-space leading indent so the
      // indicator line aligns at col 2, matching `▎ Aiden`, the
      // user-prompt `  ▲ `, the panel `  │ ` bar, and every other
      // structured surface. Prior buildLine started at col 0 which
      // read as misaligned against the rest of the v4.8 chrome.
      return `  ${prefix}${verb}${dots.padEnd(3, ' ')}${elapsedStr}`;
    };

    // v4.1.5 Part 1a — Issue M (Windows ConPTY buffering fix).
    //
    // Prior pattern wrote `\r\x1b[K{indicator}` with NO trailing
    // newline. On Windows ConPTY, `process.stdout` buffers no-newline
    // writes — none of the 60 indicator ticks during a 15s gap
    // actually rendered. The final reply's `\n` chars eventually
    // flushed the buffer, but by then the indicator's stop()-erase
    // had also been buffered + flushed, so the user saw 15s of blank
    // followed by the reply dumping all at once.
    //
    // Fix: indicator OWNS one terminal row. Every write that paints
    // the indicator ends with `\n`, which forces a flush on every
    // platform. The cursor sits on the LINE BELOW the indicator
    // while it's running (one visible empty row gap). When the
    // indicator stops/pauses, we walk back UP to the indicator's
    // row and erase it — the cursor then sits at col 0 of that
    // (now empty) row, ready for the caller to write whatever
    // content follows (header, tool row, stream output).
    //
    // ANSI primitives:
    //   `\x1b[1A` — cursor up 1 line
    //   `\x1b[2K` — erase the whole current line
    // Sequence on tick:    walk up → erase → paint → `\n` → cursor below.
    // Sequence on erase:   walk up → erase (no newline). Cursor on the
    //                      now-empty indicator row, ready for caller.
    const ANSI_UP_ERASE = '\x1b[1A\x1b[2K';

    const renderTick = (): void => {
      if (stopped || paused || !isTty) return;
      dotFrame = (dotFrame + 1) % 4;
      // v4.8.0 Slice 11 — shimmer slides 1 cell per tick. Same 250ms
      // cadence as the dot pulse, so block + dots move in visible
      // lockstep. Modulo SHIMMER_CELLS wraps the leading block back
      // to the left edge.
      shimmerFrame = (shimmerFrame + 1) % SHIMMER_CELLS;
      // Single-row layout: walk up 1, erase, repaint, newline. Cursor
      // lands on the row below the indicator, ready for the next
      // tick to walk back up.
      out.write(`${ANSI_UP_ERASE}${buildLine()}\n`);
    };

    const startTick = (): void => {
      if (stopped || !isTty || tickTimer !== null) return;
      tickTimer = setInterval(renderTick, TICK_MS);
    };

    const stopTick = (): void => {
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    };

    const eraseLine = (): void => {
      // Walk up 1 row + erase + drop a newline so the cursor lands
      // on a blank line BELOW the indicator's old footprint. The
      // trailing `\n` provides one visible blank row of breathing
      // space and acts as a Windows ConPTY flush trigger (v4.1.5
      // Issue M). Slice 11 collapsed the prior 2-row layout to 1.
      if (!isTty || !printed) return;
      out.write(`${ANSI_UP_ERASE}\n`);
    };

    // Initial paint — only on TTY.
    //
    // v4.8.1 Slice 2 hotfix #4 — leading `\n` restored to give one
    // blank row between the user-input row and the indicator (hotfix
    // #3 dropped the dim rule that previously provided that gap).
    // To keep the post-stop layout at "exactly one blank between
    // user input and ▎ Aiden", stop() now walks up TWO rows when
    // the indicator never moved (no pause/resume), consuming both
    // the indicator row AND the leading blank. The `movedFromInitial`
    // flag below tracks that state.
    if (isTty) {
      out.write(`\n${buildLine()}\n`);
      printed = true;
      startTick();
    }

    return {
      pause: () => {
        if (stopped || paused) return;
        paused = true;
        stopTick();
        // v4.8.1 Slice 2 hotfix #4 — mark the indicator as "moved" so
        // a subsequent stop() does NOT walk up 2 rows. The leading
        // blank from initial paint is now far above the current row
        // and shouldn't be consumed; doing so would erase tool-row
        // content instead.
        movedFromInitial = true;
        eraseLine();
        // After erase the cursor is at column 0 of the indicator's
        // (now empty) line. Caller is expected to write its own
        // content next; that content lands cleanly on this line.
      },
      resume: (newVerb?: string) => {
        if (stopped) return;
        if (typeof newVerb === 'string' && newVerb.length > 0) verb = newVerb;
        if (!paused) return;
        paused = false;
        if (!isTty) return;
        // Caller has just finished writing its own content (typically
        // ending with `\n`), so the cursor is on a fresh line below
        // whatever was there. Paint the indicator + `\n` to claim the
        // current row and leave the cursor on the row below — same
        // invariant the initial paint and tick maintain. Trailing `\n`
        // also flushes Windows ConPTY buffering (Issue M).
        //
        // v4.8.0 Slice 11 — single-row layout: paint one row only.
        // (Initial paint includes a leading `\n` for breathing space;
        // resume omits it because the caller has already written its
        // own content above this point and an extra blank would
        // double up.)
        out.write(`${buildLine()}\n`);
        printed = true;
        startTick();
      },
      setVerb: (newVerb: string) => {
        if (typeof newVerb === 'string' && newVerb.length > 0) verb = newVerb;
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        stopTick();
        // v4.8.1 Slice 2 hotfix #4 — when the indicator never moved
        // (no pause/resume happened during the turn), walk up TWO
        // rows: erase the indicator row AND the leading blank above
        // it. The trailing `\n` then lands the cursor exactly one
        // row below the user-input echo, so the next writer
        // (agentHeader → ▎ Aiden) produces a clean single-blank gap.
        if (!printed || !isTty) return;
        if (movedFromInitial) {
          out.write(`${ANSI_UP_ERASE}\n`);
        } else {
          out.write(`${ANSI_UP_ERASE}${ANSI_UP_ERASE}\n`);
        }
      },
      isPaused:  () => paused,
      isStopped: () => stopped,
    };
  }

  // ── Phase 23.5 — tool event row ───────────────────────────────────────
  // One line per tool call: a "·" gutter, the keyword `tool`, the
  // tool name (soft cyan, padded), a brief truncated arg preview, and
  // a single right-side bracket cluster carrying state. Bracket
  // mutates in place: [running] → [ok 220ms] / [fail 1.4s] / [retry
  // 1/2 …] / product-specific terminals. No multi-line spew, no raw
  // JSON deltas.
  //
  // On non-TTY stdout (pipes, CI logs) the row is deferred until
  // completion so each line in the log carries the final state — no
  // ANSI cursor games on a dumb sink.

  toolRow(name: string, args: unknown): ToolRowHandle {
    // v4.1.5 Phase 1d (Q-Q2-a) — TRAIL_HIDE_TOOLS suppression.
    //
    // Some tools are pure agent plumbing — the model calls them to
    // introspect its own registry, not to do user-visible work.
    // `lookup_tool_schema` is the canonical case: during planning
    // the agent may invoke it 30+ times to discover unfamiliar tool
    // shapes. Each call is a sub-millisecond in-memory lookup, but
    // they flood the visible trail with noise that obscures the
    // actual user-relevant tool calls.
    //
    // Short-circuit: hidden tools get a NO-OP handle that satisfies
    // the `ToolRowHandle` contract (ok/fail/degraded/retry/blocked/
    // emptyRetry/emptyFail all defined but write nothing). The
    // execution path itself is unaffected — the agent still calls
    // the tool, the planner / skill-enforcement trackers still
    // record it. Only the visual row is suppressed.
    //
    // CRITICAL invariant: `setBeforeFirstToolHook` is fired by
    // callbacks.ts BEFORE `toolRow()` is called (see callbacks.ts
    // onToolCall 'before' branch), so `turnHadTools` flips even for
    // hidden tools. The separator logic stays correct regardless of
    // whether ONLY hidden tools fired this turn.
    if (TRAIL_HIDE_TOOLS.has(name)) {
      return makeNoOpToolRowHandle();
    }

    const sk = this.skin;

    // ── Build the fixed left portion (icon + verb + detail) ────────────
    // v4.1.3-repl-polish: icons default ON; set AIDEN_UI_ICONS=0 to
    // disable (CI / dumb terminals / narrow SSH sessions).
    // Read at call-time so env changes take effect without restart.
    const useIcons = process.env.AIDEN_UI_ICONS !== '0';
    const { icon, verb } = trailIconForTool(name);
    const glyph = useIcons ? icon : sk.applyColors('·', 'muted');

    // Detail field: v4.1.4-media — consult `buildToolPreview` first so
    // tools registered in `TOOL_PRIMARY_ARG` (media_transport → 'target',
    // media_key → 'action', file_read → 'path', etc.) get their
    // meaningful primary-arg preview instead of a JSON blob. Fall back
    // to the generic `previewToolArgs` scan for tools the map doesn't
    // know about so unregistered MCP tools etc. still render readably.
    const mapped = buildToolPreview(name, args);
    const detail = truncDetail(mapped ?? previewToolArgs(args));

    // v4.1.3-essentials: live tool indicator. Capture wall-clock start
    // so the running-row renderer can append an elapsed-time suffix
    // ("running 3s…") after the first second. Sub-second tools render
    // without the suffix — no flash of `running 0s` for fast paths.
    const startedAt = Date.now();

    // Running row — muted pipe, raw icon, tool-colored verb, muted detail.
    // The optional `running Ns…` tail appears once the tool crosses the
    // 1-second mark; the tick interval below redraws this row every 1s.
    //
    // v4.8.0 Slice 11c — double-space between `${glyph}` and `${padVerb}`.
    // Emoji-class icons (`👁️`, `✏️`, `📋`, `🌐`, etc.) render 2-cell-wide
    // visually on Windows ConPTY but the cursor/column tracker treats
    // them as 1 cell, so a single trailing space is visually swallowed
    // by the emoji's right cell. Two spaces guarantees one visible gap
    // regardless of how the terminal measures the glyph.
    const runningRow = (): string => {
      const elapsed = Date.now() - startedAt;
      const liveSuffix = elapsed >= 1000
        ? `  ${sk.applyColors(`running ${formatToolDuration(elapsed)}…`, 'muted')}`
        : '';
      return `${sk.applyColors(TRAIL_PIPE, 'muted')} ${glyph}  ` +
             `${sk.applyColors(padVerb(verb), 'tool')} ` +
             `${sk.applyColors(detail, 'muted')}${liveSuffix}\n`;
    };

    // Outcome row — entire line colored by outcome kind.
    const outcomeRow = (suffix: string, kind: ColorKindForBracket): string => {
      const content =
        `${TRAIL_PIPE} ${glyph}  ${padVerb(verb)} ${detail}` +
        (suffix ? `  ${suffix}` : '');
      return `${sk.applyColors(content, kind)}\n`;
    };

    // Capture stream reference so closures don't need `this`.
    const out = this.out;
    const isTty = !!out.isTTY;
    let printed = false;

    // v4.1.3-essentials: tick handle for the live-elapsed update. Set
    // when we start the interval; cleared by every terminal method
    // (ok / fail / degraded / blocked / emptyFail / emptyRetry) AND by
    // `retry` (retry is a state announcement and should hold static
    // until the next state change — race-free).
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    const stopTick = (): void => {
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    };

    // Erase the last printed line (TTY only).
    const eraseLast = (): void => {
      if (isTty && printed) out.write('\x1b[1A\x1b[2K\r');
    };

    const writeFinal = (suffix: string, kind: ColorKindForBracket): void => {
      stopTick();
      eraseLast();
      out.write(outcomeRow(suffix, kind));
      printed = true;
    };

    if (isTty) {
      // v4.1.3-essentials (replaces v4.1.3-repl-polish streamInterrupted
      // flag pattern): if a stream is active, fence off the current
      // chunk BEFORE the running row writes. `commitStreamChunk` does
      // its own newline-fencing + in-place rerender of the just-streamed
      // chunk so this row lands cleanly on its own line below.
      this.commitStreamChunk();
      out.write(runningRow());
      printed = true;
      // v4.1.3-essentials: start the live-elapsed ticker. Fires every
      // 1s; first tick at +1s, when `runningRow()` starts emitting the
      // `running 1s…` suffix. Cleared by every terminal method via
      // `stopTick()` — no leaked timers across the tool lifecycle.
      // Tool dispatch in aidenAgent is sequential (one tool at a time
      // per turn) so the assumption "running row is the last written
      // line" holds for the whole tick lifetime; `eraseLast()` is safe.
      tickTimer = setInterval(() => {
        if (!printed) return;
        eraseLast();
        out.write(runningRow());
      }, 1000);
    }
    // Non-TTY: hold off until completion (log lines carry final state).
    // No tick — non-TTY sinks (pipes, CI logs) get one line per call
    // with the final state; live updates would be noise in scrollback.

    return {
      ok(durationMs: number, retries = 0) {
        stopTick();
        if (retries > 0) {
          // Showed retries — surface the eventual success in warn so the
          // user knows it took multiple attempts.
          writeFinal(
            `ok ${formatToolDuration(durationMs)} after ${retries} ${retries === 1 ? 'retry' : 'retries'}`,
            'warn',
          );
        } else {
          // v4.1.5 Issue N — persistent tool trail in scrollback.
          //
          // Prior behaviour: silent erase on clean success (`eraseLast()`
          // with no replacement write). Tool rows for successful tools
          // vanished, leaving only the markdown reply visible afterward.
          // The user couldn't see WHAT actions Aiden took unless a tool
          // failed or degraded.
          //
          // Fix: replace the silent erase with a completed-state row
          // painted entirely in warm-muted (`#b8a89a` from v4.1.4). The
          // duration suffix replaces the live `running Ns…` chrome; the
          // whole row reads "done" via reduced visual weight. Failed /
          // degraded / retry outcomes keep their existing coloured paint
          // (error red, degraded yellow, warn amber) — only clean success
          // shifts from "silent" to "muted-persistent."
          //
          // The persistence mechanism is the existing `writeFinal` path:
          // it walks up + erases the running row, then writes the final
          // row with trailing `\n`. The row sits in scrollback because
          // `streamComplete` rerenders only the post-tool stream chunk
          // (via `streamLineCount` which was reset to 0 inside
          // `commitStreamChunk` before this row wrote). No additional
          // isolation machinery needed — already verified by 13/13
          // `smoke-stream-rerender.ts` regressions.
          writeFinal(formatToolDuration(durationMs), 'muted');
        }
      },
      fail(durationMs: number, retries = 0) {
        const suffix =
          retries > 0
            ? `fail ${formatToolDuration(durationMs)} after ${retries} ${retries === 1 ? 'retry' : 'retries'}`
            : `fail ${formatToolDuration(durationMs)}`;
        writeFinal(suffix, 'error');
      },
      degraded(durationMs: number, reason?: string) {
        const suffix = reason
          ? `partial ${formatToolDuration(durationMs)} — ${reason}`
          : `partial ${formatToolDuration(durationMs)}`;
        writeFinal(suffix, 'degraded');
      },
      retry(n: number, m: number) {
        // v4.1.3-essentials: retry is a state-change announcement —
        // freeze the row at the retry counter until next state change.
        // Stopping the ticker prevents the next 1s tick from racing
        // back over the retry counter with `running Ns…`.
        stopTick();
        // Update the running row with retry count.
        // v4.8.0 Slice 11c — double-space between glyph and verb (see
        // runningRow comment above for the emoji-width rationale).
        eraseLast();
        const content =
          `${TRAIL_PIPE} ${glyph}  ${padVerb(verb)} ${detail}  retry ${n}/${m} …`;
        out.write(sk.applyColors(content, 'warn') + '\n');
        printed = true;
      },
      blocked() {
        writeFinal('blocked', 'warn');
      },
      emptyRetry() {
        writeFinal('empty retry', 'warn');
      },
      emptyFail() {
        writeFinal('empty fail', 'error');
      },
    };
  }

  /**
   * Pretty-print a tool call before it executes. Phase v4.1.2 first
   * consults the `TOOL_PRIMARY_ARG` map in `toolPreview.ts` to render
   * just the meaningful argument (e.g. `terminal: npm test`); falls
   * back to the legacy full-JSON stringification (200-char hard cap)
   * for tools that aren't in the map.
   */
  toolPreview(name: string, args: unknown): string {
    const sk = this.skin;
    const arrow = sk.getActive().glyphs?.arrow ?? '>';

    // Phase v4.1.2: per-tool primary-arg preview.
    const preview = buildToolPreview(name, args);
    if (preview !== null) {
      if (preview === '') {
        return `${sk.applyColors(arrow, 'tool')} ${sk.applyColors(name, 'tool')}`;
      }
      return `${sk.applyColors(arrow, 'tool')} ${sk.applyColors(name, 'tool')} ${sk.applyColors(preview, 'muted')}`;
    }

    // Unknown tool — original behaviour (full JSON, 200-char cap).
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      serialized = String(args);
    }
    if (serialized.length > 200) serialized = `${serialized.slice(0, 197)}...`;
    return `${sk.applyColors(arrow, 'tool')} ${sk.applyColors(name, 'tool')} ${sk.applyColors(serialized, 'muted')}`;
  }

  /**
   * Render markdown to ANSI via the v4.1-reply-formatting renderer
   * (skin-aware headers / lists / code / quotes / links). Falls back
   * to the marked-terminal default config if the structured renderer
   * is unavailable, then raw text as a last resort.
   */
  markdown(text: string): string {
    try {
      return getReplyRenderer().render(text);
    } catch {
      try {
        const out = marked.parse(text);
        return typeof out === 'string' ? out : String(out);
      } catch {
        return text;
      }
    }
  }

  /** Format a user turn (e.g. echoed back from history). */
  userTurn(text: string): string {
    const sk = this.skin;
    const arrow = sk.getActive().glyphs?.arrow ?? '>';
    return `${sk.applyColors(`${arrow} you`, 'user')}\n${text}\n`;
  }

  /**
   * Format an agent turn in the Phase 23.6 v3-style:
   *
   *     Aiden                       (bold orange label)
   *     ─────────────────────…      (muted thin rule)
   *     <body>                       (rendered markdown / plain text)
   *
   * Body is indented 2 columns to match the boot card and footer.
   * Trailing newline included so the caller can stack a status footer
   * directly underneath.
   */
  agentTurn(text: string, opts: AgentTurnOptions = {}): string {
    const sk = this.skin;
    const useMd = opts.markdown !== false;
    const rawBody = useMd ? this.markdown(text).trimEnd() : text;
    // v4.1.4 reply-quality polish — F1 detect-and-skip indent + wrap.
    //
    // Walks the rendered markdown line-by-line, but applies frame
    // indent/wrap ONLY to plain prose lines. Lines that already carry
    // structural chrome (code-block rail+bg, blockquote rail,
    // pre-indented list bullets) pass through untouched — `renderCode-
    // Block`, `renderBlockquote`, and the list override already own
    // their own gutter + per-line wrap. Double-applying the gutter
    // shifts content right by 3 cols; double-wrapping breaks the rail
    // off the wrap-continuation row. See `isPreFramedLine` for the
    // detection rules.
    const indented = this.applyFrameToRendered(rawBody);
    const reasoning = opts.reasoning
      ? `${frameGetIndent(0)}${sk.applyColors(opts.reasoning.trim(), 'muted')}\n`
      : '';
    return `${this.agentHeader()}${reasoning}${indented}\n`;
  }

  /**
   * v4.1.4 reply-quality polish — F1 shared helper.
   *
   * Apply frame indent + soft-wrap to the prose lines of a rendered
   * markdown body, but pass structural lines (code-block rail+bg,
   * blockquote rail, pre-indented list bullets) through unchanged.
   *
   * Shared by `agentTurn` (one-shot reply) and `tryRerenderInPlace`
   * (post-stream rerender) so both paths produce identical output.
   */
  private applyFrameToRendered(rawBody: string): string {
    // v4.8.0 Slice 7 hotfix #2 — override frame.GUTTER (3) to 2 cells
    // locally so Aiden reply prose aligns with the ▎ bar of agentHeader
    // (col 2). The GUTTER constant stays at 3 for other consumers
    // (markdown list/blockquote/code-block renderers in frame.ts) where
    // a 3-cell gutter is part of their own visual algebra.
    const indent = '  ';
    const bw     = frameGetBodyWidth(this.out);
    return rawBody
      .split('\n')
      .map((ln) => {
        if (ln.length === 0) return '';
        // F1 detect-and-skip: pre-framed lines (code-block chrome, list
        // bullets, blockquote rails) own their own gutter + wrap. Don't
        // re-indent or re-wrap them — that double-applies the gutter
        // and breaks the rail off wrap-continuation rows.
        if (isPreFramedLine(ln)) return ln;
        // Plain prose: indent + wrap to bodyWidth. wrap-ansi handles
        // ANSI-aware width counting so bold/heading paint survives.
        const wrapped = frameWrap(ln, bw, { trim: false, hard: true });
        return wrapped
          .split('\n')
          .map((vln) => `${indent}${vln}`)
          .join('\n');
      })
      .join('\n');
  }

  /**
   * Format a recoverable error with optional remediation suggestion.
   * Output goes through the caller (returned as string), not stderr.
   */
  error(message: string, suggestion?: string): string {
    const sk = this.skin;
    const head = sk.applyColors('error:', 'error');
    const body = `${head} ${message}`;
    if (!suggestion) return `${body}\n`;
    return `${body}\n${sk.applyColors('hint:', 'warn')} ${suggestion}\n`;
  }

  /** Direct write helpers used by callers that already formatted text. */
  write(text: string): void {
    this.out.write(text);
  }
  writeError(text: string): void {
    this.err.write(text);
  }

  // ── Phase 14b helpers ─────────────────────────────────────────────────
  // Thin wrappers that print colour-prefixed lines via `write()`. These
  // exist so the slash-command handlers and CLI callbacks don't have to
  // hand-roll ANSI strings every time they want to emit a status line.
  // They always emit a trailing newline.

  /** Informational line, e.g. "Switching model…". */
  info(text: string): void {
    this.out.write(`${this.skin.applyColors('›', 'accent')} ${text}\n`);
  }

  /** Success line, e.g. "Switched to anthropic:claude-opus-4-7". */
  success(text: string): void {
    this.out.write(`${this.skin.applyColors('✓', 'success')} ${text}\n`);
  }

  /** Warning line, e.g. "Verbose mode requires restart." */
  warn(text: string): void {
    this.out.write(`${this.skin.applyColors('!', 'warn')} ${text}\n`);
  }

  /** Muted ("dim") line for low-priority diagnostics. */
  dim(text: string): void {
    this.out.write(`${this.skin.applyColors(text, 'muted')}\n`);
  }

  /**
   * Wrap `text` with the active skin's brand colour (orange #FF6B35 in
   * the default skin). Used by boxed framing for major UX moments —
   * setup-complete, /doctor results, critical errors. Returns a string
   * so callers can compose lines; does not write.
   */
  brand(text: string): string {
    return this.skin.applyColors(text, 'brand');
  }

  /**
   * Wrap `text` with the active skin's muted colour (soft cyan #6FB3D2
   * in the default skin) and return the string. Companion to `brand` —
   * use when composing partially-coloured lines like the status bar
   * where some segments are coloured separately. `dim()` writes a full
   * line; `muted()` returns a fragment.
   */
  muted(text: string): string {
    return this.skin.applyColors(text, 'muted');
  }

  /**
   * Wrap `text` with a semantic colour and return the string. Used by
   * the status bar's right-most state segment (ready/generating/exec/
   * approve/retry) where each state has a distinct colour.
   */
  paint(text: string, kind: 'brand' | 'success' | 'warn' | 'error' | 'muted'): string {
    return this.skin.applyColors(text, kind);
  }

  /**
   * Phase 26.2.1 — render a tight pill: `‹label VALUE›` (with leading
   * space-separated label) or `‹VALUE›` when label is empty. The
   * `‹›` glyphs (U+2039 / U+203A) sit in `muted`; the label sits in
   * `muted`; the value sits in `kind` (default `brand`). Pure — returns
   * a string with no trailing newline so callers can compose multiple
   * pills on a single line.
   *
   * Used by the boot card (single `‹v4.0.0›` pill) and Phase 26.2.2's
   * status-bar pill row.
   */
  pill(label: string, value: string, kind: 'brand' | 'success' | 'warn' | 'error' | 'muted' = 'brand'): string {
    const open = this.skin.applyColors('‹', 'muted');
    const close = this.skin.applyColors('›', 'muted');
    const lbl = label ? `${this.skin.applyColors(label, 'muted')} ` : '';
    const val = this.skin.applyColors(value, kind);
    return `${open}${lbl}${val}${close}`;
  }

  /** Horizontal rule for grouping CLI output. */
  line(width = 60): void {
    const ch = this.skin.getActive().glyphs?.bullet === '*' ? '-' : '─';
    this.out.write(`${this.skin.applyColors(ch.repeat(width), 'muted')}\n`);
  }

  /** Convenience: format an error and write it directly to stdout. */
  printError(message: string, suggestion?: string): void {
    this.out.write(this.error(message, suggestion));
  }

  /**
   * v4.1.3-essentials: render a structured capability card. Used when
   * a tool fails because a capability is missing (platform unsupported,
   * auth not present, key env-var unset) and a generic error wouldn't
   * give the user enough signal. The card lists what the user CAN
   * still do, what's blocked, and a one-line fix.
   *
   * Delegates the layout to the pure renderer in `./display/capability-
   * Card.ts`. This method is the I/O boundary — caller passes data, we
   * write lines to the configured stdout. Trailing newline ensures the
   * card sits clean above whatever renders next (typically the prompt).
   */
  capabilityCard(data: CapabilityCardData): void {
    // v4.1.3-essentials: fence off any active stream chunk before the
    // card writes so the chunk gets rerendered as markdown and the
    // card lands below it on its own line. Same pattern as toolRow /
    // streamToolIndicator.
    this.commitStreamChunk();
    const lines = renderCapabilityCard(data, (t, k) => this.applyColors(t, k));
    for (const line of lines) {
      this.out.write(line + '\n');
    }
    this.out.write('\n');
  }

  // ── Phase 16c: streaming surface ─────────────────────────────────────
  // Tracks whether a streaming "Aiden" header has been written for the
  // current turn. `streamPartial` writes the header on the first call,
  // then appends every subsequent delta directly. `streamComplete`
  // closes the line so the next non-stream `agentTurn`/`info` call
  // starts on its own line.

  private streamHeaderShown = false;
  private streamLastEndedNewline = false;
  // Phase v4.1-reply-formatting: track the running buffered stream
  // so streamComplete can re-render it as structured markdown
  // (headers / lists / code blocks / blockquotes) once the full
  // body is known. During streaming the raw text remains visible
  // — the post-stream pass clears it via cursor-up + erase-line and
  // reprints the formatted output.
  private streamBuffer = '';
  private streamLineCount = 0;

  /**
   * v4.1.4 reply-quality polish (Q-ResizeReflow Option B): zero the
   * per-chunk row counter when the terminal resizes mid-stream.
   *
   * Why: the resize guard hard-clears the viewport (`\x1b[2J\x1b[H`)
   * which removes ALL rows from the screen — but our `streamLineCount`
   * still believes those rows are there. The next `tryRerenderInPlace`
   * would walk the cursor back N rows that no longer exist, leaving a
   * ghost gap at the top of the new viewport. Zeroing the count makes
   * the next eraser a no-op (which is correct — there's nothing left
   * to erase).
   *
   * Idempotent: no-op when no stream is active. Safe to call from a
   * resize callback that fires unconditionally on every viewport
   * change. Also resets `streamBuffer` so the next commit doesn't try
   * to rerender content that was already wiped.
   */
  resetStreamFrameForResize(): void {
    if (!this.streamHeaderShown) return;
    this.streamLineCount = 0;
    this.streamBuffer = '';
    // Header was wiped by the hard-clear too — let the next
    // streamPartial / agentTurn write a fresh one.
    this.streamHeaderShown = false;
    this.streamLastEndedNewline = false;
  }

  /**
   * Append a streamed text fragment. Writes a styled "Aiden" header on
   * the first call of a turn, then writes raw text directly via the
   * underlying `write` so token boundaries remain visible. Markdown
   * rendering is deferred — applying `marked` per-token would render
   * partial code fences as broken HTML; pattern of
   * showing raw streamed text and reformatting on completion only when
   * the full body is in hand.
   */
  streamPartial(text: string): void {
    if (!text) return;
    if (!this.streamHeaderShown) {
      // Phase 26.2.3 — share the `▎ Aiden` header with non-streaming
      // agentTurn so streamed + non-streamed responses open identically.
      this.out.write(this.agentHeader());
      this.streamHeaderShown = true;
      this.streamBuffer = '';
      this.streamLineCount = 0;
      this.uiEventsFiredThisTurn = false;
      // agentHeader emits trailing `\n\n`; cursor is at col 0 of a fresh
      // line, so the very next chunk needs the leading indent.
      this.streamLastEndedNewline = true;
    }
    // v4.8.0 Slice 7 hotfix #3 — inject a 2-cell indent at every line
    // start so streamed content aligns with the ▎ bar in agentHeader.
    // Pre-this-fix the raw chunk wrote at col 0; the post-stream
    // rerender in applyFrameToRendered would indent eventually, but
    // mid-stream the user saw col-0 content. streamBuffer stays raw
    // (the rerender path applies its own indent).
    const indent = '  ';
    let toWrite = text;
    if (this.streamLastEndedNewline) toWrite = indent + toWrite;
    const endsNl = toWrite.endsWith('\n');
    const body = endsNl ? toWrite.slice(0, -1) : toWrite;
    toWrite = body.replace(/\n/g, '\n' + indent) + (endsNl ? '\n' : '');
    this.out.write(toWrite);
    this.streamLastEndedNewline = text.endsWith('\n');
    // Phase v4.1-reply-formatting: track buffer + line count for the
    // post-stream re-render.
    this.streamBuffer += text;
    // v4.1.4 reply-quality polish — F-B1 wrap-aware row count.
    //
    // Prior counter just `streamLineCount += text.match(/\n/g)?.length`
    // — counted `\n` chars only. When the model emits a long single
    // line (e.g. a 100-char bullet on an 80-col terminal), the terminal
    // naturally wraps it across multiple screen rows, but the old
    // counter would still think it's 1 row. At streamComplete the
    // eraser walked back N rows that didn't match the wrapped row
    // count → raw `**markup**` from the streaming phase remained
    // visible above the rerendered output.
    //
    // Confirmed undercount via scripts/smoke-stream-wrap-count.ts:
    // 3 long bullets on 80-col counted 3, actually 6. Multi-chunk
    // preamble + bullets on 40-col counted 4, actually 8.
    //
    // Fix: count `ceil(visibleWidth / cols)` rows per `\n`-delimited
    // segment, then add 1 for the `\n` itself (cursor advances to
    // next row when newline is emitted). Visible width strips ANSI.
    this.streamLineCount += this.countStreamRows(text);
  }

  /**
   * v4.1.4 reply-quality polish — F-B1 helper.
   *
   * Estimate how many screen rows `text` consumes when written to a
   * terminal of width `this.out.columns`. Counts terminal-natural-wrap
   * rows for each logical line, plus one row per `\n`.
   *
   * Falls back to a sane count when columns is undefined (non-TTY or
   * pre-resize): in that case the eraser won't fire anyway
   * (`tryRerenderInPlace` gates on `out.isTTY`), so the count is
   * effectively ignored. We still compute a defensible value so any
   * future TTY-detection change doesn't silently regress.
   *
   * Pure with respect to ANSI: escape sequences pass through
   * `visibleLength` and don't inflate the row count.
   *
   * Edge cases:
   *   - Empty text → 0 rows (consistent with the prior counter).
   *   - Text without `\n` → ceil(visibleLen / cols) rows.
   *   - Trailing `\n` → counts the prior content row + 1 for the
   *     newline. Cursor is now at the start of the next row, which is
   *     correct screen-state — the next streamPartial extends from
   *     col 0 of that row.
   */
  private countStreamRows(text: string): number {
    if (text.length === 0) return 0;
    const cols = (typeof this.out.columns === 'number' && this.out.columns >= 1)
      ? this.out.columns
      : 80;
    // Semantics: counter tracks ROW BOUNDARIES CROSSED during
    // emission, not "rows occupied". The eraser uses `\x1b[<N>F`
    // which moves the cursor up N rows; if N matches the number of
    // boundaries crossed from start-of-stream to current-cursor, the
    // eraser lands at the start row and `\x1b[J` clears the rest.
    //
    // For a segment of visible width V on a terminal of width C:
    //   - V == 0       → 0 wrap boundaries
    //   - V <= C       → 0 wrap boundaries (single row)
    //   - C < V <= 2C  → 1 wrap boundary
    //   - General      → floor((V - 1) / C) wrap boundaries
    //
    // Each `\n` between segments crosses one boundary regardless of
    // visible width — that's the newline advancing the cursor.
    let rows = 0;
    const segments = text.split('\n');
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i] ?? '';
      const visible = visibleLength(seg);
      if (visible > 0) rows += Math.floor((visible - 1) / cols);
      if (i < segments.length - 1) rows += 1;
    }
    return rows;
  }

  /**
   * v4.1.3-essentials: rerender a buffered stream chunk in place. Walks
   * the cursor back `lines` rows, erases to end-of-screen, and reprints
   * the chunk as skin-aware markdown.
   *
   * Pure side-effect; returns nothing. Used by:
   *   - `commitStreamChunk()`        — when a tool row interrupts the
   *                                    stream, render the pre-tool
   *                                    chunk before the row writes.
   *   - `streamComplete()`           — final chunk at end of turn.
   *
   * Heuristic gate avoids flicker on plain prose (no structure → no
   * rerender, no eraser fires). The catch block writes the RAW buffered
   * text as a fallback if `marked` throws — without this the eraser
   * would already have run and the body would silently vanish.
   * v4.1.3-essentials raw-text fallback per "make state legible" thesis.
   */
  private tryRerenderInPlace(buffered: string, lines: number): void {
    if (!this.out.isTTY) return;
    if (process.env.AIDEN_NO_REFORMAT === '1') return;
    if (lines === 0) return;
    // v4.8.0 Phase 2.3 fix — when ui_* events painted this turn, skip the
    // cursor-up + erase-to-end-of-screen rerender. The eraser wipes
    // anything below where the stream started, including our event rows.
    // Tradeoff: assistant text on a ui-event turn stays raw (no in-place
    // markdown beautification). Acceptable — when the model is using
    // structured ui events, it's signalling state, not relying on prose
    // formatting.
    if (this.uiEventsFiredThisTurn) return;
    // Cheap structural heuristic — only re-render when formatting
    // actually helps. Plain prose chunks stay raw (no flicker).
    //
    // v4.1.3-essentials post-ship: inline `**bold**` and `` `code` ``
    // added to the heuristic. Before this, a chunk that contained ONLY
    // inline markdown (no headings / lists / code blocks) skipped
    // rerender entirely, leaving the literal `**bold**` asterisks in
    // user-visible output. The `paintBoldWhite` strong renderer was
    // never invoked for those chunks.
    //
    // Patterns:
    //   - `**bold**`: requires non-space immediately after the opening
    //     `**` so `2 ** 3` math expressions don't false-positive.
    //     Tolerates multi-line bold via `[\s\S]*?`.
    //   - `` `code` ``: negative-lookarounds for the triple-backtick
    //     fence so we don't double-trigger when ``` lines are present
    //     (those already match the fence pattern above).
    const hasStructure =
      /^#{1,6}\s/m.test(buffered) ||
      /^\s*[-*+]\s/m.test(buffered) ||
      /^\s*\d+\.\s/m.test(buffered) ||
      /^>\s/m.test(buffered) ||
      /```/.test(buffered) ||
      /\*\*\S[\s\S]*?\*\*/.test(buffered) ||
      /(?<![`])`[^`\n]+`(?![`])/.test(buffered);
    if (!hasStructure) return;

    try {
      // \x1b[<n>F = cursor-up-and-to-column-0 N times.
      // \x1b[J   = erase from cursor to end of screen.
      this.out.write(`\x1b[${lines}F\x1b[J`);
      const formatted = this.markdown(buffered).trimEnd();
      // v4.1.4 reply-quality polish: same detect-and-skip indent + wrap
      // as agentTurn so streamed and one-shot replies share the visible
      // frame. wrap-ansi handles ANSI-aware width counting for prose;
      // structural lines (code-block chrome, list bullets, blockquote
      // rails) pass through unchanged so their own gutter + wrap stays
      // intact.
      const indented = this.applyFrameToRendered(formatted);
      this.out.write(indented + '\n');
    } catch {
      // Eraser already ran. v4.1.3-essentials: write the raw buffered
      // text back so the body doesn't vanish silently. The user sees
      // unformatted markdown rather than a missing reply — the honest
      // failure mode.
      this.out.write(buffered);
      if (!buffered.endsWith('\n')) this.out.write('\n');
    }
  }

  /**
   * v4.1.3-essentials: fence off the current stream chunk before a
   * non-stream write (tool row, tool indicator, capability card) lands.
   *
   * Replaces the v4.1.3-repl-polish `streamInterrupted` flag pattern.
   * Old pattern: set flag mid-stream → on streamComplete, check flag
   * and SKIP rerender entirely (lost markdown on every tool-using
   * turn). New pattern: at each interrupt point, eagerly rerender THIS
   * chunk in place, then reset the per-chunk window so the next
   * streamPartial starts a fresh count. The cursor is at the end of
   * this chunk when commit fires, so `streamLineCount` is correct for
   * the eraser — tool rows write below without being clobbered.
   *
   * Multi-chunk turns (model says X, calls tool, says Y, calls tool,
   * says Z) get all three chunks rerendered as markdown.
   *
   * Idempotent: no-op when no stream cycle is active or when the buffer
   * is empty (consecutive tool calls). Always ensures the cursor sits
   * at start-of-line before returning so the caller can write its own
   * row cleanly.
   */
  private commitStreamChunk(): void {
    if (!this.streamHeaderShown) return;
    // Ensure the streamed chunk ends with a newline so the interrupt
    // row doesn't stick to mid-token text from the prior delta.
    if (!this.streamLastEndedNewline) {
      this.out.write('\n');
      this.streamLastEndedNewline = true;
      // The trailing newline we just wrote DOES bump the cursor's row,
      // but only by 1 — and `streamLineCount` should reflect physical
      // rows of the chunk. Add it so the eraser walks back the right
      // amount.
      this.streamLineCount += 1;
    }

    // v4.1.3-essentials boldwrap-fix: if the chunk ends mid-bold-pair
    // (e.g. tool fired between the model emitting `**` and the closing
    // `**`), splitting here would leave literal asterisks in the
    // rerendered output and a matching orphan in the next chunk.
    // `splitAtUnclosedBold` finds the last unmatched `**` and carves
    // the buffer into two parts: the closed-bold prefix we CAN
    // rerender now, and the carry tail that we keep for the next
    // chunk (where the closing `**` will eventually arrive).
    //
    // Code-fence safety (carried in the helper): if the would-be
    // unmatched `**` is inside an open ``` fence, we defer the whole
    // chunk — bold-syntax inside code blocks isn't markdown bold and
    // splitting there would corrupt the fence.
    const split = splitAtUnclosedBold(this.streamBuffer);

    if (split.carry === '') {
      // Common case: buffer is balanced (or has no `**` at all).
      // Same behavior as before — rerender the whole chunk in place
      // and reset the per-chunk window.
      this.tryRerenderInPlace(this.streamBuffer, this.streamLineCount);
      this.streamBuffer = '';
      this.streamLineCount = 0;
      return;
    }

    // Split path: erase the WHOLE chunk (because the cursor is at the
    // end of the full buffer), rerender the closed prefix, then
    // re-emit the carry as raw text. The carry visibly stays on
    // screen as raw `**Live tool indi`-style text — ugly for the
    // ~milliseconds until the next streamPartial extends it past the
    // closing `**`, at which point the next commit will rerender
    // cleanly.
    const rerenderableLines = countNewlines(split.rerenderable);
    const carryLines        = this.streamLineCount - rerenderableLines;
    if (this.out.isTTY && this.streamLineCount > 0) {
      // \x1b[<n>F = cursor-up-and-to-column-0 N times.
      // \x1b[J   = erase from cursor to end of screen.
      this.out.write(`\x1b[${this.streamLineCount}F\x1b[J`);
    }
    // Rerender the closed prefix (handles its own heuristic gate
    // internally — a prefix without structure stays raw, which is
    // identical to the pre-split behavior).
    this.tryRerenderInPlace(split.rerenderable, rerenderableLines);
    // Re-emit the carry verbatim. It's intentionally raw because the
    // unmatched `**` can't be rendered without its closing pair.
    this.out.write(split.carry);
    // Reset the per-chunk window to the carry only. Next streamPartial
    // extends it; when the closing `**` lands, the next commit (or
    // streamComplete) rerenders cleanly.
    this.streamBuffer    = split.carry;
    this.streamLineCount = carryLines;
    this.streamLastEndedNewline = split.carry.endsWith('\n');
  }

  /**
   * Mark the end of a streaming turn. Adds a trailing newline if the
   * stream didn't end with one so the next CLI line doesn't visually
   * butt up against the model's last token. Rerenders the FINAL chunk
   * (post-last-tool prose, or the whole body if no tools fired this
   * turn) and resets the per-turn state so the next `streamPartial`
   * re-emits the header.
   */
  streamComplete(): void {
    if (!this.streamHeaderShown) return;
    if (!this.streamLastEndedNewline) {
      this.out.write('\n');
      this.streamLineCount += 1;
    }
    // Final chunk: same in-place rerender path as commitStreamChunk
    // (factored shared helper). Tool-row interrupts have already
    // committed their preceding chunks; what's left in the buffer here
    // is the post-final-tool prose — typically the bulk of the
    // user-visible body in well-behaved turns.
    this.tryRerenderInPlace(this.streamBuffer, this.streamLineCount);
    this.streamBuffer = '';
    this.streamLineCount = 0;
    this.streamHeaderShown = false;
    this.streamLastEndedNewline = false;
    // v4.8.0 Phase 2.3 fix — turn ends; clear the ui-fired flag.
    this.uiEventsFiredThisTurn = false;
  }

  /**
   * Phase v4.1-reply-formatting: render the optional "Sources"
   * footer when AIDEN_CITATIONS=1 and the trace has fetch-class
   * tool calls. Pure write; safe to call after a turn completes
   * regardless of streaming/non-streaming. No-op when the env gate
   * is off or no sources surface.
   */
  printCitationFooter(trace: Array<{ name: string; args?: unknown; result?: unknown }>): void {
    const footer = renderCitationFooter(trace);
    if (!footer) return;
    if (!this.out.isTTY) return;
    this.out.write(footer);
  }

  /**
   * Inline tool indicator. Printed between deltas when a tool call
   * surfaces during streaming so the user sees activity instead of a
   * stalled cursor. Always lands on its own line — adds a leading
   * newline if the prior delta ran past column N without one.
   */
  streamToolIndicator(name: string): void {
    // v4.1.3-essentials (replaces v4.1.3-repl-polish streamInterrupted
    // flag pattern): fence off the streamed chunk before the indicator
    // writes. `commitStreamChunk` handles the newline-or-not and
    // in-place rerenders the pre-indicator chunk so this row lands
    // below well-formed markdown rather than below raw streamed text.
    this.commitStreamChunk();
    const sk = this.skin;
    const arrow = sk.getActive().glyphs?.arrow ?? '>';
    this.out.write(`${sk.applyColors(`${arrow} ${name}…`, 'tool')}\n`);
    this.streamLastEndedNewline = true;
  }

  // v4.8.0 Phase 2.3 — task_id → label map for in-flight ui_task_update
  // rows. ui_task_done looks up the label so the completion row can
  // echo it even when the model only sends task_id + status. Cleared
  // on done. Map is per-Display-instance; one REPL session.
  private uiTaskRows = new Map<string, { label: string }>();

  // v4.8.0 Phase 2.3 fix — set true by renderUiEvent; tryRerenderInPlace
  // early-returns when set so the cursor-up + erase-to-end-of-screen
  // sequence can't wipe our ui_* rows. Reset at stream lifecycle
  // boundaries (streamPartial first-delta init + streamComplete).
  private uiEventsFiredThisTurn = false;

  /**
   * v4.8.0 Phase 2.3 — render a semantic ui_* event signalled by the
   * model via a uiOnly tool call. Append-only: each event paints one
   * row; in-place mutation is a v4.8.x upgrade if UX demands it.
   *
   * Currently handles `ui_task_update` and `ui_task_done`; other 5
   * names land in Phase 2.4 (silent ignore until then). Non-TTY out
   * surfaces silent — matches the activityIndicator precedent.
   */
  /**
   * v4.8.0 Phase 2.3 fix-2 — reset the per-turn ui-event flag. Called
   * by chatSession at the top of each turn. The existing reset sites
   * (streamPartial first-delta + streamComplete) only fire when the
   * turn actually streamed text deltas. Tool-only turns never reset,
   * leaving the flag sticky into subsequent turns. This is the
   * authoritative reset for turn-start.
   */
  resetUiTurnState(): void {
    this.uiEventsFiredThisTurn = false;
  }

  renderUiEvent(name: string, args: Record<string, unknown>): void {
    if (!this.out.isTTY) return;
    // v4.8.0 Phase 2.3 fix — Option C. The post-stream markdown rerender
    // (`tryRerenderInPlace`) does `cursor-up-N + erase-to-end-of-screen`,
    // which wipes anything painted between stream start and stream end —
    // including our ui_* rows. Mark the turn so the rerender skips this
    // turn entirely. Resets when the next streaming turn begins (see
    // streamPartial header init) and on streamComplete cleanup.
    this.uiEventsFiredThisTurn = true;
    if (name === 'ui_task_update')      { this.renderUiTaskUpdate(args);      return; }
    if (name === 'ui_task_done')        { this.renderUiTaskDone(args);        return; }
    if (name === 'ui_command_result')   { this.renderUiCommandResult(args);   return; }
    if (name === 'ui_test_result')      { this.renderUiTestResult(args);      return; }
    if (name === 'ui_approval_request') { this.renderUiApprovalRequest(args); return; }
    if (name === 'ui_toast')            { this.renderUiToast(args);           return; }
    if (name === 'ui_artifact_created') { this.renderUiArtifactCreated(args); return; }
    // Unknown event names silent-ignore (defensive — future registrations).
  }

  /**
   * v4.8.0 Phase 2.4 polish — build one trail-gutter row matching the
   * `toolRow` chrome (muted `┊` + space + colored content + `\n`).
   * Splits on embedded newlines so multi-line surfaces (capped stdout,
   * preview tails, optional reasons) carry the gutter on every line.
   */
  private uiTrailRow(content: string, kind: ColorKind): string {
    const pipe = this.skin.applyColors(TRAIL_PIPE, 'muted');
    return content.split('\n').map(l => `${pipe} ${this.skin.applyColors(l, kind)}\n`).join('');
  }

  private renderUiTaskUpdate(args: Record<string, unknown>): void {
    const taskId  = typeof args.task_id === 'string' ? args.task_id : '';
    const label   = typeof args.label   === 'string' ? args.label   : '';
    const status  = typeof args.status  === 'string' ? args.status  : '';
    const kindArg = typeof args.kind    === 'string' ? args.kind    : 'task';
    const depth   = typeof args.depth   === 'number' && args.depth > 0 ? args.depth : 0;
    if (!taskId || !label) return;
    this.commitStreamChunk();
    const glyph = status === 'paused' ? '⏸' : status === 'blocked' ? '⛔' : '⟳';
    const colorKind: ColorKind = status === 'running' ? 'tool' : 'warn';
    this.uiTaskRows.set(taskId, { label });
    const short  = label.length > 80 ? label.slice(0, 79) + '…' : label;
    // v4.8.0 Phase 2.4 — subagent kind: indent by depth inside the
    // gutter so nested rows tier below their parent.
    const indent = kindArg === 'subagent' ? '  '.repeat(depth) : '';
    this.out.write(this.uiTrailRow(`${indent}${glyph} ${short}`, colorKind));
    this.streamLastEndedNewline = true;
  }

  private renderUiTaskDone(args: Record<string, unknown>): void {
    const taskId  = typeof args.task_id === 'string' ? args.task_id : '';
    const status  = typeof args.status  === 'string' ? args.status  : '';
    const summary = typeof args.summary === 'string' ? args.summary : '';
    if (!taskId) return;
    this.commitStreamChunk();
    const tracked = this.uiTaskRows.get(taskId);
    const label = tracked?.label ?? taskId;
    this.uiTaskRows.delete(taskId);
    const glyph = status === 'success' ? '✓' : status === 'failure' ? '✗' : '⊘';
    const kind: ColorKind =
      status === 'success' ? 'success' :
      status === 'failure' ? 'error'   : 'warn';
    const shortLabel = label.length > 80 ? label.slice(0, 79) + '…' : label;
    const shortSum   = summary.length > 120 ? summary.slice(0, 119) + '…' : summary;
    const tail = shortSum ? ` — ${shortSum}` : '';
    this.out.write(this.uiTrailRow(`${glyph} ${shortLabel}${tail}`, kind));
    this.streamLastEndedNewline = true;
  }

  private renderUiCommandResult(args: Record<string, unknown>): void {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command) return;
    const stdout  = typeof args.stdout  === 'string' ? args.stdout  : '';
    const stderr  = typeof args.stderr  === 'string' ? args.stderr  : '';
    const exitCode = typeof args.exit_code === 'number' ? args.exit_code : 0;
    this.commitStreamChunk();
    const ok = exitCode === 0;
    const cap = (t: string): string => t.split('\n').slice(0, 5).join('\n');
    let out = this.uiTrailRow(`▸ ${command}`, ok ? 'success' : 'error');
    if (stdout) out += this.uiTrailRow(cap(stdout), 'muted');
    if (stderr) out += this.uiTrailRow(cap(stderr), 'error');
    if (!ok)    out += this.uiTrailRow(`(exit ${exitCode})`, 'error');
    this.out.write(out);
    this.streamLastEndedNewline = true;
  }

  private renderUiTestResult(args: Record<string, unknown>): void {
    const framework = typeof args.framework === 'string' ? args.framework : '';
    if (!framework) return;
    const passed = typeof args.passed === 'number' ? args.passed : 0;
    const failed = typeof args.failed === 'number' ? args.failed : 0;
    const skipped = typeof args.skipped === 'number' ? args.skipped : 0;
    const durationMs = typeof args.duration_ms === 'number' ? args.duration_ms : 0;
    this.commitStreamChunk();
    const ok = failed === 0;
    const parts = [`${passed} passed`, `${failed} failed`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    const dur = durationMs > 0 ? ` in ${durationMs}ms` : '';
    this.out.write(this.uiTrailRow(`${ok ? '✓' : '✗'} ${framework}: ${parts.join(', ')}${dur}`, ok ? 'success' : 'error'));
    this.streamLastEndedNewline = true;
  }

  private renderUiApprovalRequest(_args: Record<string, unknown>): void {
    // v4.8.1 Slice 1 — silent no-op. The Phase 2.5 wiring fires both
    // `ui_approval_request` (this method) AND `callbacks.promptApproval`
    // (which paints the framed approval panel via `renderApprovalBox`)
    // for every single approval request. The intent was complementary —
    // succinct event row above, structured kv panel below — but in live
    // smoke the two surfaces stack as a visual duplicate ("Approval
    // needed: file_write {...}" event row + "│ tool / │ reason / │ args"
    // panel). The panel is the canonical, information-rich surface; this
    // event-row paint is redundant.
    //
    // Behavioural change is renderer-side only: `approvalEngine` still
    // fires `onUiEvent('ui_approval_request', ...)` so any future
    // telemetry / daemon-side run_events subscriber will still see the
    // event. Nothing paints to the chat surface from this method.
    //
    // The `_args` parameter is retained for the dispatch signature
    // contract (`renderUiEvent` calls it positionally) and for the day
    // we re-introduce a single-paint surface keyed off args.risk_tier.
  }

  private renderUiToast(args: Record<string, unknown>): void {
    const message = typeof args.message === 'string' ? args.message : '';
    if (!message) return;
    const kindArg = typeof args.kind === 'string' ? args.kind : 'info';
    this.commitStreamChunk();
    const glyph = kindArg === 'success' ? '✓' : kindArg === 'warning' ? '⚠' : kindArg === 'error' ? '✗' : 'ℹ';
    const kind: ColorKind = kindArg === 'success' ? 'success' : kindArg === 'warning' ? 'warn' : kindArg === 'error' ? 'error' : 'tool';
    const short = message.length > 120 ? message.slice(0, 119) + '…' : message;
    this.out.write(this.uiTrailRow(`${glyph} ${short}`, kind));
    this.streamLastEndedNewline = true;
  }

  private renderUiArtifactCreated(args: Record<string, unknown>): void {
    const path = typeof args.path === 'string' ? args.path : '';
    if (!path) return;
    const kindArg = typeof args.kind === 'string' ? args.kind : 'file';
    const preview = typeof args.preview === 'string' ? args.preview : '';
    this.commitStreamChunk();
    const glyph = kindArg === 'skill' ? '🛠' : kindArg === 'directory' ? '📁' : '📄';
    let out = this.uiTrailRow(`${glyph} Created: ${path}`, 'accent');
    if (preview) {
      const shortP = preview.length > 200 ? preview.slice(0, 199) + '…' : preview;
      out += this.uiTrailRow(`  ${shortP}`, 'muted');
    }
    this.out.write(out);
    this.streamLastEndedNewline = true;
  }
}

// ── Phase v4.1-voice-cli — voice indicator helper ─────────────────────

/** Voice mode UI states surfaced to the indicator. */
export type VoiceIndicatorState =
  | 'idle'
  | 'listening'
  | 'recording'
  | 'transcribing'
  | 'speaking';

/**
 * Render a voice-mode status line. Pure builder — caller writes the
 * result via Display.streamPartial / direct stdout. Includes a
 * RMS-driven block bar when state is `recording`. The bar uses 8
 * unicode block-fill levels (▏ to █) over a 0..1500 RMS range,
 * which covers the practical loud-speech ceiling without saturating
 * for any reasonable mic preamp.
 *
 * Tier-3.1 (v4.1-tier3.1): replaced 🎤 / 🔊 emoji with text-state
 * badges `[REC]` (recording, error/red) and `[PLAY]` (speaking,
 * success/green). Idle/listening/transcribing get the neutral
 * `[VOX]` badge in muted colour. Same 4-char inner width keeps
 * subsequent column alignment intact.
 *
 * Examples:
 *   voiceIndicator('idle')                  → '[VOX] idle (Space to talk)'
 *   voiceIndicator('listening')             → '[VOX] listening...'
 *   voiceIndicator('recording', 800)        → '[REC] ▌▌▌▌▌▌  recording (Space to stop, Esc to cancel)'
 *   voiceIndicator('transcribing')          → '[VOX] transcribing...'
 *   voiceIndicator('speaking')              → '[PLAY] speaking...'
 */
export function voiceIndicator(
  state: VoiceIndicatorState,
  rms: number = 0,
): string {
  const skin = getSkinEngine();
  const recBadge  = skin.applyColors('[REC]',  'error');
  const playBadge = skin.applyColors('[PLAY]', 'success');
  const voxBadge  = skin.applyColors('[VOX]',  'muted');
  switch (state) {
    case 'idle':
      return `${voxBadge} idle (Space to talk)`;
    case 'listening':
      return `${voxBadge} listening...`;
    case 'recording': {
      const bar = renderRmsBar(rms);
      return `${recBadge} ${bar}  recording (Space to stop, Esc to cancel)`;
    }
    case 'transcribing':
      return `${voxBadge} transcribing...`;
    case 'speaking':
      return `${playBadge} speaking...`;
    default:
      return `${voxBadge} ${state}`;
  }
}

const BAR_WIDTH = 12;
const BAR_FULL_RMS = 1500;

/** RMS-driven horizontal block bar. 0..BAR_FULL_RMS → 0..BAR_WIDTH chars. */
function renderRmsBar(rms: number): string {
  const safe = Math.max(0, Math.min(rms, BAR_FULL_RMS));
  const filled = Math.round((safe / BAR_FULL_RMS) * BAR_WIDTH);
  return '▌'.repeat(filled) + ' '.repeat(BAR_WIDTH - filled);
}

// ── Phase 23.5 / v4.1.3-repl-polish — tool row helpers ────────────────
//
// v4.1.3 changes the row format from:
//   "  {glyph} tool {name:16} {args}  [{state}]"
// to the compact trail format:
//   "┊ {icon} {verb:12} {detail:40}"
//
// Outcome semantics:
//   ok()        → SILENT — running row is erased; nothing persists.
//   fail()      → row persists in error (red).
//   degraded()  → row persists in degraded (yellow). NEW in v4.1.3.
//   blocked()   → row persists in warn.
//   retry()     → running row is updated with retry counter.
//   emptyFail() → treated as fail (error colour).
//   emptyRetry()→ treated as retry.

/**
 * Kept for reference / smoke-test backward compat. New code should use
 * TRAIL_VERB_PAD / TRAIL_DETAIL_CAP from toolTrail.ts instead.
 * @deprecated
 */
export const TOOL_ROW_NAME_PAD = TRAIL_VERB_PAD;
/** @deprecated Use TRAIL_DETAIL_CAP. */
export const TOOL_ROW_ARG_CAP = TRAIL_DETAIL_CAP;

/**
 * v4.1.5 Phase 1d (Q-Q2-a) — names of tools that should be SUPPRESSED
 * from the visible tool-trail row, even though they still execute
 * normally through the agent loop.
 *
 * The canonical case is `lookup_tool_schema`: the agent calls it
 * during planning to introspect tool registry entries (in-memory
 * registry get, sub-millisecond per call). On complex prompts the
 * model may fire it 30+ times in a row, flooding the visible trail
 * with rows that don't represent user-meaningful work. Suppressing
 * them keeps the trail focused on the tools that did real work
 * (web_search, file_read, etc.).
 *
 * Suppression happens at `Display.toolRow()` entry — it returns a
 * no-op handle that satisfies the `ToolRowHandle` contract but
 * never writes to stdout. The agent's `callbacks.onToolCall`
 * dispatch is unchanged: `setBeforeFirstToolHook` still fires (so
 * `turnHadTools` flips for the separator-emission logic), and
 * skill-enforcement / honesty-trace tracking still records the
 * call. Only the visual row is hidden.
 *
 * Exported as a `Set` so callers can mutate at runtime if they
 * need to hide additional tools (e.g. user customization, MCP
 * plumbing tools). Mutation-of-shared-state is intentional — there's
 * no per-session config plumbing for "trail hidden tools" yet, so
 * the env-var pattern (`AIDEN_TRAIL_HIDE=tool1,tool2`) would be the
 * v4.1.6 evolution.
 */
export const TRAIL_HIDE_TOOLS: Set<string> = new Set([
  'lookup_tool_schema',
]);

/**
 * v4.1.5 Phase 1d helper — produces a `ToolRowHandle` that satisfies
 * the contract but writes nothing. Used by hidden tools (see
 * `TRAIL_HIDE_TOOLS`) and as a safe fallback. All methods are inert.
 *
 * Pure — no side effects, no closures over Display state. Safe to
 * call from any thread / phase.
 */
export function makeNoOpToolRowHandle(): ToolRowHandle {
  return {
    ok:         () => { /* no-op: hidden from trail */ },
    fail:       () => { /* no-op: hidden from trail */ },
    degraded:   () => { /* no-op: hidden from trail */ },
    retry:      () => { /* no-op: hidden from trail */ },
    blocked:    () => { /* no-op: hidden from trail */ },
    emptyRetry: () => { /* no-op: hidden from trail */ },
    emptyFail:  () => { /* no-op: hidden from trail */ },
  };
}

// v4.1.5 Issue N — extended to include 'muted' for the new persistent
// clean-success completed-row outcome. The whole row paints in
// warm-muted (`#b8a89a`) so it reads "done" via reduced visual weight
// while staying in scrollback. Failure / degraded / retry keep their
// coloured outcomes.
type ColorKindForBracket = 'success' | 'warn' | 'error' | 'degraded' | 'muted';

/**
 * Handle returned by `Display.toolRow()`. Mutates the row in place once
 * the tool resolves. Each method writes exactly once; subsequent calls
 * would double-print.
 */
export interface ToolRowHandle {
  ok(durationMs: number, retries?: number): void;
  fail(durationMs: number, retries?: number): void;
  /**
   * v4.1.3-repl-polish — tool completed but with a degraded / best-effort
   * result (e.g. recall_session returned cached data, app_launch fell back
   * to CLI). Row persists in degraded yellow.
   */
  degraded(durationMs: number, reason?: string): void;
  retry(n: number, m: number): void;
  blocked(): void;
  emptyRetry(): void;
  emptyFail(): void;
}

/**
 * Build a compact, single-line preview of the tool's arguments. Picks
 * the most informative scalar fields when the args are an object, then
 * truncates with an ellipsis at TOOL_ROW_ARG_CAP. Pure — no side
 * effects, deterministic for a given input.
 */
export function previewToolArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return truncToolArg(args);
  if (typeof args !== 'object') return truncToolArg(String(args));
  const obj = args as Record<string, unknown>;
  // Prefer obvious "first" fields the user can recognise without
  // reading JSON. Fall back to the full JSON otherwise.
  const preferKeys = [
    'query', 'q', 'url', 'path', 'file', 'name', 'command', 'cmd',
    'message', 'text', 'content', 'prompt',
  ];
  for (const k of preferKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      return truncToolArg(k === 'url' || k === 'path' || k === 'file'
        ? v
        : `"${v}"`);
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(obj);
  } catch {
    serialized = String(obj);
  }
  // v4.1.4-media: an empty object serializes to '{}'. Rendering that
  // literal in the trail row is honest but ugly and reads as "buggy
  // empty args". When the model legitimately passes an empty args
  // object (e.g. `media_sessions({})`, `system_info()`), show nothing
  // rather than the braces — `buildToolPreview` already does this for
  // tools mapped in `TOOL_PRIMARY_ARG`; here we extend the same UX to
  // any unmapped-tool fallback that bottoms out at `{}`.
  if (serialized === '{}') return '';
  return truncToolArg(serialized);
}

function truncToolArg(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= TOOL_ROW_ARG_CAP) return flat;
  return flat.slice(0, TOOL_ROW_ARG_CAP - 1) + '…';
}

/**
 * v4.1.4 reply-quality polish — Part 1.6 tool-aware verb mapper.
 *
 * Picks the activity-indicator verb for the gap that follows a given
 * tool's completion. The verb reflects "what the model is likely doing
 * next" rather than "what just happened" — so a `file_read` completing
 * leads to "reading" (model is digesting the contents) rather than
 * "drafted" (which would imply done). Tested in display.test.ts.
 *
 * Categories (matches against the tool-name substring, lowercased):
 *   - read/list/view/get/inspect    → 'reading'
 *   - search/web/fetch_url/scrape   → 'searching'
 *   - shell/exec/run/compute/system → 'analyzing'
 *   - write/edit/patch/save         → 'drafting'
 *   - everything else (or undefined) → 'thinking'
 *
 * Special caller-supplied phase override:
 *   - When the caller knows "all tools are done, reply about to start"
 *     they pass `phase: 'post-all'` → verb defaults to 'drafting'
 *     regardless of the last tool name.
 *
 * Pure; exported for unit-test access.
 */
export function verbForActivity(
  toolName: string | undefined,
  phase: 'pre-tools' | 'post-tool' | 'post-all' = 'post-tool',
): string {
  if (phase === 'pre-tools') return 'thinking';
  if (phase === 'post-all')  return 'drafting';
  const t = (toolName ?? '').toLowerCase();
  if (t.length === 0) return 'thinking';
  // Match in priority order so 'web_search' hits 'searching' (search)
  // before 'reading' (a hypothetical 'web_search_read' would still
  // map to 'searching' since search hits first).
  if (/(^|_)(search|web|fetch_url|scrape|crawl)(_|$)/.test(t)) return 'searching';
  if (/(^|_)(read|list|view|get|inspect|info|status)(_|$)/.test(t)) return 'reading';
  if (/(^|_)(write|edit|patch|save|create|append|delete|remove)(_|$)/.test(t)) return 'drafting';
  if (/(^|_)(shell|exec|execute|run|compute|process|system|launch)(_|$)/.test(t)) return 'analyzing';
  return 'thinking';
}

/**
 * v4.1.4 reply-quality polish — F1 detect-and-skip predicate.
 *
 * Returns true when `line` is a structural / pre-framed line emitted
 * by replyRenderer (code-block chrome, blockquote rail, indented list
 * bullet, fence rules). These lines OWN their own gutter and per-line
 * wrap; `agentTurn` and `tryRerenderInPlace` MUST pass them through
 * unchanged so the post-render indent+wrap pass doesn't:
 *   - Double the gutter (content drifts 3 cols right per pass)
 *   - Re-wrap an already-wrapped code line (rail/bg breaks across
 *     the new wrap continuation row)
 *
 * Detection rules (all on the ANSI-bearing line as emitted by marked
 * via our renderer overrides):
 *   - Contains `\x1b[48;` anywhere → 24-bit bg paint = code-block
 *     line. Always pre-framed (renderCodeBlock applies gutter + rail).
 *   - Starts with `   │ ` or `   ┃ ` → explicit pre-framed rail
 *     (code or blockquote at the frame gutter).
 *   - Matches `^\s{2,}(•|▸|\d+\.)\s` (depth-indented list bullet) →
 *     the list override already applied the per-depth indent.
 *   - Matches `^\s{0,4}─{8,}` (horizontal-rule run or fence) → render-
 *     specific divider already styled.
 *
 * Pure; exported for unit-test access.
 */
export function isPreFramedLine(line: string): boolean {
  if (line.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  const stripped = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  // v4.1.4 reply-quality polish — Fix D (tightened predicate).
  //
  // Code-block body lines start with the frame gutter + rail. The
  // 24-bit bg paint (`\x1b[48;…`) also appears on these lines, but
  // we MUST NOT use bg-presence alone as the trigger: the `codespan`
  // renderer wraps inline `` `code` `` with the same bg envelope, so
  // any prose line containing inline code would be wrongly classified
  // as a code-block line and would bypass the indent + wrap pass
  // (Issue D from visual smoke — prose with inline codespans
  // terminal-natural-wrapped past bodyWidth).
  //
  // Rail prefix (after ANSI strip) is the reliable signal: only
  // `renderCodeBlock` emits `   │ ` and only `renderBlockquote` emits
  // `┃ ` at line start (with display-layer gutter prepended).
  if (/^   │ /.test(stripped)) return true;
  if (/^   ┃ /.test(stripped) || /^┃ /.test(stripped)) return true;
  // Depth-indented list bullets emitted by the renderer.list override:
  //   `  • prose…`        (depth 1, 2-space indent)
  //   `    ▸ prose…`      (depth 2, 4-space indent)
  //   `  1. prose…`       (numbered, depth 1)
  if (/^\s{2,}(•|▸|\d+\.)\s/.test(stripped)) return true;
  // Code-block fence rules (long runs of `─` with optional leading
  // gutter + optional language label from renderCodeBlock). Match
  // ANYWHERE in the line so the language-tagged top rule
  // (`   ── lang ──────…──`) trips alongside the unlabeled bottom rule.
  if (/─{8,}/.test(stripped)) return true;
  return false;
}

/**
 * v4.1.3-essentials boldwrap-fix: count `\n` occurrences in `s`.
 * Used by `commitStreamChunk` to recompute `streamLineCount` after
 * splitting a buffer at an unclosed-bold boundary. Pure helper —
 * exported for unit-test access.
 */
export function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s[i] === '\n') n += 1;
  return n;
}

/**
 * v4.1.3-essentials boldwrap-fix: split a streamed-chunk buffer at the
 * last unmatched `**` so the closed-bold prefix can be rerendered now
 * and the open-bold tail can be carried into the next chunk.
 *
 * Returns `{ rerenderable, carry }`:
 *   - rerenderable: the prefix with all `**` pairs balanced
 *   - carry:        the suffix starting at the last unmatched `**`
 *
 * `carry === ''` signals "balanced — render the whole buffer". Caller
 * uses this as the fast-path discriminator.
 *
 * Code-fence safety: if the buffer contains an UNCLOSED fenced code
 * block (` ``` ` count is odd), defer the entire chunk by returning
 * `{ rerenderable: '', carry: buffer }`. Bold-syntax inside code
 * blocks is literal text — splitting there would corrupt the fence
 * AND likely produce nonsensical rerender output. Trade-off: a chunk
 * that ends mid-code-block doesn't rerender at all until the closing
 * ``` arrives; acceptable because code blocks have their own
 * styling (dark bg + left rail) that doesn't depend on the markdown
 * rerender step.
 *
 * Pure function. Tested via `tests/v4/cli/display.test.ts`.
 */
export function splitAtUnclosedBold(
  buffer: string,
): { rerenderable: string; carry: string } {
  // Fast path: no `**` at all → balanced.
  if (!buffer.includes('**')) return { rerenderable: buffer, carry: '' };

  // Code-fence safety: count triple-backtick fences. Odd = open fence,
  // defer the whole buffer.
  const fenceMatches = buffer.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    return { rerenderable: '', carry: buffer };
  }

  // Count `**` occurrences. Even → balanced. Odd → there's an
  // unmatched `**` — find the LAST one (the open).
  const positions: number[] = [];
  for (let i = 0; i < buffer.length - 1; i += 1) {
    if (buffer[i] === '*' && buffer[i + 1] === '*') {
      positions.push(i);
      i += 1; // skip the second `*` so `***` doesn't double-count
    }
  }
  if (positions.length % 2 === 0) {
    return { rerenderable: buffer, carry: '' };
  }

  const lastUnmatched = positions[positions.length - 1];

  // Inline-backtick safety: if the unmatched `**` sits inside an
  // open single-backtick span on the same line, the `**` is literal
  // code, not a bold marker. Defer the whole chunk.
  const lineStart = buffer.lastIndexOf('\n', lastUnmatched) + 1;
  const lineUpToBold = buffer.slice(lineStart, lastUnmatched);
  const backticksOnLine = (lineUpToBold.match(/`/g) ?? []).length;
  if (backticksOnLine % 2 === 1) {
    return { rerenderable: '', carry: buffer };
  }

  return {
    rerenderable: buffer.slice(0, lastUnmatched),
    carry:        buffer.slice(lastUnmatched),
  };
}

/**
 * Render a tool-call duration in the bracket cluster. Sub-second
 * durations show ms; ≥1s shows one decimal place of seconds. Pure.
 */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  return `${Math.round(sec)}s`;
}

// ── Phase 23.6 — token / elapsed formatters for the status footer ──────

/** "12345" → "12.3K"; "1234567" → "1.2M". Used by statusFooter. */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "850" → "850ms"; "2300" → "2.3s"; "75000" → "1m 15s". */
export function formatElapsedShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1).replace(/\.0$/, '')}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec - mins * 60);
  return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
}

let _global: Display | null = null;
export function getDisplay(): Display {
  if (!_global) _global = new Display();
  return _global;
}
export function resetDisplayForTests(): void {
  _global = null;
}
