/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/aidenPrompt.ts — Tier-3.1.1 (v4.1-tier3.1.1)
 *
 * Custom @inquirer/core prompt component that combines:
 *   - Standard text input (inquirer.input parity)
 *   - Ghost-text overlay for matching slash commands / history
 *   - Slash dropdown with ↑/↓ nav, Esc dismiss, description column
 *   - History suggestions for non-slash text
 *   - Cooperation with pasteIntercept (ghost disabled when a paste
 *     label is in the buffer)
 *
 * The prompt returns the typed text on Enter (NOT the ghost). The
 * user must explicitly accept the ghost via Right-arrow or Tab.
 *
 * MCP serve mode never reaches this path — the REPL is gated on
 * `process.stdout.isTTY` and serve mode runs over JSON-RPC stdio.
 *
 * `--no-ui`: the chatSession owner consults `isNoUiMode()` and
 * falls back to the legacy inquirer prompt path when the env-var
 * is set.
 */

import {
  createPrompt,
  useState,
  useKeypress,
  useEffect,
  usePrefix,
  useRef,
  isEnterKey,
  isTabKey,
  isBackspaceKey,
  makeTheme,
  type Theme,
} from '@inquirer/core';

import { findGhost } from './ghostMatch';
import { getSkinEngine } from './skinEngine';

/** Lightweight slash command shape — minimum the dropdown needs. */
export interface SlashCommandLite {
  name:        string;
  aliases?:    readonly string[];
  description: string;
  hidden?:     boolean;
}

export interface AidenPromptConfig {
  message: string;
  /** Live list of registered slash commands (excluding hidden). */
  commands: SlashCommandLite[];
  /**
   * Filter predicate for the dropdown. Defaults to the same 3-tier
   * filter chatSession used (prefix → substring → desc). Caller can
   * pass the existing commandRegistry.filter for parity.
   */
  filter?: (input: string) => SlashCommandLite[];
  /** Most-recent-first history prompts for the free-text ghost path. */
  history: string[];
  /** Optional theme override (NO_COLOR/skin path already wraps colour). */
  theme?: Partial<Theme>;
  /** Max dropdown rows visible at once. Default 8. */
  dropdownLimit?: number;
}

const DEFAULT_DROPDOWN_LIMIT = 8;

/** Strip ANSI for width math. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/** Visible width — ignore ANSI escape sequences. */
function vWidth(s: string): number {
  return stripAnsi(s).length;
}

/** Build an SGR span using the active skin. */
function dim(s: string): string {
  return getSkinEngine().applyColors(s, 'muted');
}

/** Render a single dropdown row with right-aligned dim description. */
function renderDropdownRow(
  cmd: SlashCommandLite,
  selected: boolean,
  width: number,
): string {
  const sk = getSkinEngine();
  const marker = selected ? '▸ ' : '  ';
  const nameCell = `/${cmd.name}`;
  const desc = cmd.description ?? '';
  // Reserve 2 chars for marker + 2-space pad before the desc column.
  // The desc column is right-aligned and dim-coloured.
  const lhs = `${marker}${nameCell}`;
  const lhsWidth = vWidth(lhs);
  const padBetween = Math.max(2, width - lhsWidth - vWidth(desc));
  const truncatedDesc =
    vWidth(desc) > width - lhsWidth - 2
      ? desc.slice(0, Math.max(0, width - lhsWidth - 3)) + '…'
      : desc;
  const dimDesc = sk.applyColors(truncatedDesc, 'muted');
  const painted = selected
    ? sk.applyColors(lhs, 'brand')
    : lhs;
  return painted + ' '.repeat(padBetween) + dimDesc;
}

