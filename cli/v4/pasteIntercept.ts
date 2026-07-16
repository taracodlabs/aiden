/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/pasteIntercept.ts — stdin pre-tap for bracketed paste.
 *
 * Modern @inquirer/prompts treats any embedded `\n` as Enter and
 * resolves early, so a multi-line paste would auto-submit one line
 * at a time. This module intercepts paste payloads BEFORE inquirer
 * sees them, persists them to a manifest, and substitutes a
 * `[paste #<id>: <N> lines, <bytes>]` label on stdin. The user sees
 * the label inside inquirer's input buffer, edits it like any other
 * text, then presses Enter to submit; `chatSession.readUserInput`
 * swaps the label back for the original via `getPasteOriginal(id)`
 * before handing to the agent.
 *
 * v4.8.1 Slice 2 hotfix #6 — robustness rebuild for terminal-
 * environment diversity:
 *
 *   • State machine survives reads split across chunk boundaries.
 *     The begin or end marker can arrive partially in one chunk
 *     and be completed by the next; the parser keeps state in `buf`
 *     until a full marker is observed.
 *
 *   • 800ms watchdog flushes a stuck `in_marker_paste` state if
 *     the terminal never delivers PASTE_END (mosh/tmux/SSH paths
 *     have all been observed to drop end markers under load).
 *
 *   • Degraded marker forms get normalised to canonical at the
 *     intercept boundary. Visible-escape variants (`^[[200~`) are
 *     the common case from terminals that escape control sequences
 *     for display.
 *
 *   • CRLF/CR → LF normalisation is applied universally on every
 *     incoming chunk, not just inside marker payloads. Some
 *     clipboard payloads carry CR-only line endings.
 *
 *   • 30ms timing accumulation catches line-by-line paste delivery
 *     — the failure mode that surfaced after hotfix #5. When a
 *     terminal delivers a paste as N small `"<line>\n"` chunks
 *     instead of one bulk chunk, each chunk has a single trailing
 *     `\n` and would otherwise pass through as an Enter keystroke.
 *     The accumulator holds candidate chunks (`length > 1` so the
 *     bare Enter keystroke `"\n"` is never held) for a 30ms window;
 *     if another candidate arrives, both are accumulated as a
 *     multi-line paste and substituted with the placeholder before
 *     any `\n` reaches inquirer. If no follow-up arrives within the
 *     window, the held chunk is emitted unchanged (normal Enter).
 *     30ms is imperceptible to humans and well below sustained
 *     keystroke timing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveAidenPaths } from '../../core/v4/paths';

const PASTE_BEGIN = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

/**
 * Degraded marker patterns observed in the wild. Each is rewritten
 * to canonical at the normalisation boundary so the parser only
 * needs to know about one form.
 */
