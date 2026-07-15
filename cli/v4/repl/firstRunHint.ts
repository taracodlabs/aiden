/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/repl/firstRunHint.ts — ONB1 slice 9.
 *
 * One-time hint banner shown immediately below the standard boot
 * card (status pills + source annotation) on the very first REPL
 * session after a successful setup. Single muted line:
 *
 *     Tip: try /walkthrough for a 60-second tour of what Aiden can do
 *
 * Dismissal is durable — once the user sends a first message OR
 * runs `/dismiss`, we write a marker at `<paths.root>/.first-run-shown`
 * so subsequent boots never re-show the line. The marker is plain
 * text (single line: ISO timestamp) so an operator can `rm` it to
 * see the hint again without other side effects.
 *
 * The hint is also suppressed on non-TTY callers (no point hinting
 * at scripted callers that don't have a `/walkthrough` slash to run).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { c, italic } from '../../../core/v4/ui/theme';
import type { AidenPaths } from '../../../core/v4/paths';
import { fitStartupLine } from '../startupDashboard';

const MARKER_NAME = '.first-run-shown';

export interface FirstRunHintOptions {
  paths: AidenPaths;
  out?: NodeJS.WriteStream;
}

function markerPath(paths: AidenPaths): string {
  return path.join(paths.root, MARKER_NAME);
}

/**
 * Returns true if the marker exists — caller should NOT render the
 * hint. Returns false on any error (e.g. marker missing, fs read
 * fails) so a corrupt state is treated as "show again" rather than
 * silently hiding the hint forever.
 */
export async function isFirstRunHintShown(paths: AidenPaths): Promise<boolean> {
  try {
    await fs.access(markerPath(paths));
    return true;
  } catch {
    return false;
  }
}

/**
 * Render the hint line if it hasn't been dismissed yet. Returns
 * true when the line was painted (so the caller can adjust spacing).
 * Mark-on-render: we write the dismissed-marker IMMEDIATELY after
 * painting so the hint shows exactly once even if the user Ctrl+Cs
 * before sending a first message. The "missed write" branch falls
 * through silently — on the next boot the user may see the hint
 * one more time, which is benign degradation.
 */
export async function renderFirstRunHint(opts: FirstRunHintOptions): Promise<boolean> {
  const out = opts.out ?? process.stdout;
  if (!out.isTTY) return false;
  if (await isFirstRunHintShown(opts.paths)) return false;

  const columns = typeof out.columns === 'number' && out.columns > 0 ? out.columns : 80;
  const line = columns >= 64
    ? '  ' + c.muted('Try asking: ') + italic(c.muted('Read this folder and explain what this project does.'))
    : '  ' + c.muted('Try asking: ') + c.accent('Explain this folder');
  out.write(fitStartupLine(line, Math.max(1, columns - 2)) + '\n\n');
  await markFirstRunHintDismissed(opts.paths);
  return true;
}

/**
 * Write the dismissed-marker. Idempotent. Caller should fire this
 * once the user has either (a) sent their first message, or (b)
 * invoked /dismiss. Failures are swallowed — a missed write just
 * means the hint shows once more on the next boot, which is a
 * benign degradation.
 */
export async function markFirstRunHintDismissed(paths: AidenPaths): Promise<void> {
  try {
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(markerPath(paths), new Date().toISOString() + '\n', { encoding: 'utf8' });
  } catch {
    // best-effort — see jsdoc
  }
}

/**
 * Test / debug helper. Removes the marker so the hint shows again on
 * the next boot. Returns true when a marker was actually removed.
 */
export async function resetFirstRunHint(paths: AidenPaths): Promise<boolean> {
  try {
    await fs.unlink(markerPath(paths));
    return true;
  } catch {
    return false;
  }
}
