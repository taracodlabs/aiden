/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/onboarding/disclaimer.ts — ONB1 slice 3.
 *
 * First screen of the redesigned first-run experience. Renders the
 * framed AIDEN banner + tagline + credits + a single-paragraph
 * disclaimer paragraph + Y/n prompt. Default Y. Typing 'n' or 'N'
 * exits with a friendly goodbye line; ENTER (or 'y'/'Y') advances.
 *
 * Caller is responsible for branching on the returned `ok` boolean.
 * This function NEVER calls process.exit — keeps it testable, and
 * the parent (aidenCLI) controls the exit code centrally.
 *
 * TTY guard: non-TTY callers (systemd / launchd / CI / pipe) return
 * `{ ok: true, skipped: true }` immediately so the wider boot path
 * falls through to explore-mode wiring as today.
 */

import * as readline from 'node:readline';

import { renderBanner } from '../../../core/v4/ui/banner';
import { AIDEN_BOOT_MIN_COLUMNS } from '../../../core/v4/ui/identity';
import { c, separator, termWidth } from '../../../core/v4/ui/theme';
import { VERSION } from '../../../core/version';
import { renderStartupWidthRequirement } from '../startupDashboard';
import { waitForStartupWidth } from '../startupWidthGate';

export interface DisclaimerResult {
  /** True when the user accepted (or stdin wasn't a TTY). */
  ok: boolean;
  /** True when we couldn't prompt because stdin lacked a TTY. */
  skipped?: boolean;
  /** Free-text reason when the user declined. */
  reason?: string;
}

export interface DisclaimerOptions {
  /** Override stdout — tests inject a sink. Default process.stdout. */
  out?: NodeJS.WriteStream;
  /** Override stdin — tests inject a fake. Default process.stdin. */
  in?:  NodeJS.ReadStream;
  /** Override the rendered version label. Default core/version.VERSION. */
  version?: string;
}

// v4.8.0 Slice 10c — replaced the single-paragraph prose with two
// scannable bullet lists (capability + acknowledgments). Legal terms
// surfaced as a checklist instead of buried inside prose.
const DISCLAIMER_HEAD =
  'Aiden is an autonomous AI engine that runs on your machine. Aiden can:';
const CAPABILITY_BULLETS = [
  'Read, write, and modify files on your computer',
  'Execute shell commands and run code',
  'Browse the web and interact with online services',
  'Connect to AI providers using YOUR API keys (BYOK)',
  'Generate and execute new skills based on your prompts',
];
const ACK_HEAD = 'By continuing, you acknowledge:';
const ACK_BULLETS = [
  'Aiden operates on your behalf with full local-system access',
  'You are responsible for outcomes of commands you approve',
  'Open source under AGPL-3.0 — read the code at github.com/taracodlabs/aiden',
  'This is beta software, built solo, still rough in spots',
];

/**
 * Word-wrap `text` to `width` columns. Preserves single spaces; does
 * not handle ANSI codes (callers pass plain text here).
 */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
      continue;
    }
    if (current.length + 1 + w.length > width) {
      lines.push(current);
      current = w;
    } else {
      current += ' ' + w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Clear the screen if stdout is a TTY. No-op otherwise.
 */
function clearScreen(out: NodeJS.WriteStream): void {
  if (!out.isTTY) return;
  out.write('\x1b[2J\x1b[H');
}

/**
 * Render the disclaimer body — v4.8.0 Slice 10c: banner + framed-panel
 * capability list + acknowledgments. Orange `▎` bar on every line of
 * the panel matches the rest of v4.8.0 chrome. `▸` bullets keep
 * capability/ack items scannable rather than buried in prose.
 */
function renderDisclaimerBody(version: string): string {
  const w = termWidth();
  const innerW = Math.min(w - 4, 70);
  const body: string[] = [];
  body.push(renderBanner({ version, width: w, framed: false }));

  // Slice 10c framed-panel chrome. Orange bar at col 2; content + 2
  // inner spaces; muted `─` divider between sections.
  // v4.8.0 Slice 11c — `▎` swapped for `│` (U+2502); same swap as
  // glyphs.panel.bar in the design tokens.
  const bar = c.primary('│');
  const divider = c.muted('─'.repeat(innerW - 2));
  const line = (s: string) => `  ${bar}  ${s}\n`;

  body.push(line(c.text(DISCLAIMER_HEAD)));
  body.push(line(''));
  for (const item of CAPABILITY_BULLETS) {
    body.push(line(c.muted('▸ ') + c.text(item)));
  }
  body.push(line(''));
  body.push(line(divider));
  body.push(line(''));
  body.push(line(c.text(ACK_HEAD)));
  body.push(line(''));
  for (const item of ACK_BULLETS) {
    body.push(line(c.muted('▸ ') + c.text(item)));
  }
  body.push('\n');
  return body.join('');
}

/**
 * Read a single line from stdin. Resolves with the trimmed input.
 * Rejects on close-without-input (typical when stdin is closed under us).
 */
function promptYesNo(
  inStream: NodeJS.ReadStream,
  outStream: NodeJS.WriteStream,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: inStream, output: outStream });
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer ?? '').trim());
    });
  });
}

/**
 * Show the disclaimer screen and collect Y/n. ENTER == accept; 'n'/'N'
 * == decline. Anything else also counts as accept (matches Claude
 * Code / Codex defaults — users hammer enter and expect to advance).
 */
export async function showDisclaimer(
  opts: DisclaimerOptions = {},
): Promise<DisclaimerResult> {
  const out = opts.out ?? process.stdout;
  const inStream = opts.in ?? process.stdin;
  const version = opts.version ?? VERSION;

  // Non-TTY: skip the prompt entirely. Caller falls through to whatever
  // non-interactive path is appropriate (explore mode in aidenCLI today).
  if (!out.isTTY || !inStream.isTTY) {
    return { ok: true, skipped: true };
  }

  clearScreen(out);
  await waitForStartupWidth({
    out,
    minimum: AIDEN_BOOT_MIN_COLUMNS,
    currentColumns: () => Number(out.columns) || termWidth(),
    requirementLines: renderStartupWidthRequirement(Number(out.columns) || termWidth()),
  });
  out.write(renderDisclaimerBody(version));

  const question =
    '  ' + c.accent('Continue?') + ' ' + c.muted('[Y/n] ');

  const answer = await promptYesNo(inStream, out, question);
  if (answer === 'n' || answer === 'N' || answer.toLowerCase() === 'no') {
    out.write('\n  ' + c.muted('No problem — run `aiden` anytime to come back.') + '\n\n');
    return { ok: false, reason: 'user-declined' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Direct invocation for visual smoke test:
//   npx ts-node cli/v4/onboarding/disclaimer.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  showDisclaimer().then((r) => {
    process.stdout.write(`\n[result] ${JSON.stringify(r)}\n`);
    process.exit(r.ok ? 0 : 1);
  });
}
