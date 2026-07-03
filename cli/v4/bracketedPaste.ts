/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/bracketedPaste.ts — Aiden v4.0.0 (Phase 16a)
 *
 * Bracketed paste mode helpers for the chat REPL.
 *
 * When bracketed paste is enabled (terminals do this in response to
 * `\x1b[?2004h`), the terminal wraps any pasted text in `\x1b[200~` … `\x1b[201~`
 * markers. That lets us distinguish a multi-line paste from the user
 * typing many <Enter>s.
 *
 * Why we need this in 16a: Phase 15's TUI relied on a timing heuristic
 * (`>=30` chars under `<10ms`) which is unreliable on slow Windows TTYs.
 * The escape-sequence approach is exact when the terminal supports it,
 * and the timing heuristic remains as a fallback for older Console hosts.
 */

export const PASTE_ENABLE = '\x1b[?2004h';
export const PASTE_DISABLE = '\x1b[?2004l';
export const PASTE_BEGIN = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/**
 * Whether `raw` is a complete bracketed paste payload — i.e. begins with
 * `\x1b[200~` and ends with `\x1b[201~`. False if either marker is absent
 * or only partial. Tolerates trailing newlines.
 */
export function isCompletePaste(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  if (!raw.startsWith(PASTE_BEGIN)) return false;
  // Allow trailing whitespace after the end marker.
  const trimEnd = raw.replace(/[\r\n]+$/, '');
  return trimEnd.endsWith(PASTE_END);
}

/**
 * If `raw` carries paste markers, strip them and return the inner content.
 * Otherwise return `raw` unchanged. Idempotent — calling on already-clean
 * input is a no-op. Handles the case where the begin marker is present
 * but the end marker is missing (unterminated paste — likely truncated):
 * we still strip the begin marker so the user's text is usable.
 */
export function stripPasteMarkers(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return raw;
  let out = raw;
  if (out.startsWith(PASTE_BEGIN)) out = out.slice(PASTE_BEGIN.length);
  // Strip trailing newlines that were emitted after the end marker.
  const trimmed = out.replace(/[\r\n]+$/, '');
  if (trimmed.endsWith(PASTE_END)) {
    out = trimmed.slice(0, -PASTE_END.length);
  } else {
    // Unterminated paste — also strip an end marker if it appears mid-string
    // (defensive — some terminals emit both markers separated by content,
    // and one could land in the middle if buffering split them oddly).
    const endIdx = out.indexOf(PASTE_END);
    if (endIdx !== -1) {
      out = out.slice(0, endIdx) + out.slice(endIdx + PASTE_END.length);
    }
  }
  return out;
}

/**
 * Regex form: remove EVERY bracketed-paste marker (`\x1b[200~` / `\x1b[201~`)
 * anywhere in the string — not just at the boundaries. This is the robust
 * strip for STREAMED / char-by-char input (the during-turn raw-mode listener),
 * where markers can arrive as a lone keypress sequence or embedded in a paste
 * burst. `stripPasteMarkers` above stays the boundary-aware form used by the
 * whole-line prompt path. One shared module — both paths strip here.
 */
// eslint-disable-next-line no-control-regex
const PASTE_MARKER_RE = /\x1b\[20[01]~/g;
export function stripAllPasteMarkers(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return raw;
  return raw.replace(PASTE_MARKER_RE, '');
}

/**
 * Detect bracketed paste markers anywhere inside `raw` (not just at the
 * boundaries). Useful for diagnosing partial / interleaved sequences.
 */
export function hasPasteMarkers(raw: string): boolean {
  return (
    typeof raw === 'string' &&
    (raw.includes(PASTE_BEGIN) || raw.includes(PASTE_END))
  );
}

/**
 * Write the enable code to a stream. Returns true on success, false if
 * the stream is missing or not writable. Safe to call repeatedly — the
 * terminal silently ignores duplicate enable codes.
 */
export function enableBracketedPaste(stream: NodeJS.WriteStream | undefined): boolean {
  if (!stream || typeof stream.write !== 'function') return false;
  try {
    stream.write(PASTE_ENABLE);
    return true;
  } catch {
    return false;
  }
}

/** Symmetric counterpart to `enableBracketedPaste`. */
export function disableBracketedPaste(stream: NodeJS.WriteStream | undefined): boolean {
  if (!stream || typeof stream.write !== 'function') return false;
  try {
    stream.write(PASTE_DISABLE);
    return true;
  } catch {
    return false;
  }
}

/** What to do with terminal bracketed-paste mode at REPL boot. */
export type PasteBootAction = 'enable' | 'disable' | 'none';

/**
 * v4.12.1 ROOT FIX — decide whether to turn terminal bracketed-paste mode ON,
 * OFF, or leave it alone at REPL boot.
 *
 * Bracketed paste exists ONLY to feed the legacy/inquirer stdin interceptor
 * (`[paste #N]` labels + anti-auto-submit), which taps `stdin.emit('data')`.
 * The frame renderer reads stdin via Ink's `stdin.read()` on the `'readable'`
 * event — which BYPASSES that tap — and Ink hands a paste to the composer
 * atomically (no auto-submit risk), so the frame path neither uses nor can be
 * cleaned by the interceptor. Worse, Ink strips the leading ESC and delivers a
 * bare `[200~` that no ESC-keyed strip can catch. So:
 *
 *   - legacy interactive TTY  → `enable`  (the interceptor needs the signal)
 *   - frame-mode interactive TTY → `disable` (never wrap a paste; markers are
 *     never generated → nothing to strip anywhere)
 *   - non-TTY / caller-supplied promptApi → `none`
 */
export function decidePasteBootAction(
  o: { isTty: boolean; hasPromptApi: boolean; frameMode: boolean },
): PasteBootAction {
  if (!o.isTty || o.hasPromptApi) return 'none';
  return o.frameMode ? 'disable' : 'enable';
}
