/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 composer polish:
 *   Issue 1 — the BUSY hint is width-safe: full on a wide terminal, and on a
 *   narrow one it keeps the FRONT ("Enter → …") with an ellipsis, never the
 *   wrapped tail ("…change · Ctrl+C stop") the single-line repaint used to show.
 *   Issue 2 — the persistent IDLE hint shows only when idle and nothing else
 *   owns the footer (no ghost/dropdown).
 */
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { shouldShowIdleHint } from '../../../cli/v4/aidenPrompt';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
function makeDisplay(columns: number) {
  const chunks: string[] = [];
  const out = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } }) as Writable & { isTTY?: boolean; columns?: number };
  out.isTTY = true; out.columns = columns;
  return { d: new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out as unknown as NodeJS.WriteStream }), chunks };
}

describe('busy hint — width-safe (Issue 1)', () => {
  const HINT = 'Enter → steer · /busy to change · Ctrl+C stop';

  it('a WIDE terminal shows the FULL hint (no truncation)', () => {
    const { d, chunks } = makeDisplay(100);
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.setBusyHint(HINT);
    expect(stripAnsi(chunks.join(''))).toContain(HINT);   // complete, end-to-end
    ind.stop();
  });

  it('a NARROW terminal keeps the FRONT with an ellipsis — never the tail-only garbage', () => {
    const { d, chunks } = makeDisplay(40);
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.setBusyHint(HINT);
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('Enter →');        // the important front is kept
    expect(painted).toContain('…');              // front-fit ellipsis
    expect(painted).not.toContain('Ctrl+C stop'); // the TAIL is dropped, not the front
    ind.stop();
  });

  it('long typed text keeps the CURSOR END (tail-fit), unlike the hint', () => {
    const { d, chunks } = makeDisplay(80);   // avail 50; label + 48-char text overflows → tail-fit
    const ind = d.activityIndicator('thinking');
    chunks.length = 0;
    d.setComposer('a very long message the user is typing right now', 'redirect');
    const painted = stripAnsi(chunks.join(''));
    expect(painted).toContain('…');              // ellipsis at the FRONT (tail-fit for typed text)
    expect(painted).toContain('right now');      // most-recent chars (cursor end) kept
    ind.stop();
  });
});

describe('shouldShowIdleHint — persistent idle hint (Issue 2)', () => {
  const HINT = 'Type your message · /help · /mode';
  it('shows when idle, a hint is set, and no ghost/dropdown owns the footer', () => {
    expect(shouldShowIdleHint(false, HINT, 'idle')).toBe(true);
  });
  it('hidden when a ghost/dropdown already owns the footer', () => {
    expect(shouldShowIdleHint(true, HINT, 'idle')).toBe(false);
  });
  it('hidden when not idle (submitting/done)', () => {
    expect(shouldShowIdleHint(false, HINT, 'done')).toBe(false);
  });
  it('hidden when no hint is configured', () => {
    expect(shouldShowIdleHint(false, undefined, 'idle')).toBe(false);
    expect(shouldShowIdleHint(false, '', 'idle')).toBe(false);
  });
});