/** Default 3-tier filter — matches commandRegistry.filter shape. */
function defaultFilter(
  cmds: SlashCommandLite[],
  input: string,
): SlashCommandLite[] {
  const stem = input.startsWith('/') ? input.slice(1) : input;
  const lower = stem.toLowerCase();
  if (!lower) return cmds.filter((c) => !c.hidden);
  const visible = cmds.filter((c) => !c.hidden);
  const prefix = visible.filter((c) =>
    c.name.toLowerCase().startsWith(lower) ||
    (c.aliases ?? []).some((a) => a.toLowerCase().startsWith(lower)),
  );
  if (prefix.length > 0) return prefix;
  const substring = visible.filter((c) =>
    c.name.toLowerCase().includes(lower) ||
    (c.aliases ?? []).some((a) => a.toLowerCase().includes(lower)),
  );
  if (substring.length > 0) return substring;
  return visible.filter((c) =>
    (c.description ?? '').toLowerCase().includes(lower),
  );
}

/**
 * The prompt itself. Resolves with the literal user-typed text on
 * Enter. If the dropdown is open and the user pressed Enter on a
 * highlighted row, resolves with `/<row.name>` instead.
 */
export default createPrompt<string, AidenPromptConfig>((config, done) => {
  const theme = makeTheme<Theme>({}, config.theme);
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const [value, setValue] = useState('');
  const [ghost, setGhost] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  // Snapshot of the typed value when the user starts navigating
  // history — restored when they reach the bottom of the stack.
  const historyDraftRef = useRef('');
  // Tier-3.1c: paste-burst guard. When bracketed paste mode isn't
  // honoured by the terminal (no CSI 200~/201~ wrap) the paste
  // arrives as raw bytes; the first internal `\n` becomes an Enter
  // event and submits before the user can review. We can't always
  // suppress that at the stdin level, so as a defence-in-depth the
  // prompt records the timestamp of the last NON-Enter keypress and
  // refuses to submit on Enter that arrives within
  // PASTE_BURST_GUARD_MS of it. Real user Enter comes after a
  // pause, so this only blocks the rapid Enter-from-paste path.
  const lastNonEnterKeyMsRef = useRef(0);

  const prefix = usePrefix({ status, theme });
  const dropdownLimit = config.dropdownLimit ?? DEFAULT_DROPDOWN_LIMIT;
  const filterFn = config.filter
    ?? ((input: string) => defaultFilter(config.commands, input));

  /** Recompute ghost + dropdown for a new value. */
  function rederive(next: string): void {
    setValue(next);
    setGhost(
      findGhost(next, {
        slashNames:   config.commands.map((c) => c.name),
        slashAliases: config.commands.flatMap((c) => [...(c.aliases ?? [])]),
        history:      config.history,
      }),
    );
    if (next.startsWith('/')) {
      const matches = filterFn(next);
      const open = matches.length > 0;
      setDropdownOpen(open);
      if (open) setSelectedIdx(Math.min(selectedIdx, matches.length - 1));
    } else {
      setDropdownOpen(false);
      setSelectedIdx(0);
    }
  }

  useEffect((rl) => {
    // Initial sync — empty.
    setValue('');
    setGhost(null);
    setDropdownOpen(false);
    void rl;
  }, []);

  useKeypress((key, rl) => {
    if (status !== 'idle') return;

    // ── Submit ──
    if (isEnterKey(key)) {
      // Tier-3.1c: paste-burst guard. If a non-Enter keystroke fired
      // within the last 50ms, this Enter is almost certainly an
      // internal `\n` from an unbracketed paste, not a deliberate
      // user submit. Suppress and let readline keep accumulating
      // bytes — the user will press Enter again once the paste
      // settles.
      const PASTE_BURST_GUARD_MS = 50;
      const sinceLastKey = Date.now() - lastNonEnterKeyMsRef.current;
      if (lastNonEnterKeyMsRef.current > 0 && sinceLastKey < PASTE_BURST_GUARD_MS) {
        // Reset so subsequent rapid Enters are also caught while
        // the burst continues.
        lastNonEnterKeyMsRef.current = Date.now();
        // Resync value in case readline already cleared the line
        // on this Enter (it does — we can't fully prevent that, but
        // we keep the buffered fragments in `value` for context).
        rederive(rl.line);
        return;
      }
      if (dropdownOpen) {
        const matches = filterFn(value);
        const picked = matches[selectedIdx];
        if (picked) {
          // Tier-3.1c: preserve typed args. If the user typed
          // `/skills list` we must submit the literal value, not
          // `/skills` alone — the row pick only short-circuits to
          // the command name when the typed value is JUST the
          // (partial) command without args. Detect args via a
          // whitespace boundary inside `value`.
          const hasArgs = /\s/.test(value);
          const out = hasArgs ? value : `/${picked.name}`;
          setStatus('done');
          setValue(out);
          done(out);
          return;
        }
      }
      // Normal submit — return literal typed text (NOT ghost).
      setStatus('done');
      done(value);
      return;
    }

    // ── Esc — dismiss dropdown ──
    if (key.name === 'escape') {
      if (dropdownOpen) {
        setDropdownOpen(false);
        return;
      }
      // No dropdown — let inquirer's default Esc handling run
      // (typically a no-op for an `input`-style prompt).
      return;
    }

    // ── Right / Tab — accept ghost ──
    if ((key.name === 'right' || isTabKey(key)) && ghost) {
      // Tab unambiguously accepts. Right-arrow only accepts when the
      // cursor is at the END of the line (otherwise the user is mid-
      // edit and right-arrow should move the cursor normally). Cursor
      // position isn't in @inquirer/type's InquirerReadline shape but
      // is on the underlying node readline — read it via cast.
      const cursorPos = (rl as { cursor?: number }).cursor ?? rl.line.length;
      const atEnd = cursorPos === rl.line.length;
      if (atEnd || isTabKey(key)) {
        const accepted = value + ghost;
        rl.clearLine(0);
        rl.write(accepted);
        rederive(accepted);
        return;
      }
    }

    // ── ↑/↓ ──
    if (key.name === 'up' || key.name === 'down') {
      if (dropdownOpen) {
        const matches = filterFn(value);
        if (matches.length > 0) {
          if (key.name === 'up') {
            setSelectedIdx((selectedIdx - 1 + matches.length) % matches.length);
          } else {
            setSelectedIdx((selectedIdx + 1) % matches.length);
          }
          return;
        }
      }
      // History nav (when dropdown closed). Up = older, Down = newer.
      if (config.history.length > 0) {
        if (key.name === 'up') {
          if (historyIdx === null) {
            historyDraftRef.current = value;
            setHistoryIdx(0);
            const next = config.history[0];
            rl.clearLine(0); rl.write(next); rederive(next);
          } else if (historyIdx + 1 < config.history.length) {
            const ni = historyIdx + 1;
            setHistoryIdx(ni);
            const next = config.history[ni];
            rl.clearLine(0); rl.write(next); rederive(next);
          }
        } else { // down
          if (historyIdx !== null) {
            if (historyIdx === 0) {
              setHistoryIdx(null);
              const draft = historyDraftRef.current;
              rl.clearLine(0); rl.write(draft); rederive(draft);
            } else {
              const ni = historyIdx - 1;
              setHistoryIdx(ni);
              const next = config.history[ni];
              rl.clearLine(0); rl.write(next); rederive(next);
            }
          }
        }
        return;
      }
      return;
    }

    // ── Backspace fast-path so cursor sync stays clean ──
    if (isBackspaceKey(key)) {
      // rl.line already updated by the readline event before this
      // handler runs, so we just resync.
      lastNonEnterKeyMsRef.current = Date.now();
      setHistoryIdx(null);
      rederive(rl.line);
      return;
    }

    // ── Default — sync from rl.line, recompute derived state ──
    // Tier-3.1c: any non-Enter keystroke updates the burst-guard
    // timestamp; the Enter handler reads it to decide whether the
    // submit is a real user Enter or part of a paste burst.
    lastNonEnterKeyMsRef.current = Date.now();
    setHistoryIdx(null);
    rederive(rl.line);
  });

  // ── Render ─────────────────────────────────────────────────────
  const message = theme.style.message(config.message, status);

  let line: string;
  if (status === 'done') {
    line = `${message} ${theme.style.answer(value)}`;
  } else {
    // v4.10 Slice 10.5 — Bug D fix, Path A (footer rendering).
    //
    // History of prior attempts (both reverted as inert):
    //   - v4.9.2 Slice 2 (commit 0d0668f1) post-pended a
    //     cursorBackward(ghost.length) escape inside this string.
    //   - v4.9.6 reframed the same idea with save/restore escapes.
    // Both failed for the same structural reason: @inquirer/core's
    // screen-manager.js (L24) strips VT control sequences from the
    // measured prompt width, and screen-manager.js (L56) emits an
    // absolute cursorTo() AFTER our content, overriding any inline
    // cursor escape. The library OWNS final cursor position on the
    // line it renders.
    //
    // Path A — pattern from prior architectural consultation: do not
    // insert terminal control side-effects into strings owned by
    // another renderer. Use the library's intended extension point.
    // @inquirer/core's documented render contract accepts a tuple
    // `[content, bottomContent]` (see create-prompt.js:115,
    // screen-manager.js:21/53-54): screen-manager paints
    // bottomContent below the input line and then walks the cursor
    // back up to the input line. With NO embedded ghost, the cursor
    // naturally lands right after `value` — correct by construction.
    //
    // UX trade-off accepted with this slice: ghost no longer appears
    // inline (visually mid-line). Instead it renders as a dim line
    // directly below the prompt. Caret positioning becomes trivially
    // correct AND independent of @inquirer/core internals. Tab /
    // Right-arrow acceptance behaviour is unchanged — that path
    // mutates `value`, not the ghost-render branch.
    //
    // Regression layer: the PTY harness test added with this slice
    // (tests/v4/cli/aidenPromptFooterGhost.test.ts) drives a real
    // Aiden under node-pty and asserts the line containing `▲ ` does
    // NOT include the ghost suggestion text. v4.9.2/v4.9.6 lacked a
    // PTY-level regression layer, which is why both shipped inert.
    line = `${prefix} ${message}${value}`;
  }

  // ── Footer assembly (bottomContent tuple slot) ───────────────────
  // Two independent sources contribute to bottomContent:
  //   1. Ghost suggestion — a single dim line, indented 2 cols to
  //      visually anchor under the prompt's `▲ ` glyph + space.
  //   2. Slash-command dropdown — multi-row picker.
  // When both fire (typing `/d` with a slash-ghost AND open dropdown),
  // the ghost line goes first (immediately below input) and the
  // dropdown rows follow. This stacking is intentional: the ghost
  // previews what Tab would complete TO, the dropdown shows the
  // full match list — same vertical column, increasing specificity.
  const ghostLine = ghost && status === 'idle'
    ? `  ${dim(ghost)}`
    : '';

  let dropdownLines: string | undefined;
  if (dropdownOpen && status === 'idle') {
    const matches = filterFn(value);
    if (matches.length > 0) {
      const visibleCols = process.stdout.columns ?? 100;
      const rowWidth = Math.max(40, Math.min(visibleCols - 4, 100));
      const window = matches.slice(0, dropdownLimit);
      // Clamp selectedIdx into the visible window.
      const safeIdx = Math.min(selectedIdx, window.length - 1);
      const rows = window.map((c, i) => renderDropdownRow(c, i === safeIdx, rowWidth));
      const more =
        matches.length > window.length
          ? `  ${dim(`… ${matches.length - window.length} more`)}`
          : '';
      dropdownLines = [...rows, more].filter((r) => r.length > 0).join('\n');
    }
  }

  const footerParts = [ghostLine, dropdownLines].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const footer = footerParts.length > 0 ? footerParts.join('\n') : undefined;

  return footer ? [line, footer] : line;
});
