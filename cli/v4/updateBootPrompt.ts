/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/updateBootPrompt.ts — v4.5 update system.
 *
 * Boxed three-option prompt rendered after the boot card / status
 * pills, before the bottomPromptHint (Q-U5(b) position). When an
 * update is available AND not skipped, the user sees:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  ◆ Aiden 4.5.1 available (you're on 4.5.0)              │
 *   │                                                         │
 *   │  What's new: bug fix for IMAP reconnect on Windows      │
 *   │                                                         │
 *   │  Update now? (y/n/later)                                │
 *   │    y       — update now, restart after                  │
 *   │    n       — skip this version (don't ask again)        │
 *   │    later   — remind me next session                     │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Behavior (Q-U2(a)):
 *   - 5-second timeout defaults to 'later' (no state change)
 *   - 'y' triggers `executeInstall` via the method-aware dispatch
 *   - 'n' persists `skippedVersion = status.latest` to the cache
 *   - 'later' is a no-op (re-prompt next session)
 *
 * Display sink: writes via the supplied `display`. Keypress capture
 * uses raw stdin mode so the user can press a single key — no Enter
 * needed for y/n. 'later' is the timeout default; an explicit 'l'
 * keypress also maps to it.
 *
 * Designed to be skippable: if stdin isn't a TTY (CI / piped /
 * non-interactive), short-circuits to 'later' immediately so boot
 * doesn't hang.
 */

import type { UpdateStatus } from '../../core/v4/update/checkUpdate';
import type { UpdateInstallPlan } from '../../core/v4/update/installPreflight';

export type UpdatePromptChoice = 'install' | 'skip' | 'later' | 'unavailable';

export interface BootUpdatePromptInput {
  status:       UpdateStatus;
  plan:         UpdateInstallPlan;
  /**
   * Display sink. Just needs `.write(s)` and `.dim(s)` (matches the
   * minimal surface other boot-time renderers use).
   */
  display:      {
    write: (s: string) => void;
    dim:   (s: string) => void;
  };
  /** Default 5_000 ms per Q-U2(a). */
  timeoutMs?:   number;
  /**
   * Test seam — when set, returns this value immediately without
   * touching stdin / setting a timer. Used by the integration test
   * harness; production never passes it.
   */
  _testChoice?: UpdatePromptChoice;
  /** Override `process.stdin` for tests. */
  stdin?:       NodeJS.ReadStream;
  /** Override `process.stdin.isTTY`. */
  isTTY?:       boolean;
  /** Responsive rendering seam. */
  columns?:     number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Pure box renderer — public so tests can assert the rendered shape
 * without driving stdin.
 */
export function renderBootUpdateBox(
  status: UpdateStatus,
  plan: UpdateInstallPlan,
  columns: number = process.stdout.columns ?? 80,
): string[] {
  const innerWidth = Math.max(38, Math.min(60, columns - 2));
  const pad = (s: string): string => {
    const visible = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const len = visible.length;
    if (len >= innerWidth) return s.slice(0, innerWidth);
    return s + ' '.repeat(innerWidth - len);
  };

  const top    = '┌' + '─'.repeat(innerWidth) + '┐';
  const bottom = '└' + '─'.repeat(innerWidth) + '┘';
  const blank  = '│' + ' '.repeat(innerWidth) + '│';

  const lines: string[] = [];
  lines.push(top);
  lines.push(blank);
  lines.push('│' + pad(`  ◆ Aiden ${status.latest} available (you're on ${status.installed})`) + '│');
  if (status.releaseNotes && status.releaseNotes.length > 0) {
    lines.push(blank);
    lines.push('│' + pad(`  What's new: ${status.releaseNotes}`) + '│');
  }
  lines.push(blank);
  if (plan.installAllowed) {
    lines.push('│' + pad('  Update now? (y/n/later)') + '│');
    lines.push('│' + pad(`    y       — install to ${plan.prefix ?? 'verified npm prefix'}`) + '│');
  } else {
    lines.push('│' + pad('  In-app update unavailable for this installation.') + '│');
    for (const detail of plan.guidance.slice(0, 2)) {
      lines.push('│' + pad(`  ${detail}`) + '│');
    }
    lines.push('│' + pad('  Choose n to skip this version, or later to be reminded.') + '│');
  }
  lines.push('│' + pad(`    n       — skip ${status.latest} (don't ask again)`) + '│');
  lines.push('│' + pad(`    later   — remind me next session (default in 5s)`) + '│');
  lines.push(blank);
  lines.push(bottom);
  return lines;
}

/**
 * Show the prompt and resolve with the user's choice. Never throws
 * — returns 'later' on any error / timeout / non-TTY.
 */
export async function showBootUpdatePrompt(
  input: BootUpdatePromptInput,
): Promise<UpdatePromptChoice> {
  // Test seam — short-circuit before any I/O.
  if (input._testChoice) return input._testChoice;

  const isTTY = input.isTTY ?? Boolean(input.stdin?.isTTY ?? process.stdin.isTTY);
  // Non-interactive stdin → silently default to 'later'. Boot must
  // not hang in CI / piped contexts.
  if (!isTTY) return 'later';

  if (!input.status.updateAvailable || !input.status.latest) return 'later';
  if (input.status.skipped) return 'later';

  // Render the box.
  for (const line of renderBootUpdateBox(input.status, input.plan, input.columns)) {
    input.display.write(line + '\n');
  }

  // A non-installable provenance is informational, not a blocking
  // consent prompt. In particular, never accept `y` when preflight
  // could not prove a writable npm-global target.
  if (!input.plan.installAllowed) return 'unavailable';

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdin = input.stdin ?? process.stdin;
  return await captureSingleKey(stdin, timeoutMs);
}

/**
 * Read ONE keypress from stdin in raw mode. Maps:
 *   - 'y' / 'Y' → 'install'
 *   - 'n' / 'N' → 'skip'
 *   - 'l' / 'L' / Enter / any other key → 'later'
 *   - Timeout                          → 'later'
 *
 * Restores stdin's prior pause/resume + rawMode state so the
 * subsequent REPL prompt isn't broken.
 */
function captureSingleKey(
  stdin:     NodeJS.ReadStream,
  timeoutMs: number,
): Promise<UpdatePromptChoice> {
  return new Promise<UpdatePromptChoice>((resolve) => {
    let done = false;
    const wasRaw = stdin.isRaw === true;
    const wasPaused = stdin.isPaused();
    let timer: NodeJS.Timeout;

    const cleanup = (): void => {
      if (done) return;
      done = true;
      try { stdin.removeListener('data', onData); } catch { /* noop */ }
      try { if (!wasRaw && stdin.setRawMode) stdin.setRawMode(false); } catch { /* noop */ }
      if (wasPaused) try { stdin.pause(); } catch { /* noop */ }
      clearTimeout(timer);
    };

    const onData = (chunk: Buffer | string): void => {
      const raw = chunk.toString();
      const ch = raw.length > 0 ? raw[0].toLowerCase() : '';
      let choice: UpdatePromptChoice;
      if (ch === 'y')        choice = 'install';
      else if (ch === 'n')   choice = 'skip';
      else                   choice = 'later';
      cleanup();
      resolve(choice);
    };

    try {
      if (stdin.setRawMode && !wasRaw) stdin.setRawMode(true);
      if (wasPaused) stdin.resume();
      stdin.on('data', onData);
    } catch {
      cleanup();
      resolve('later');
      return;
    }

    timer = setTimeout(() => {
      cleanup();
      resolve('later');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}
