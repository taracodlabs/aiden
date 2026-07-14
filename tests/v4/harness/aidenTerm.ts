/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/harness/aidenTerm.ts — v4.10 Slice 10.4.
 *
 * Real-PTY test harness for Aiden's REPL. Spawns the CLI in a
 * pseudo-terminal, captures the raw byte stream the user would see,
 * and exposes assertion primitives that operate on the captured
 * output OR a stripped plaintext view.
 *
 * WHY: cursor positioning, prompt redraws, streaming refresh, and
 * status-bar lifecycle are all phenomena that only manifest under
 * a real TTY. Vitest tests that capture string output (no PTY) miss
 * the @inquirer/core screen-manager, the streamPartial rerender
 * eraser, the indicator's walk-up-erase, and every other ANSI
 * dance Aiden does. v4.9.6 Bug D + Slice 10.3 live-bar both shipped
 * inert because their tests asserted string content, not terminal
 * behavior.
 *
 * Cross-platform: node-pty 1.x ships prebuilds for Win/Lin/Mac on
 * Node 18+ and uses ConPTY on Windows 10+. No manual VS Build
 * Tools required on the supported configurations.
 *
 * Scope-locked for Slice 10.4: minimal primitives only. Future
 * slices add richer cursor-position assertions, snapshot diffing,
 * frame-window snapshots, etc. Slice 10.4 deliverable: ONE
 * proof-of-concept smoke test (see aidenTermSmoke.test.ts).
 */

import * as pty from 'node-pty';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { COMPOSER_READY_TOKEN } from '../../../cli/v4/composerReadiness';

export interface SpawnAidenTermOptions {
  /** Columns. Default 120 — wide enough for full-density status footer. */
  cols?: number;
  /** Rows. Default 30. */
  rows?: number;
  /** Working directory the child runs from. Default: a fresh tmpdir. */
  cwd?: string;
  /**
   * AIDEN_HOME for the child — points at the per-test isolated
   * aiden state directory. If omitted, a fresh tmpdir is created.
   */
  aidenHome?: string;
  /**
   * Extra env vars. Merged over process.env + harness defaults.
   * Common patterns:
   *   - CUSTOM_BASE_URL=http://127.0.0.1:<port> for mock providers
   *   - CUSTOM_API_KEY=test
   */
  env?: Record<string, string>;
  /**
   * Path to the aiden dist entry. Defaults to the repo's
   * dist/cli/v4/aidenCLI.js relative to the test harness location.
   * Tests can override to point at a fresh tsx invocation if dist
   * is stale.
   */
  entry?: string;
}

export interface AidenTerm {
  /** Raw byte stream as the user would see — includes ANSI escapes. */
  raw(): string;
  /** ANSI-stripped plaintext view. Strips CSI sequences, SGR, cursor moves. */
  plain(): string;
  /** Send keystrokes verbatim. No `\r` appended; use `typeLine` for that. */
  type(text: string): void;
  /** Send keystrokes + carriage return (Enter). */
  typeLine(text: string): void;
  /** Send a single control char by name. Limited subset. */
  ctrl(key: 'c' | 'd'): void;
  /**
   * Wait until `predicate(plain)` returns true OR the timeout
   * elapses. Polls at `pollMs` intervals. Returns the matched
   * plaintext when found; throws on timeout with a snapshot of
   * the current buffer.
   */
  waitFor(
    predicate: (plain: string) => boolean,
    opts?: { timeoutMs?: number; pollMs?: number; label?: string },
  ): Promise<string>;
  /** Wait for the standard `▲ ` prompt to appear (boot complete). */
  waitForPrompt(opts?: { timeoutMs?: number }): Promise<void>;
  /** Wait for the child to exit. */
  waitForExit(opts?: { timeoutMs?: number }): Promise<number>;
  /** Resize the pty. */
  resize(cols: number, rows: number): void;
  /** Send `/quit` + Enter and wait for clean exit. */
  quit(opts?: { timeoutMs?: number }): Promise<number>;
  /** Force-kill the child. Best-effort. */
  kill(): void;
  /** True while the child is alive. */
  isAlive(): boolean;
  /** Underlying process pid (diagnostic). */
  pid(): number;
}

/**
 * Strip CSI / SGR / cursor-move sequences from a captured buffer.
 * Mirrors Display.stripAnsi but lives in the harness so the test
 * surface has no dependency on the production module.
 */
function stripAnsi(s: string): string {
  // Match CSI sequences (ESC [ params ... final-byte) and OSC + ST.
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')   // OSC sequences
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')             // CSI sequences
    .replace(/\x1b[=>]/g, '')                            // misc 7-bit
    .replace(/\r/g, '');                                  // CR (the cursor returns home)
}

/**
 * Default entry point: dist/cli/v4/aidenCLI.js resolved from the
 * harness location. Production tests run after `npm run build`.
 * If dist is stale, tests can override `entry` to point at tsx +
 * source.
 */
