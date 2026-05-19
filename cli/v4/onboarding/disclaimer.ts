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
import { c, separator, termWidth } from '../../../core/v4/ui/theme';
import { VERSION } from '../../../core/version';

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

const DISCLAIMER_PARA =
  'Aiden is a semi-autonomous AI agent that can touch your files, ' +
  'browser, and shell. Open source — read the code if you want. ' +
  'Started as a hobby project, built solo, still rough in spots.';

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
 * Render the disclaimer body — banner + separator + wrapped paragraph.
 * Pure renderer; caller owns the write.
 */
function renderDisclaimerBody(version: string): string {
  const w = termWidth();
  const body: string[] = [];
  body.push(renderBanner({ version }));
  body.push('  ' + separator(Math.min(w - 4, 64)) + '\n');
  body.push('\n');
  const indent = '  ';
  for (const line of wrap(DISCLAIMER_PARA, Math.min(w - 4, 70))) {
    body.push(indent + c.text(line) + '\n');
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
