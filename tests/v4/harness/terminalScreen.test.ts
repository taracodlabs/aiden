/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { describe, expect, it } from 'vitest';

import { TerminalScreen } from './terminalScreen';

const separator = '─'.repeat(59);
const divider = '─'.repeat(21);
const footer = '◆custom_openai/custom-default│◉0%│✓│0ms';

function composer(): string {
  return [
    separator,
    '▲ You',
    divider,
    '',
    separator,
    footer,
  ].join('\r\n');
}

describe('TerminalScreen Windows resize semantics', () => {
  it('distinguishes a durable prompt from one active composer', () => {
    const screen = new TerminalScreen(60, 18, { retainResizeHistory: true });
    screen.write([
      '  ▲ You',
      '  COMPLETED PROMPT',
      '',
      composer(),
    ].join('\r\n'));

    expect(screen.snapshot().match(/▲ You/gu)).toHaveLength(2);
    expect(screen.activeComposerSurfaces()).toHaveLength(1);
  });

  it('detects two active composer surfaces', () => {
    const screen = new TerminalScreen(60, 18, { retainResizeHistory: true });
    screen.write([composer(), '', composer()].join('\r\n'));

    expect(screen.activeComposerSurfaces()).toHaveLength(2);
  });

  it('retains durable transcript while discarding an obsolete host composer snapshot', () => {
    const screen = new TerminalScreen(60, 18, { retainResizeHistory: true });
    screen.write([
      '  ▲ You',
      '  DURABLE PROMPT',
      '  │ Aiden',
      '  DURABLE ANSWER',
      '',
      composer(),
    ].join('\r\n'));
    screen.prepareHostResize(60, 18);
    screen.write([
      '\x1b[H',
      '  ▲ You',
      '  DURABLE PROMPT',
      '  │ Aiden',
      '  DURABLE ANSWER',
      '',
      composer(),
    ].join('\r\n'));
    screen.completeHostResizeSnapshot();

    expect(screen.discardHostSnapshotComposer()).toBe(true);
    expect(screen.activeComposerSurfaces()).toHaveLength(0);
    expect(screen.reviewableSnapshot()).toContain('DURABLE PROMPT');
    expect(screen.reviewableSnapshot()).toContain('DURABLE ANSWER');
    expect(screen.snapshot()).not.toContain(footer);
  });

  it('leaves durable transcript untouched when no volatile footer is present', () => {
    const screen = new TerminalScreen(60, 18, { retainResizeHistory: true });
    screen.write('  ▲ You\r\n  DURABLE PROMPT');

    expect(screen.discardHostSnapshotComposer()).toBe(false);
    expect(screen.snapshot()).toContain('DURABLE PROMPT');
  });

  it('does not append host-snapshot line feeds to durable scrollback', () => {
    const screen = new TerminalScreen(60, 6, { retainResizeHistory: true });
    screen.write('DURABLE HISTORY');
    const before = screen.scrollbackSnapshot();

    screen.prepareHostResize(60, 6);
    screen.write(`\x1b[H${Array.from({ length: 6 }, () => '').join('\r\n')}\r\n`);
    screen.completeHostResizeSnapshot();

    expect(screen.scrollbackSnapshot()).toBe(before);
    expect(screen.reviewableSnapshot()).toContain('DURABLE HISTORY');
  });

  it('scrolls only the transcript region when the volatile surface grows', () => {
    const screen = new TerminalScreen(40, 10, { retainResizeHistory: true });
    screen.write('line one\r\nline two\r\nline three');
    screen.write('\x1b[1;7r\x1b[2S');
    screen.write('\x1b[1;1Htranscript\r\n');

    expect(screen.snapshot()).not.toContain('line one');
    expect(screen.snapshot()).toContain('transcript');
    expect(screen.scrollbackSnapshot()).not.toContain('line one');
  });
});
