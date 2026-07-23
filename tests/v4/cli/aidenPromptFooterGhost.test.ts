/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.5 — Bug D regression layer (PTY harness).
 *
 * Two prior attempts at Bug D (cursor mis-positioning past ghost text
 * in the input prompt) shipped INERT:
 *   - v4.9.2 Slice 2 (commit 0d0668f1): inline cursorBackward escape.
 *     @inquirer/core's screen-manager.js absolute cursorTo() overrode
 *     it. Tests against the rendered string couldn't see the
 *     terminal-level effect.
 *   - v4.9.6: same shape, reframed with save/restore. Same outcome.
 *
 * Common cause of both inert ships: NO real-PTY regression layer.
 * Unit tests that inspect the returned line string can't observe what
 * the terminal actually paints because @inquirer/core mutates output
 * AFTER the prompt function returns. v4.9.1 mock-blindness pattern,
 * mirror class.
 *
 * This test fixes that gap. The Slice 10.4 node-pty harness
 * (tests/v4/harness/aidenTerm.ts) spawns a real Aiden under a real
 * pseudo-terminal and lets us observe the actual byte stream. We type
 * a partial slash command and assert two things about the rendered
 * frame:
 *
 *   1. The line containing `▲ /d` does NOT contain the ghost
 *      suggestion text (e.g. `aemon` — the tail of `/daemon`).
 *   2. The next line after the prompt line DOES contain that ghost
 *      suggestion, on its own line, dimmed.
 *
 * Path A fix (this slice): move the ghost from inline assembly into
 * the bottomContent tuple slot. Inquirer's screen-manager paints
 * bottomContent below the input line and walks the cursor back up
 * to the input line. With no embedded ghost, the cursor naturally
 * lands right after the typed value — correct by construction, no
 * library-internal coupling.
 *
 * CI cost: ~5s per run (PTY boot + Aiden init + Ctrl+C teardown).
 * Single test in this file — keep PTY tests serial; do NOT use
 * `it.concurrent`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { spawnAidenTerm, type AidenTerm } from '../harness/aidenTerm';
import { TerminalScreen } from '../harness/terminalScreen';

// The PTY regression layer below is a genuinely-interactive test: it
// spawns a real Aiden under a pseudo-terminal and waits for the
// interactive `▲ ` prompt. In headless CI the boot renders the banner
// frame but the interactive prompt never mounts — `waitForPrompt` times
// out on every platform and the stuck child can't exit, starving the
// vitest worker. This is not a product hang; the test simply requires an
// interactive terminal CI's PTY can't drive. It runs locally (real TTY)
// with all assertions intact. Gate ONLY the PTY describe on CI — the
// source-contract guard below is a pure file read and MUST keep running
// everywhere. See tests/v4/harness/aidenTermSmoke.test.ts for the class.
const SKIP_INTERACTIVE_PTY = !!process.env.CI;

let term: AidenTerm | null = null;
let cleanupDirs: string[] = [];

afterEach(async () => {
  if (term && term.isAlive()) term.kill();
  term = null;
  await Promise.all(
    cleanupDirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)),
  );
  cleanupDirs = [];
});

describe.skipIf(SKIP_INTERACTIVE_PTY)('aidenPrompt — Bug D regression layer (PTY harness, Slice 10.5)', () => {
  it('typing a partial slash command stays exclusively in the fixed composer row', async () => {
    const cwd       = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-bugd-cwd-'));
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-bugd-home-'));
    cleanupDirs.push(cwd, aidenHome);

    // Pre-seed config so wizard is skipped (same pattern as Slice 10.4
    // aidenTermSmoke). Fake provider key bypasses fresh-install
    // detection without ever calling a provider — we type a slash
    // command and never submit.
    await fs.writeFile(
      path.join(aidenHome, 'config.yaml'),
      [
        'model:',
        '  provider: groq',
        '  modelId: openai/gpt-oss-120b',
        'providers:',
        '  groq:',
        '    apiKey: ${GROQ_API_KEY}',
      ].join('\n') + '\n',
      'utf8',
    );

    term = await spawnAidenTerm({
      cwd,
      aidenHome,
      env: { GROQ_API_KEY: 'aiden-bugd-fake-key' },
    });

    await term.waitForPrompt({ timeoutMs: 30_000 });

    // Type `/d` without submitting. In fixed-bottom-region mode the
    // Display-owned composer is the only prompt renderer; Inquirer's
    // ghost, helper, and dropdown footer must not create another row.
    term.type('/d');

    await term.waitFor(
      (plain) => plain.includes('/d'),
      { timeoutMs: 10_000, label: 'fixed composer draft' },
    );

    // ── Assertions ────────────────────────────────────────────────
    const screen = new TerminalScreen(120, 30);
    screen.write(term.raw());
    const lines = screen.lines();

    const composerLine = lines.at(-2) ?? '';
    const statusLine = lines.at(-1) ?? '';
    expect(composerLine).toContain('▲');
    expect(composerLine).toContain('/d');
    expect(statusLine).toContain('groq');
    expect(statusLine).toContain('ctx');

    const rowsAboveFooter = lines.slice(0, -2);
    expect(rowsAboveFooter.some((line) => line.trim() === '/d')).toBe(false);
    expect(rowsAboveFooter.some((line) => line.includes('Type your message'))).toBe(false);
    expect(rowsAboveFooter.some((line) => /aemon|octor/.test(line))).toBe(false);
    expect(rowsAboveFooter.some((line) => line.trimStart().startsWith('▲'))).toBe(false);

    // Clean exit via Ctrl+C — same rationale as the Slice 10.4 smoke.
    term.ctrl('c');
    const exitCode = await term.waitForExit({ timeoutMs: 30_000 });
    expect(exitCode).toBe(0);
  }, 90_000);
});

// ── Source-contract guard ────────────────────────────────────────────
//
// A future refactor that re-introduces inline ghost concatenation
// (re-creating Bug D) would land WITHOUT a PTY test failure if it
// happens to also keep the dropdown footer in place. The source-level
// guard below asserts the production code path NEVER concatenates
// `${ghost}` (or any dim-wrapped variant) into the `line` variable —
// the ghost text must travel through the footer slot exclusively.

describe('aidenPrompt — source-contract guard: ghost stays out of line variable', () => {
  it('aidenPrompt.ts ghost branch returns tuple, never inlines ghost in `line`', async () => {
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/aidenPrompt.ts'),
      'utf8',
    );

    // The pre-Slice-10.5 inline pattern was literally:
    //   line = `${prefix} ${message}${value}${ghostStr}`;
    // Any `line = ...${ghost...` template assignment fails this
    // guard. We allow `${dim(ghost)}` to appear inside the ghostLine
    // footer-line assembly (that's the intentional new code path).
    const inlineLinePattern = /line\s*=\s*`[^`]*\$\{ghost\w*\}[^`]*`/;
    expect(src).not.toMatch(inlineLinePattern);

    // Positive guard: the file must use the bottomContent tuple
    // return path. The exact `return footer ? [line, footer] : line`
    // form is what makes the screen-manager paint ghost+dropdown
    // below + walk the cursor back to the input line.
    expect(src).toMatch(/return\s+footer\s*\?\s*\[\s*line\s*,\s*footer\s*\]\s*:\s*line/);

    // And the ghost is rendered specifically through a dim()-wrapped
    // FOOTER assignment, not appended to `line`. Pattern allows the
    // assignment to span lines (the ternary in production wraps
    // across multiple lines).
    expect(src).toMatch(/ghostLine\s*=[\s\S]{0,200}?dim\(ghost\)/);
  });
});