const DEGRADED_BEGIN = /\^\[\[200~/g;
const DEGRADED_END   = /\^\[\[201~/g;

const ACCUMULATION_MS = 30;
const WATCHDOG_MS     = 800;

/** id → original text (in-memory swap table). Disk has /pastes/paste_<id>.txt as source of truth for /show. */
const originals = new Map<string, string>();

function pastesDir(): string {
  return path.join(resolveAidenPaths().root, 'pastes');
}

function manifestPath(): string {
  return path.join(pastesDir(), 'manifest.json');
}

function readNextIdSync(): number {
  try {
    const raw = readFileSync(manifestPath(), 'utf8');
    const j = JSON.parse(raw) as { nextId?: number };
    if (typeof j.nextId === 'number' && j.nextId >= 1) return j.nextId;
  } catch { /* missing or malformed */ }
  return 1;
}

function writeNextIdSync(next: number): void {
  const dir = pastesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify({ nextId: next }, null, 2), 'utf8');
}

function formatBytes(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

function compressSync(text: string): { id: string; label: string } {
  const dir = pastesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next = readNextIdSync();
  const id = String(next);
  writeFileSync(path.join(dir, `paste_${id}.txt`), text, 'utf8');
  writeNextIdSync(next + 1);
  const newlineCount = text.match(/\n/g)?.length ?? 0;
  const lineCount = Math.max(1, newlineCount + (text.endsWith('\n') ? 0 : 1));
  return { id, label: `[paste #${id}: ${lineCount} lines, ${formatBytes(text)}]` };
}

/**
 * Look up the original text for a paste id. Returns undefined if the
 * id was never seen by this process. Disk (/pastes/paste_<id>.txt)
 * is the source of truth for /show <id>; this map is the fast path
 * for the in-flight prompt swap.
 */
export function getPasteOriginal(id: string): string | undefined {
  return originals.get(id);
}

/**
 * Replace `[paste #N: …]` patterns in `input` with the corresponding
 * original text. Patterns whose id we don't know are left intact
 * (might be user-typed by hand).
 */
export function expandPasteLabels(input: string): string {
  return input.replace(/\[paste #(\d+):[^\]]*\]/g, (m, id) => {
    const orig = originals.get(id);
    return orig !== undefined ? orig : m;
  });
}

/**
 * Universal normalisation applied at the intercept boundary:
 * CRLF + bare CR → LF, then degraded marker variants → canonical.
 */
function normalize(text: string): string {
  let t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(DEGRADED_BEGIN, PASTE_BEGIN);
  t = t.replace(DEGRADED_END,   PASTE_END);
  return t;
}

/**
 * Decide whether `payload` should emit inline (small single-line) or
 * be funnelled through the disk-backed placeholder system. Same
 * thresholds for marker-wrapped and timing-accumulated paths so the
 * user sees identical chrome regardless of how the paste arrived.
 */
function payloadToEmission(payload: string): string {
  if (!payload.includes('\n') && payload.length <= 500) {
    return payload;
  }
  try {
    const { id, label } = compressSync(payload);
    originals.set(id, payload);
    return label;
  } catch {
    // Disk failure: collapse newlines so the auto-submit we're
    // preventing doesn't fire downstream.
    return payload.replace(/\n/g, ' ');
  }
}

let installed: { restore: () => void } | null = null;

export interface PasteInterceptOptions {
  /** Override the timing-accumulation window. Tests typically pass 0. */
  accumulationMs?: number;
  /** Override the marker-paste watchdog timeout. Tests typically pass a small value. */
  watchdogMs?: number;
}

/**
 * Install the stdin pre-tap. Wraps `process.stdin.emit('data', …)`
 * so paste payloads are captured + replaced with labels before any
 * downstream listener (inquirer) sees them. Idempotent. Returns an
 * uninstall function.
 *
 * MCP serve mode: never call this — `aiden mcp serve` doesn't run
 * the REPL.
 */
export function installPasteInterceptor(
  stdin: NodeJS.ReadStream,
  opts: PasteInterceptOptions = {},
): () => void {
  if (installed) return installed.restore;
  const accumulationMs = opts.accumulationMs ?? ACCUMULATION_MS;
  const watchdogMs     = opts.watchdogMs     ?? WATCHDOG_MS;
  const origEmit = stdin.emit.bind(stdin);

  // State machine —
  //   normal           : default; chunks pass through or accumulate
  //   in_marker_paste  : between PASTE_BEGIN and PASTE_END; buf accumulates payload
  let mode:         'normal' | 'in_marker_paste' = 'normal';
  let buf:          string = '';
  let markerTimer:  ReturnType<typeof setTimeout> | null = null;
  let pendingChunk: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function emitDownstream(text: string): void {
    if (text.length === 0) return;
    origEmit('data', Buffer.from(text, 'utf8'));
  }

  function clearMarkerWatchdog(): void {
    if (markerTimer) { clearTimeout(markerTimer); markerTimer = null; }
  }

  function armMarkerWatchdog(): void {
    clearMarkerWatchdog();
    markerTimer = setTimeout(() => {
      // PASTE_END never arrived. Flush whatever we have and reset.
      const payload = buf;
      buf = '';
      mode = 'normal';
      markerTimer = null;
      emitDownstream(payloadToEmission(payload));
    }, watchdogMs);
  }

  function clearPending(): void {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    pendingChunk = null;
  }

  function flushPendingAsIs(): void {
    if (pendingChunk === null) return;
    const chunk = pendingChunk;
    clearPending();
    // Pending was a normal Enter — emit as-is, don't placeholder.
    emitDownstream(chunk);
  }

  function flushPendingAsPaste(): void {
    if (pendingChunk === null) return;
    const chunk = pendingChunk;
    clearPending();
    emitDownstream(payloadToEmission(chunk));
  }

  function processNormalised(text: string): void {
    let cursor = 0;
    while (cursor < text.length) {
      if (mode === 'in_marker_paste') {
        const endIdx = text.indexOf(PASTE_END, cursor);
        if (endIdx === -1) {
          buf += text.slice(cursor);
          cursor = text.length;
          // Watchdog stays armed — extending the buf without an end
          // marker doesn't restart the clock; we still want to flush
          // if the entire turn never produces PASTE_END.
        } else {
          buf += text.slice(cursor, endIdx);
          cursor = endIdx + PASTE_END.length;
          // Swallow a trailing newline that some terminals emit
          // immediately after PASTE_END.
          if (text[cursor] === '\n') cursor += 1;
          mode = 'normal';
          clearMarkerWatchdog();
          const payload = buf;
          buf = '';
          emitDownstream(payloadToEmission(payload));
        }
        continue;
      }
      // mode === 'normal'
      const beginIdx = text.indexOf(PASTE_BEGIN, cursor);
      if (beginIdx !== -1) {
        // Pre-marker content: flush any pending and emit inline so
        // it lands in inquirer's buffer ahead of the placeholder
        // (preserves typed prefix when the user pastes after typing).
        flushPendingAsIs();
        if (beginIdx > cursor) emitDownstream(text.slice(cursor, beginIdx));
        cursor = beginIdx + PASTE_BEGIN.length;
        mode = 'in_marker_paste';
        armMarkerWatchdog();
        continue;
      }
      // No marker in the remainder.
      const remainder = text.slice(cursor);
      cursor = text.length;
      const nlCount = (remainder.match(/\n/g) ?? []).length;
      const hasInternalNl = nlCount > 1 || (nlCount === 1 && !remainder.endsWith('\n'));
      if (hasInternalNl) {
        // Single bulk chunk with internal newlines — instant
        // placeholder. Flush pending first so any prior single-line
        // candidate isn't lost.
        flushPendingAsIs();
        emitDownstream(payloadToEmission(remainder));
        continue;
      }
      // Candidate paste-line: non-empty content ending in `\n` with
      // length > 1 (excludes bare Enter keystroke `"\n"`).
      const isCandidate = remainder.endsWith('\n') && remainder.length > 1;
      if (isCandidate) {
        if (pendingChunk !== null) {
          // Already pending — append, restart the window.
          pendingChunk += remainder;
          if (pendingTimer) clearTimeout(pendingTimer);
          pendingTimer = setTimeout(flushPendingAsPaste, accumulationMs);
        } else {
          pendingChunk = remainder;
          pendingTimer = setTimeout(flushPendingAsIs, accumulationMs);
        }
        continue;
      }
      // Non-candidate (bare Enter, or non-`\n`-terminated keystroke).
      // Flush pending first since this chunk closes the window.
      flushPendingAsIs();
      emitDownstream(remainder);
    }
  }

  const wrappedEmit = function(this: NodeJS.ReadStream, event: string | symbol, ...args: unknown[]): boolean {
    if (event !== 'data') return origEmit(event, ...args as Parameters<typeof origEmit>);
    const chunk = args[0];
    if (chunk == null) return origEmit(event, ...args as Parameters<typeof origEmit>);
    const raw = Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : (typeof chunk === 'string' ? chunk : String(chunk));
    const normalised = normalize(raw);
    processNormalised(normalised);
    // We always claim to have handled the emit. Downstream listeners
    // fire from `emitDownstream` immediately on the same tick OR
    // from a deferred timer in the accumulation case.
    return true;
  };

  stdin.emit = wrappedEmit as typeof stdin.emit;

  const restore = (): void => {
    if (!installed) return;
    clearPending();
    clearMarkerWatchdog();
    stdin.emit = origEmit;
    installed = null;
  };
  installed = { restore };
  return restore;
}

/** Test helper: clear the in-memory map (does not touch disk). */
export function _resetForTests(): void {
  originals.clear();
  if (installed) installed.restore();
}