function defaultEntry(): string {
  // tests/v4/harness/aidenTerm.ts → ../../../dist/cli/v4/aidenCLI.js
  return path.resolve(__dirname, '../../../dist/cli/v4/aidenCLI.js');
}

export async function spawnAidenTerm(
  opts: SpawnAidenTermOptions = {},
): Promise<AidenTerm> {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 30;
  const cwd = opts.cwd ?? await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-term-cwd-'));
  const aidenHome = opts.aidenHome ?? await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-term-home-'));
  const entry = opts.entry ?? defaultEntry();

  // This harness exercises the interactive REPL, not first-run onboarding.
  // Keep every PTY suite on the same deterministic boot boundary even when a
  // caller supplies a freshly-created home directory.
  await fs.mkdir(aidenHome, { recursive: true });
  await fs.writeFile(
    path.join(aidenHome, '.onboarding-shown'),
    'pty-harness\n',
    { encoding: 'utf8', flag: 'wx' },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });

  // Verify the entry exists — fail loud rather than spawn a broken child.
  try {
    await fs.access(entry);
  } catch {
    throw new Error(
      `aidenTerm: entry not found at ${entry}. Run \`npm run build\` first, ` +
      `or pass opts.entry pointing at a tsx-invokable source entry.`,
    );
  }

  // Harness defaults: opt out of update-check + Telegram polling so
  // the child boots fast and deterministically. AIDEN_NO_UPDATE_CHECK
  // is the canonical env (see core/v4/update/checkUpdate.ts).
  // Setting TELEGRAM_BOT_TOKEN to empty string prevents the child
  // inheriting a parent-shell token and starting a polling loop
  // that would add 5-30s to /quit teardown.
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    AIDEN_HOME:                aidenHome,
    AIDEN_NO_UPDATE_CHECK:     '1',
    AIDEN_TEST_COMPOSER_READY: '1',
    TELEGRAM_BOT_TOKEN:        '',
    NO_COLOR:                  '0',     // keep ANSI so the harness can see escapes
    FORCE_COLOR:               '1',
    ...(opts.env ?? {}),
  };

  // node-pty spawn — uses ConPTY on Windows 10+, openpty on Unix.
  const child = pty.spawn(
    process.execPath,
    [entry],
    {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: childEnv,
    },
  );

  let buffer = '';
  let exitCode: number | null = null;
  let readinessSeen = 0;
  child.onData((data: string) => {
    buffer += data;
  });
  child.onExit((e: { exitCode: number; signal?: number }) => {
    exitCode = e.exitCode;
  });

  // Sleep helper for polling.
  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

  const waitFor = async (
    predicate: (plain: string) => boolean,
    waitOpts?: { timeoutMs?: number; pollMs?: number; label?: string },
  ): Promise<string> => {
    const timeoutMs = waitOpts?.timeoutMs ?? 10_000;
    const pollMs    = waitOpts?.pollMs    ?? 50;
    const label     = waitOpts?.label     ?? '<unlabeled predicate>';
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const plain = stripAnsi(buffer);
      if (predicate(plain)) return plain;
      if (exitCode !== null) {
        throw new Error(
          `aidenTerm: child exited (code=${exitCode}) while waiting for "${label}". ` +
          `Last buffer (plain, last 400 chars): ${plain.slice(-400)}`,
        );
      }
      await sleep(pollMs);
    }
    const plainAtTimeout = stripAnsi(buffer);
    throw new Error(
      `aidenTerm: timed out (${timeoutMs}ms) waiting for "${label}". ` +
      `Last buffer (plain, last 400 chars): ${plainAtTimeout.slice(-400)}`,
    );
  };

  const waitForPrompt = async (waitOpts?: { timeoutMs?: number }): Promise<void> => {
    const target = readinessSeen + 1;
    await waitFor(
      () => buffer.split(COMPOSER_READY_TOKEN).length - 1 >= target,
      { ...waitOpts, label: 'composer readiness marker' },
    );
    readinessSeen = target;
  };

  const waitForExit = async (waitOpts?: { timeoutMs?: number }): Promise<number> => {
    const timeoutMs = waitOpts?.timeoutMs ?? 10_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (exitCode !== null) return exitCode;
      await sleep(50);
    }
    throw new Error(`aidenTerm: child did not exit within ${timeoutMs}ms`);
  };

  return {
    raw:   () => buffer,
    plain: () => stripAnsi(buffer),
    type:  (text: string) => child.write(text),
    typeLine: (text: string) => child.write(text + '\r'),
    ctrl: (key) => {
      if (key === 'c') child.write('\x03');
      else if (key === 'd') child.write('\x04');
    },
    waitFor,
    waitForPrompt,
    waitForExit,
    resize: (c, r) => child.resize(c, r),
    quit: async (waitOpts?: { timeoutMs?: number }) => {
      child.write('/quit\r');
      return await waitForExit(waitOpts);
    },
    kill: () => {
      try { child.kill(); } catch { /* best-effort */ }
    },
    isAlive: () => exitCode === null,
    pid:     () => child.pid,
  };
}
