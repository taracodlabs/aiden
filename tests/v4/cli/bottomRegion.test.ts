/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { BottomRegion, renderBottomSurface } from '../../../cli/v4/composerLane';
import { primeFrameAsync } from '../../../cli/v4/display/frame';
import { TerminalScreen } from '../harness/terminalScreen';

class ScreenStream extends Writable {
  isTTY = true;
  columns: number;
  rows: number;
  readonly writes: string[] = [];

  constructor(
    readonly screen: TerminalScreen,
    columns: number,
    rows: number,
  ) {
    super({
      write: (chunk, _encoding, callback) => {
        this.writes.push(chunk.toString());
        screen.write(chunk);
        callback();
      },
    });
    this.columns = columns;
    this.rows = rows;
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.screen.resize(columns, rows);
    this.emit('resize');
  }
}

describe('responsive composer semantic colour projection', () => {
  it('keeps prompt label and draft on separate cyan tokens without colouring the footer', () => {
    const plain = renderBottomSurface(18, 60, { draft: 'draft text', mode: 'idle' }, '◆ provider/model │ ◉ 0% │ T │ 0s');
    const styled = renderBottomSurface(18, 60, { draft: 'draft text', mode: 'idle' }, '◆ provider/model │ ◉ 0% │ T │ 0s', {
      brand: (value) => `BRAND(${value})`,
      muted: (value) => `MUTED(${value})`,
      prompt: (value) => `PROMPT(${value})`,
      promptContent: (value) => `CONTENT(${value})`,
      unicode: true,
    });
    expect(styled.lines.some((line) => line.includes('PROMPT(▲ You)'))).toBe(true);
    expect(styled.lines.some((line) => line.includes('CONTENT(draft text)'))).toBe(true);
    expect(styled.lines.at(-1)).toContain('provider/model');
    expect(styled.lines.at(-1)).not.toContain('CONTENT(');
    expect(styled.lines).toHaveLength(plain.lines.length);
    expect(styled.laneRows).toBe(plain.laneRows);
  });
});

const previousLaneSetting = process.env.AIDEN_COMPOSER_LANE;

it('applies the active theme to the borderless composer hierarchy without changing geometry', () => {
  const renderStyled = renderBottomSurface as unknown as (...args: unknown[]) => ReturnType<typeof renderBottomSurface>;
  const styled = renderStyled(
    24,
    80,
    { draft: 'hello', mode: 'idle' },
    '◆ provider · model',
    {
      brand: (value: string) => `\x1b[31m${value}\x1b[39m`,
      muted: (value: string) => `\x1b[90m${value}\x1b[39m`,
    },
  );
  const text = styled.lines.join('\n');
  expect(text).toContain('\x1b[31m▲ You\x1b[39m');
  expect(text).toContain(`\x1b[90m${'─'.repeat(79)}\x1b[39m`);
  expect(text).toContain(`\x1b[90m${'─'.repeat(21)}\x1b[39m`);
  expect(styled.cursorCol).toBe(6);
});

it('renders the borderless composer hierarchy with the draft at terminal column one', () => {
  const surface = renderBottomSurface(
    18,
    44,
    {
      draft: 'Draft begins here and wraps naturally across the available terminal width.',
      mode: 'idle',
      cursorIndex: 5,
    },
    '◆ provider/model │ context │ phase │ timer',
    { brand: (value) => value, muted: (value) => value, unicode: true },
  );

  expect(surface.lines[0]).toBe('─'.repeat(43));
  expect(surface.lines[1]).toBe('▲ You');
  expect(surface.lines[2]).toBe('─'.repeat(21));
  expect(surface.lines[3]?.startsWith('Draft')).toBe(true);
  expect(surface.lines[3]?.[0]).toBe('D');
  expect(surface.lines.slice(3, -2).every((line) => line.length <= 43)).toBe(true);
  expect(surface.lines.slice(3, -2).join('')).toBe(
    'Draft begins here and wraps naturally across the available terminal width.',
  );
  expect(surface.lines.at(-2)).toBe('─'.repeat(43));
  expect(surface.lines.at(-1)).toContain('◆ provider/model');
  expect(surface.lines.join('\n')).not.toMatch(/[╭╮╰╯│]\s*Draft/u);
  expect(surface.cursorCol).toBe(6);
});

afterEach(() => {
  if (previousLaneSetting === undefined) delete process.env.AIDEN_COMPOSER_LANE;
  else process.env.AIDEN_COMPOSER_LANE = previousLaneSetting;
});

function createDisplay(columns: number, rows = 18): {
  display: Display;
  screen: TerminalScreen;
  stream: ScreenStream;
} {
  const screen = new TerminalScreen(columns, rows, { retainResizeHistory: true });
  const stream = new ScreenStream(screen, columns, rows);
  const display = new Display({
    stdout: stream as unknown as NodeJS.WriteStream,
    skin: new SkinEngine({ forceMono: true }),
  });
  return { display, screen, stream };
}

function composerGeometry(screen: TerminalScreen): {
  topSeparator: number;
  top: number;
  divider: number;
  bottom: number;
  content: string[];
  status: string;
} {
  const lines = screen.lines();
  const top = lines.findLastIndex((line) => line.startsWith('▲ You'));
  const topSeparator = top - 1;
  const divider = top + 1;
  const bottom = lines.length - 2;
  expect(top).toBeGreaterThanOrEqual(0);
  expect(lines[topSeparator]).toMatch(/^─+$/u);
  expect(lines[divider]).toBe('─'.repeat(Math.min(21, lines[divider]?.length ?? 0)));
  expect(bottom).toBeGreaterThan(top);
  expect(lines[bottom]).toMatch(/^─+$/u);
  expect(lines.slice(top + 2, bottom).every((line) => !/^[ \t]/u.test(line))).toBe(true);
  const owned = lines.slice(topSeparator);
  expect(owned.filter((line) => line.startsWith('▲ You'))).toHaveLength(1);
  expect(owned.filter((line) => line === lines[divider])).toHaveLength(1);
  expect(owned.filter((line) => line === lines[topSeparator])).toHaveLength(2);
  return {
    topSeparator,
    top,
    divider,
    bottom,
    content: lines.slice(top + 2, bottom),
    status: lines.at(-1) ?? '',
  };
}

function createRegionHarness(reflowSafe: boolean, columns = 100, rows = 30) {
  const screen = new TerminalScreen(columns, rows, { retainResizeHistory: true });
  let currentColumns = columns;
  let currentRows = rows;
  let resizeListener: (() => void) | null = null;
  const region = new BottomRegion({
    write: (value) => screen.write(value),
    cols: () => currentColumns,
    rows: () => currentRows,
    onResize: (listener) => {
      resizeListener = listener;
      return () => { resizeListener = null; };
    },
    reflowSafe,
  });
  region.activate(
    { draft: '', mode: 'queue' },
    '◆ provider · model │ ◉ context 2k/32k │ ⧖ 4s',
  );
  return {
    region,
    screen,
    resize(nextColumns: number, nextRows: number) {
      currentColumns = nextColumns;
      currentRows = nextRows;
      screen.resize(nextColumns, nextRows);
      resizeListener?.();
    },
  };
}

function expectExclusiveSurface(screen: TerminalScreen, statusNeedle: string): ReturnType<typeof composerGeometry> {
  const geometry = composerGeometry(screen);
  const lines = screen.lines();
  expect(geometry.status).toContain('◆');
  expect(geometry.status).toContain(statusNeedle);
  expect(lines.slice(0, geometry.top).filter((line) => line.includes('▲ You'))).toHaveLength(0);
  expect(lines.slice(0, geometry.top).filter((line) => line.includes(statusNeedle))).toHaveLength(0);
  return geometry;
}

function composerText(content: string[]): string {
  return content.join('');
}

const TEST_TERMINAL_CONTROL = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[78])/gu;

function logicalTerminalLines(output: string): string[] {
  return output
    .replace(TEST_TERMINAL_CONTROL, '')
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''));
}

function compactTranscriptLines(screen: TerminalScreen): string[] {
  return logicalTerminalLines(screen.bufferSnapshot());
}

describe('settled activity row spacing', () => {
  function prepare(columns = 100): ReturnType<typeof createDisplay> {
    delete process.env.AIDEN_COMPOSER_LANE;
    const harness = createDisplay(columns, 24);
    harness.display.setStatusFooter('◆ provider · model │ ◉ context 0/32k │ ⧖ 0ms');
    harness.display.setIdleComposer('', 'Type your message · /help');
    return harness;
  }

  function findSemanticLine(lines: string[], terms: readonly string[]): number {
    const normalizeSemanticText = (value: string): string => value
      .normalize('NFC')
      .replace(/\\/gu, '/')
      .toLowerCase();
    const normalizedTerms = terms.map(normalizeSemanticText);
    return lines.findIndex((line) => {
      const normalizedLine = normalizeSemanticText(line);
      return normalizedTerms.every((term) => {
        if (normalizedLine.includes(term)) return true;
        const basename = term.split('/').at(-1) ?? term;
        const truncatedFragments = normalizedLine.match(/[\p{L}\p{N}_.-]+(?=…)/gu) ?? [];
        return truncatedFragments.some((fragment) => (
          fragment.length >= 6 && basename.startsWith(fragment)
        ));
      });
    });
  }

  function expectAdjacent(
    lines: string[],
    firstTerms: readonly string[],
    secondTerms: readonly string[],
  ): void {
    const first = findSemanticLine(lines, firstTerms);
    const second = findSemanticLine(lines, secondTerms);
    expect(first, lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(second, lines.join('\n')).toBe(first + 1);
    expect(lines.slice(first + 1, second).filter((line) => line.length === '')).toHaveLength(0);
  }

  function expectCompactTransition(
    lines: string[],
    firstTerms: readonly string[],
    secondTerms: readonly string[],
  ): void {
    const first = findSemanticLine(lines, firstTerms);
    const second = findSemanticLine(lines, secondTerms);
    expect(first, lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(second, lines.join('\n')).toBeGreaterThan(first);
    expect(lines.slice(first + 1, second).filter((line) => line.length === ''), lines.join('\n'))
      .toHaveLength(0);
  }

  it.each([
    [
      'LF without colour',
      '┊ ✓ completed src/first.ts\n┊ ✓ completed src/second.ts',
    ],
    [
      'CRLF with ANSI around glyphs and categories',
      '\x1b[90m┊\x1b[0m \x1b[32m✓\x1b[0m \x1b[36mcompleted\x1b[0m src/first.ts\r\n' +
        '\x1b[90m┊\x1b[0m \x1b[32m✓\x1b[0m \x1b[36mcompleted\x1b[0m src/second.ts',
    ],
    [
      'bare CR with OSC metadata and Unicode glyphs',
      '\x1b]9;activity:first\x07┊ ✓ completed src/first.ts\r' +
        '\x1b]9;activity:second\x1b\\┊ ✓ completed src/second.ts',
    ],
  ])('normalises %s without changing activity order', (_label, output) => {
    const lines = logicalTerminalLines(output);
    expectAdjacent(lines, ['completed', 'src/first.ts'], ['completed', 'src/second.ts']);
  });

  it('preserves genuine blank logical rows during normalisation', () => {
    const lines = logicalTerminalLines('┊ ✓ completed first\r\n\r\n┊ ✓ completed second');
    expect(lines).toEqual(['┊ ✓ completed first', '', '┊ ✓ completed second']);
  });

  it.each([
    ['Unix', '/home/runner/work/aiden/aiden/src/narrow-transi…\n'],
    ['Windows', 'C:\\repo\\src\\narrow-transi…\r\n'],
  ])('finds a semantically matching %s path after legitimate narrow truncation', (_label, target) => {
    const lines = logicalTerminalLines(
      `\x1b[90m┊\x1b[0m \x1b[32m✓\x1b[0m completed ${target}`,
    );
    expect(findSemanticLine(lines, ['completed', 'narrow-transition'])).toBe(0);
  });

  it('keeps consecutive completed tool rows adjacent', () => {
    const { display, screen } = prepare();

    display.toolRow('file_read', { path: 'src/first.ts' }).ok(12);
    display.toolRow('file_read', { path: 'src/second.ts' }).ok(14);

    expectAdjacent(
      compactTranscriptLines(screen),
      ['completed', 'first.ts'],
      ['completed', 'second.ts'],
    );
  });

  it('keeps mixed completed and failed rows adjacent', () => {
    const { display, screen } = prepare();
    display.toolRow('file_read', { path: 'src/first.ts' }).ok(12);
    display.toolRow('shell_exec', { command: 'echo failed-row' }).fail(18);

    expectAdjacent(
      compactTranscriptLines(screen),
      ['completed', 'first.ts'],
      ['failed', 'echo failed-row'],
    );
  });

  it('keeps an exact skill row adjacent to the following file row', () => {
    const { display, screen } = prepare();
    display.renderUiEvent('ui_skill_invocation', {
      invocation_id: 'skill-spacing',
      skill_name: 'systematic-debugging',
      reference_name: 'SKILL.md',
      duration_ms: 2,
    });
    display.toolRow('file_read', { path: 'src/after-skill.ts' }).ok(7);

    expectAdjacent(
      compactTranscriptLines(screen),
      ['skill', 'systematic-debugging'],
      ['completed', 'after-skill.ts'],
    );
  });

  it.each([100, 80, 44])('keeps an exact skill row adjacent while the following activity is running at %i columns', (columns) => {
    const { display, screen } = prepare(columns);
    display.renderUiEvent('ui_skill_invocation', {
      invocation_id: `skill-running-spacing-${columns}`,
      skill_name: 'systematic-debugging',
      reference_name: 'SKILL.md',
      duration_ms: 2,
    });
    display.toolRow('file_read', { path: 'src/after-skill-running.ts' });

    const lines = compactTranscriptLines(screen);
    if (columns >= 80) {
      expectAdjacent(lines, ['skill', 'systematic-debugging'], ['read', 'after-skill-running.ts']);
    } else {
      expectCompactTransition(lines, ['skill', 'systematic-debugging'], ['read', 'after-skill-running.ts']);
    }
  });

  it('keeps a skill row and several following activities in one compact sequence', () => {
    const { display, screen } = prepare();
    display.renderUiEvent('ui_skill_invocation', {
      invocation_id: 'skill-multiple-spacing',
      skill_name: 'systematic-debugging',
      reference_name: 'SKILL.md',
      duration_ms: 2,
    });
    display.toolRow('file_read', { path: 'src/first-after-skill.ts' }).ok(7);
    display.toolRow('file_read', { path: 'src/second-after-skill.ts' }).ok(8);

    const lines = compactTranscriptLines(screen);
    expectAdjacent(lines, ['skill', 'systematic-debugging'], ['completed', 'first-after-skill.ts']);
    expectAdjacent(lines, ['completed', 'first-after-skill.ts'], ['completed', 'second-after-skill.ts']);
  });

  it('keeps wrapped skill and activity content adjacent', () => {
    const { display, screen } = prepare(44);
    display.renderUiEvent('ui_skill_invocation', {
      invocation_id: 'skill-wrapped-spacing',
      skill_name: 'systematic-debugging-with-a-long-name',
      reference_name: 'SKILL.md',
      duration_ms: 2,
    });
    display.toolRow('file_read', { path: 'src/after-skill-wrapped-content.ts' });

    expectCompactTransition(
      compactTranscriptLines(screen),
      ['skill'],
      ['read', 'after-skill-wrapped-content.ts'],
    );
  });

  it('preserves one skill and activity projection through narrow and wide repaint', async () => {
    const { display, screen, stream } = prepare(100);
    display.renderUiEvent('ui_skill_invocation', {
      invocation_id: 'skill-resize-spacing',
      skill_name: 'systematic-debugging',
      reference_name: 'SKILL.md',
      duration_ms: 2,
    });
    display.toolRow('file_read', { path: 'src/after-skill-resize.ts' });
    stream.resize(44, 24);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stream.resize(100, 24);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const lines = compactTranscriptLines(screen);
    const skill = findSemanticLine(lines, ['skill', 'systematic-debugging']);
    const activity = findSemanticLine(lines, ['read', 'after-skill-resize.ts']);
    expect(skill, lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(activity, lines.join('\n')).toBeGreaterThan(skill);
    expect(lines.filter((line) => /skill\s+systematic-debugging/iu.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /after-skill-resize/iu.test(line))).toHaveLength(1);
  });

  it('keeps a settled skill activity compact after normal to narrow resize cycles', async () => {
    const { display, screen, stream } = prepare(100);
    display.renderUiEvent('ui_skill_invocation', {
      invocation_id: 'skill-resize-settlement-spacing',
      skill_name: 'systematic-debugging',
      reference_name: 'SKILL.md',
      duration_ms: 2,
    });
    const activity = display.toolRow('file_read', { path: 'package.json' });

    for (const columns of [44, 100, 44]) {
      stream.resize(columns, 24);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    activity.ok(7);
    display.write(display.agentTurn('Resize settlement answer.', { activityDivider: true }));

    const lines = compactTranscriptLines(screen);
    expectCompactTransition(lines, ['skill', 'systematic-debugging'], ['completed', 'package.json']);
    expectActivityAnswerBoundary(screen, ['completed', 'package.json'], 'Resize settlement answer.');
    expect(lines.filter((line) => /skill\s+systematic-debugging/iu.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /completed\s+package\.json/iu.test(line))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('Resize settlement answer.'))).toHaveLength(1);
    expect(composerGeometry(screen).status).not.toBe('');
  });

  it('keeps a settled skill activity compact when starting at narrow width', () => {
    const { display, screen } = prepare(44);
    display.renderUiEvent('ui_skill_invocation', {
      invocation_id: 'skill-narrow-settlement-spacing',
      skill_name: 'systematic-debugging',
      reference_name: 'SKILL.md',
      duration_ms: 2,
    });
    display.toolRow('file_read', { path: 'package.json' }).ok(7);
    display.write(display.agentTurn('Narrow settlement answer.', { activityDivider: true }));

    const lines = compactTranscriptLines(screen);
    expectCompactTransition(lines, ['skill', 'systematic-debugging'], ['completed', 'package.json']);
    expectActivityAnswerBoundary(screen, ['completed', 'package.json'], 'Narrow settlement answer.');
    expect(composerGeometry(screen).status).not.toBe('');
  });

  it('keeps consecutive browser navigation rows adjacent', () => {
    const { display, screen } = prepare();
    display.toolRow('browser_navigate', { url: 'https://a.test' }).ok(10_000);
    display.toolRow('browser_navigate', { url: 'https://b.test' }).ok(3_400);

    expectAdjacent(
      compactTranscriptLines(screen),
      ['completed', 'a.test'],
      ['completed', 'b.test'],
    );
  });

  it('keeps click and snapshot rows adjacent', () => {
    const { display, screen } = prepare();
    display.toolRow('browser_click', { selector: '@e755' }).ok(300);
    display.toolRow('browser_snapshot', { path: 'snapshot-full' }).ok(700);

    expectAdjacent(
      compactTranscriptLines(screen),
      ['completed', '@e755'],
      ['completed', 'snapshot-full'],
    );
  });

  it('keeps a settled Worker update adjacent to verification evidence', () => {
    const { display, screen } = prepare();
    display.renderUiEvent('ui_task_update', {
      task_id: 'worker-spacing', kind: 'subagent', label: 'Runtime ownership', status: 'running',
    });
    display.renderUiEvent('ui_task_done', {
      task_id: 'worker-spacing', status: 'success', summary: 'Worker complete',
    });
    display.evidencePanel([{
      evidenceId: 'evidence-spacing', source: 'fresh_readback',
      verificationResult: 'verified', payload: { path: 'src/runtime.ts' },
    }]);

    expectAdjacent(
      compactTranscriptLines(screen),
      ['Worker complete'],
      ['Evidence'],
    );
  });

  it('keeps cancelled rows in the same compact activity list', () => {
    const { display, screen } = prepare();
    display.toolRow('file_read', { path: 'src/first.ts' }).ok(12);
    display.toolRow('shell_exec', { command: 'echo cancelled-row' }).cancel(18);

    expectAdjacent(
      compactTranscriptLines(screen),
      ['completed', 'first.ts'],
      ['cancelled', 'echo cancelled-row'],
    );
  });

  it('keeps settled rows compact at narrow width without overlap', () => {
    const { display, screen } = prepare(44);
    display.toolRow('file_read', { path: 'src/first.ts' }).ok(12);
    display.toolRow('file_read', { path: 'src/second.ts' }).ok(14);

    const lines = compactTranscriptLines(screen);
    const activity = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /┊\s+✓\s+completed/iu.test(line));
    expect(activity).toHaveLength(2);
    expect(activity[1]?.index, lines.join('\n')).toBe((activity[0]?.index ?? -2) + 1);
    expect(activity.every(({ line }) => line.length <= 43)).toBe(true);
  });

  it('keeps semantic adjacency when colour output is disabled', () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '0';
    try {
      const { display, screen } = prepare();
      display.toolRow('file_read', { path: 'src/first.ts' }).ok(12);
      display.toolRow('file_read', { path: 'src/second.ts' }).ok(14);
      expectAdjacent(
        compactTranscriptLines(screen),
        ['completed', 'first.ts'],
        ['completed', 'second.ts'],
      );
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previousForceColor;
    }
  });

  function expectActivityAnswerBoundary(
    screen: TerminalScreen,
    activityTerms: readonly string[],
    answerText: string,
    blankAfterHeader = true,
  ): void {
    const lines = compactTranscriptLines(screen);
    const activity = findSemanticLine(lines, activityTerms);
    const divider = lines.findIndex((line, index) => index > activity && /^\s*─{10,}\s*$/u.test(line));
    const header = findSemanticLine(lines, ['Aiden']);
    const answer = findSemanticLine(lines, [answerText]);
    expect(activity).toBeGreaterThanOrEqual(0);
    expect(divider, lines.join('\n')).toBe(activity + 1);
    expect(header, lines.join('\n')).toBe(divider + 1);
    if (blankAfterHeader) expect(lines[header + 1], lines.join('\n')).toBe('');
    expect(answer, lines.join('\n')).toBe(header + (blankAfterHeader ? 2 : 1));
  }

  it('keeps a completed activity directly beside the assistant boundary', () => {
    const { display, screen } = prepare();
    display.toolRow('file_read', { path: 'src/completed.ts' }).ok(12);
    display.write(display.agentTurn('Completed activity answer.', { activityDivider: true }));

    expectActivityAnswerBoundary(screen, ['completed', 'completed.ts'], 'Completed activity answer.');
  });

  it('keeps a failed activity directly beside the assistant boundary', () => {
    const { display, screen } = prepare();
    display.toolRow('shell_exec', { command: 'echo failed-transition' }).fail(18);
    display.write(display.agentTurn('Failed activity answer.', { activityDivider: true }));

    expectActivityAnswerBoundary(screen, ['failed', 'failed-transition'], 'Failed activity answer.');
  });

  it('keeps a skill activity directly beside the assistant boundary', () => {
    const { display, screen } = prepare();
    display.renderUiEvent('ui_skill_invocation', {
      invocation_id: 'skill-answer-spacing',
      skill_name: 'systematic-debugging',
      reference_name: 'SKILL.md',
      duration_ms: 2,
    });
    display.write(display.agentTurn('Skill activity answer.', { activityDivider: true }));

    expectActivityAnswerBoundary(screen, ['skill', 'systematic-debugging'], 'Skill activity answer.');
  });

  it('preserves activity adjacency and assistant paragraph spacing', () => {
    const { display, screen } = prepare();
    display.toolRow('file_read', { path: 'src/first.ts' }).ok(12);
    display.toolRow('file_read', { path: 'src/second.ts' }).ok(14);
    display.write(display.agentTurn('First paragraph.\n\nSecond paragraph.', { activityDivider: true }));

    const lines = compactTranscriptLines(screen);
    expectAdjacent(lines, ['completed', 'first.ts'], ['completed', 'second.ts']);
    expectActivityAnswerBoundary(screen, ['completed', 'second.ts'], 'First paragraph.');
    const first = findSemanticLine(lines, ['First paragraph.']);
    const second = findSemanticLine(lines, ['Second paragraph.']);
    expect(lines.slice(first + 1, second)).toEqual(['']);
  });

  it('keeps the streamed assistant boundary compact after activity', () => {
    const { display, screen } = prepare();
    display.toolRow('file_read', { path: 'src/first.ts' }).ok(12);
    display.toolRow('file_read', { path: 'src/second.ts' }).ok(14);
    display.streamPartial('Streamed activity answer.', true);
    display.streamComplete();

    expectActivityAnswerBoundary(screen, ['completed', 'second.ts'], 'Streamed activity answer.', false);
  });

  it('keeps the activity-to-answer transition bounded at narrow width', () => {
    const { display, screen } = prepare(44);
    display.toolRow('file_read', { path: 'src/narrow-transition.ts' }).ok(12);
    display.write(display.agentTurn('Narrow answer remains readable.', { activityDivider: true }));

    expectActivityAnswerBoundary(screen, ['completed', 'narrow-transition'], 'Narrow answer remains');
    expect(compactTranscriptLines(screen).every((line) => line.length <= 43)).toBe(true);
  });
});

describe.each([100, 80, 44])('borderless fixed bottom region at %i columns', (columns) => {
  it('owns empty, normal, and Unicode drafts with the hardware cursor at insertion', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);

    display.setStatusFooter('◆ provider · model │ ◉ context 2k/32k │ ⧖ 4s');
    display.setIdleComposer('', 'Type your message · /help');
    let surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines()[surface.top]).toContain('▲ You');
    expect(surface.content).toHaveLength(1);
    expect(surface.content[0]).not.toContain('Type your message');
    expect(screen.cursorPosition()).toEqual({ row: surface.top + 2, col: 0 });

    display.setIdleComposer('hello terminal', 'Type your message · /help', 5);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join('')).toContain('hello terminal');
    expect(screen.cursorPosition().row).toBe(surface.bottom - 1);
    expect(screen.cursorPosition().col).toBe(5);

    display.setIdleComposer('Unicode: नमस्ते 世界 🚀', 'Type your message · /help');
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join('')).toContain('Unicode: नमस्ते 世界 🚀');
    expect(screen.cursorPosition().row).toBe(surface.bottom - 1);

    display.setIdleComposer('A世界B', 'Type your message · /help', 'A世'.length);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join('')).toContain('A世界B');
    expect(screen.cursorPosition()).toEqual({
      row: surface.bottom - 1,
      col: 3,
    });
  });

  it('grows upward for wrapped drafts while status remains on the final row', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);
    const draft = 'wrapped input '.repeat(12).trim();

    display.setStatusFooter('◆ provider · model │ ◉ context 2k/32k │ ⧖ 8s');
    display.setIdleComposer(draft, 'Type your message · /help');

    const surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.length).toBeGreaterThan(1);
    expect(surface.content.join(' ')).toContain('wrapped input');
    expect(screen.lines().at(-1)).toContain('⧖');
    expect(screen.cursorPosition().row).toBe(surface.bottom - 1);
  });

  it('labels queue mode and keeps acknowledgements above the owned surface', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);

    display.setStatusFooter('◆ provider · model │ ◉ context 1k/32k │ ⧖ 1s');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    display.setComposer('QUEUE ONE', 'queue');
    display.write('\n✓ queued (1 pending) · input_first\n');
    display.setComposer('QUEUE TWO', 'queue');

    const surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines()[surface.top]).toContain('▲ You · queue mode');
    expect(surface.content.join('')).toContain('QUEUE TWO');
    expect(screen.lines().slice(0, surface.top).join('\n')).toContain('input_first');
    expect(screen.lines().slice(0, surface.top).join('\n')).not.toContain('QUEUE TWO');
  });

  it('keeps streaming and tool output above the composer and restores after a modal', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(columns);

    display.setStatusFooter('◆ provider · model │ ◉ context 1k/16k │ ⧖ 1s');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const tool = display.toolRow('shell_exec', { command: 'Start-Sleep -Seconds 6' });
    display.write('streamed response\n');
    let surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines().slice(0, surface.top).join('\n')).toContain('streamed response');

    display.pauseComposerSurface();
    display.write('approval prompt\n');
    display.resumeComposerSurface();
    surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines()[surface.top]).toContain('queue mode');

    tool.ok(6_000);
    surface = expectExclusiveSurface(screen, 'provider');
    expect(screen.lines().slice(0, surface.top).join('\n')).toContain('Start-Sleep');
  });
});

describe('borderless fixed bottom region resize', () => {
  it.each([false, true])(
    'settles a live row before a second host resize can archive it (reflowSafe=%s)',
    async (reflowSafe) => {
      const { region, resize, screen } = createRegionHarness(reflowSafe);
      region.setLiveRow('tool_settlement', '⚙ shell_exec running');

      resize(150, 45);
      region.settleLiveRow('tool_settlement', '✓ shell_exec completed');
      resize(80, 24);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(screen.bufferSnapshot()).not.toContain('shell_exec running');
      expect(screen.bufferSnapshot().match(/shell_exec completed/gu) ?? []).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'rejects a late activity frame after terminal settlement (reflowSafe=%s)',
    async (reflowSafe) => {
      const { region, resize, screen } = createRegionHarness(reflowSafe);
      region.setLiveRow('tool_late_tick', '⚙ shell_exec running frame 1');
      region.settleLiveRow('tool_late_tick', '! shell_exec cancelled', 'cancelled');
      resize(44, 18);
      region.setLiveRow('tool_late_tick', '⚙ shell_exec running late frame');
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(screen.bufferSnapshot()).not.toContain('running late frame');
      expect(screen.bufferSnapshot().match(/shell_exec cancelled/gu) ?? []).toHaveLength(1);
    },
  );

  it.each([
    ['succeeded', '✓ tool completed'],
    ['failed', '! tool failed'],
    ['cancelled', '! tool cancelled'],
  ] as const)(
    'keeps only one %s terminal projection through rapid resize settlement',
    async (state, terminal) => {
      const { region, resize, screen } = createRegionHarness(false, 100, 30);
      region.setLiveRow(`tool_${state}`, '⚙ tool running');
      for (const [columns, rows] of [[60, 24], [100, 30], [44, 18]] as const) {
        resize(columns, rows);
      }
      region.settleLiveRow(`tool_${state}`, terminal, state);
      for (const [columns, rows] of [[100, 30], [60, 24], [100, 30]] as const) {
        resize(columns, rows);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(screen.bufferSnapshot()).not.toContain('tool running');
      expect(
        screen.bufferSnapshot().match(new RegExp(terminal.slice(2), 'gu')) ?? [],
        screen.bufferSnapshot(),
      ).toHaveLength(1);
    },
  );

  it('removes provider activity during resize without archiving its volatile frame', async () => {
    const { region, resize, screen } = createRegionHarness(false);
    region.setLiveRow('provider_wait', '◐ Aiden is thinking');
    resize(150, 45);
    region.removeLiveRow('provider_wait', true);
    resize(80, 24);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(screen.bufferSnapshot()).not.toContain('Aiden is thinking');
  });

  it('makes room without overwriting the existing transcript tail', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(80, 14);
    display.write(Array.from({ length: 8 }, (_, index) => `startup transcript ${index + 1}`).join('\n'));

    display.setStatusFooter('◆ provider · model │ ◉ context 0/32k │ ⧖ 0ms');
    display.setIdleComposer('', 'Type your message · /help');

    const surface = expectExclusiveSurface(screen, 'provider');
    const transcript = screen.lines().slice(0, surface.top).join('\n');
    expect(transcript).toContain('startup transcript 8');
    expect(transcript).not.toContain('startup transcr▲');
  });

  it('preserves column-one draft, cursor, hierarchy, and single ownership across 100 → 44 → 100', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100);
    const draft = 'a long Unicode draft 世界 that must wrap upward and survive resizing exactly';

    display.setStatusFooter('◆ provider · selected-model │ ◉ context 3k/32k │ ⧖ 9s');
    display.setIdleComposer(draft, 'Type your message · /help', 6);
    let surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join(' ')).toContain('Unicode draft');
    expect(surface.content[0]?.[0]).toBe('a');
    expect(screen.cursorPosition().col).toBe(6);

    stream.resize(44, 18);
    await new Promise<void>((resolve) => setImmediate(resolve));
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.length).toBeGreaterThan(1);
    expect(composerText(surface.content)).toContain('survive resizing exactly');
    expect(surface.content[0]?.[0]).toBe('a');
    expect(screen.cursorPosition().col).toBe(6);

    stream.resize(100, 18);
    await new Promise<void>((resolve) => setImmediate(resolve));
    surface = expectExclusiveSurface(screen, 'provider');
    expect(surface.content.join(' ')).toContain('Unicode draft 世界');
    expect(surface.content[0]?.[0]).toBe('a');
    expect(screen.cursorPosition()).toEqual({ row: surface.top + 2, col: 6 });
    expect(screen.scrollbackSnapshot(), screen.bufferSnapshot()).not.toContain('▲ You');
  });

  it('coalesces a resize burst into one main-buffer surface repaint', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.write('Environment\nCapabilities\nBuilt solo\n');
    display.setStatusFooter('◆ provider · model │ ◉ context 3k/32k │ ⧖ 9s');
    display.setIdleComposer('draft survives', 'Type your message · /help');
    stream.writes.length = 0;

    for (const [columns, rows] of [
      [60, 24], [100, 30], [44, 18], [100, 30],
    ] as const) {
      stream.resize(columns, rows);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stream.writes, stream.writes.join('\n')).toHaveLength(1);
    const resizeTransaction = stream.writes.join('');
    expect(resizeTransaction).not.toContain('\x1b[?1049h');
    expect(resizeTransaction).not.toContain('\x1b[2J\x1b[H');
    expect(resizeTransaction).not.toContain('\n');
    expect(resizeTransaction).not.toContain('Environment');
    expect(resizeTransaction).not.toContain('Capabilities');
    expect(resizeTransaction).not.toContain('Built solo');
    const rendered = screen.snapshot();
    expect(rendered.match(/▲ You/gu)).toHaveLength(1);
    expect(rendered.match(/◆\s*provider/gu)).toHaveLength(1);
    expect(rendered).toContain('draft survives');
    const durableBuffer = screen.bufferSnapshot();
    expect(durableBuffer.match(/Environment/gu) ?? []).toHaveLength(1);
    expect(durableBuffer.match(/Capabilities/gu) ?? []).toHaveLength(1);
    expect(durableBuffer.match(/Built solo/gu) ?? []).toHaveLength(1);
    const transientHistory = screen.scrollbackSnapshot();
    expect(transientHistory).not.toContain('▲ You');
    expect(transientHistory).not.toContain('◆ provider');
    expect(maxBlankRun(transientHistory)).toBeLessThanOrEqual(4);
  });

  it('projects the latest activity and status once after rapid 60 ↔ 44 oscillation', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.setStatusFooter('◆ provider · model │ ◉ context 1k/32k │ ⧖ 1s');
    display.setIdleComposer('unsent draft', 'Type your message · /help');
    stream.writes.length = 0;

    for (const width of [60, 44, 60, 44, 100]) {
      stream.resize(width, 30);
      display.renderUiEvent('ui_task_update', {
        task_id: 'task_resize', label: `Inspect at ${width}`, status: 'running',
      });
      display.setStatusFooter(`◆ provider · model │ ◉ context 2k/32k │ ⧖ ${width}ms`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stream.writes, stream.writes.join('\n')).toHaveLength(1);
    const rendered = screen.snapshot();
    expect(rendered.match(/^▲ You/gmu) ?? [], rendered).toHaveLength(1);
    expect(rendered.match(/Inspect at 100/gu) ?? [], rendered).toHaveLength(1);
    expect(rendered, rendered).not.toContain('Inspect at 44');
    expect(rendered, rendered).toContain('unsent draft');
    expect(rendered.split('\n').at(-1), rendered).toContain('100ms');
  });

  it('invalidates a deferred resize repaint when the viewport epoch changes', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.setStatusFooter('◆ provider · model │ ◉ context 0/32k │ ⧖ 0ms');
    display.setIdleComposer('draft survives clear', 'Type your message · /help');

    stream.resize(44, 20);
    display.clearScreen();
    const writesAfterClear = stream.writes.length;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stream.writes).toHaveLength(writesAfterClear);
    const rendered = screen.snapshot();
    expect(rendered.match(/^▲ You/gmu) ?? [], rendered).toHaveLength(1);
    expect(rendered, rendered).toContain('draft survives clear');
    expect(rendered.match(/^◆\s*provider/gmu) ?? [], rendered).toHaveLength(1);
  });

  it('restores one-shot transcript and footer after a modal resizes the terminal', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.write('Environment │ Capabilities\nBuilt solo\n');
    display.setStatusFooter('◆ provider · model │ ◉ context 3k/32k │ ⧖ 9s');
    display.setIdleComposer('approval draft', 'Type your message · /help');

    display.pauseComposerSurface();
    stream.resize(44, 20);
    display.write('Approval required\n');
    stream.resize(100, 30);
    display.resumeComposerSurface();

    const rendered = screen.snapshot();
    const reviewable = screen.reviewableSnapshot();
    expect(reviewable.match(/Environment/gu), reviewable).toHaveLength(1);
    expect(reviewable.match(/Capabilities/gu)).toHaveLength(1);
    expect(reviewable.match(/Built solo/gu)).toHaveLength(1);
    expect(rendered.match(/Approval required/gu)).toHaveLength(1);
    expect(rendered.match(/▲ You/gu)).toHaveLength(1);
    expect(rendered.match(/◆\s*provider/gu)).toHaveLength(1);
    expect(rendered).toContain('approval draft');
  });

  it('keeps one volatile surface through fifty physical-equivalent resize sequences', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.write('Environment\nCapabilities\nBuilt solo\n');
    display.setStatusFooter('◆ custom_openai · custom-default │ ◉ context 0/32k │ ✓ ready │ ⧖ 0ms');
    display.setIdleComposer('unsent Windows draft', 'Type your message · /help');

    const sequence = [60, 100, 44, 100, 60, 44] as const;
    for (let iteration = 0; iteration < 50; iteration += 1) {
      for (const width of sequence) {
        stream.resize(width, 30);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const rendered = screen.snapshot();
      expect(rendered.match(/^▲ You/gmu) ?? [], rendered).toHaveLength(1);
      expect(rendered.match(/^◆\s*custom_openai/gmu) ?? [], rendered).toHaveLength(1);
      expect(screen.scrollbackSnapshot(), screen.bufferSnapshot()).not.toContain('▲ You');
    }

    const history = screen.reviewableSnapshot();
    expect(history.match(/Environment/gu) ?? [], history).toHaveLength(1);
    expect(history.match(/Capabilities/gu) ?? [], history).toHaveLength(1);
    expect(history.match(/Built solo/gu) ?? [], history).toHaveLength(1);
    expect(screen.snapshot(), screen.snapshot()).toContain('unsent Windows draft');
  });

  it('survives one hundred mixed-width transitions across activity and approval ownership', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 30);
    display.write('durable prompt\ncompleted answer\n');
    display.setStatusFooter('◆ custom_openai · custom-default │ ◉ context 7% │ T │ ⧖ 8s');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    display.setComposer('queued draft remains exact', 'queue');

    const widths = [100, 60, 44, 80, 40, 100, 44, 60] as const;
    for (let index = 0; index < 100; index += 1) {
      const width = widths[index % widths.length];
      if (index === 20) {
        display.renderUiEvent('ui_task_update', {
          task_id: 'provider_resize', label: 'Provider activity', status: 'running',
        });
      }
      if (index === 40) {
        display.renderUiEvent('ui_task_update', {
          task_id: 'tool_resize', label: 'Tool activity', status: 'running',
        });
      }
      if (index === 60) {
        display.pauseComposerSurface();
        stream.resize(width, 24);
        display.write('Approval required\n');
        display.resumeComposerSurface();
      } else {
        stream.resize(width, index % 3 === 0 ? 24 : 30);
      }
      if (index === 80) {
        display.renderUiEvent('ui_task_update', {
          task_id: 'provider_resize', label: 'Provider complete', status: 'completed',
        });
        display.renderUiEvent('ui_task_update', {
          task_id: 'tool_resize', label: 'Tool complete', status: 'completed',
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const rendered = screen.snapshot();
      expect(rendered.match(/^▲ You · queue mode/gmu) ?? [], rendered).toHaveLength(1);
      expect(rendered.match(/^◆\s*custom_openai/gmu) ?? [], rendered).toHaveLength(1);
      expect(screen.scrollbackSnapshot(), screen.bufferSnapshot()).not.toContain('▲ You');
    }

    const rendered = screen.snapshot();
    expect(rendered, rendered).toContain('queued draft remains exact');
    expect(
      screen.reviewableSnapshot().match(/Approval required/gu) ?? [],
      screen.reviewableSnapshot(),
    ).toHaveLength(1);
    expect(screen.reviewableSnapshot(), screen.reviewableSnapshot()).toContain('completed answer');
  });
});

function semanticGap(lines: string[], before: string, after: string): number {
  const beforeRow = lines.findLastIndex((line) => line.includes(before));
  const afterRow = lines.findLastIndex((line) => line.includes(after));
  expect(beforeRow, `missing semantic row: ${before}`).toBeGreaterThanOrEqual(0);
  expect(afterRow, `missing semantic row: ${after}`).toBeGreaterThan(beforeRow);
  return afterRow - beforeRow - 1;
}

function maxBlankRun(value: string): number {
  let current = 0;
  let maximum = 0;
  for (const line of value.split(/\r?\n/u)) {
    if (line.trim() === '') {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

describe('compact hybrid transcript geometry', () => {
  it('renders distinct prompt and answer blocks without attaching to activity output', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(80, 24);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('Fix `src/math.mjs` and run its focused test.', 'Type your message · /help');
    const activity = display.toolRow('shell_exec', { command: 'npm test -- math' }, undefined, {
      activityId: 'tool_test', externalTicker: true,
    });
    activity.ok(40);
    display.printTurnSeparator();
    display.write(display.agentTurn('Fixed `src/math.mjs`. The focused test passed.'));

    const transcript = screen.lines().slice(0, composerGeometry(screen).top);
    const userRow = transcript.findIndex((line) => line.includes('You'));
    const toolRow = transcript.findIndex((line) => line.includes('npm test'));
    const answerRow = transcript.findIndex((line) => line.includes('Aiden'));
    expect(userRow).toBeGreaterThanOrEqual(0);
    expect(toolRow).toBeGreaterThan(userRow);
    expect(answerRow).toBeGreaterThan(toolRow);
    expect(transcript.slice(userRow, toolRow).some((line) => /^\s*─{10,}\s*$/u.test(line))).toBe(true);
    expect(transcript.slice(toolRow, answerRow).some((line) => /^\s*─{10,}\s*$/u.test(line))).toBe(true);
  });
  it('wraps transcript prose at word boundaries when the word fits the terminal', async () => {
    await primeFrameAsync();
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(44, 18);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.write('12345678901234567890123456789012345678 ownership remains stable\n');

    const surface = composerGeometry(screen);
    const transcript = screen.lines().slice(0, surface.top);
    expect(transcript.some((line) => line.includes('ownership')), screen.snapshot()).toBe(true);
    expect(transcript.some((line) => /owner$|^ship\b/u.test(line.trim()))).toBe(false);
  });

  it('replaces repeated task updates in one stable live row before settlement', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(80, 18);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');

    display.renderUiEvent('ui_task_update', {
      task_id: 'task_index', label: 'Index repository', status: 'running',
    });
    display.renderUiEvent('ui_task_update', {
      task_id: 'task_index', label: 'Index repository: 42 files', status: 'running',
    });

    const visible = screen.snapshot();
    expect(visible.match(/Index repository/gu)).toHaveLength(1);
    expect(visible).toContain('Index repository: 42 files');

    display.renderUiEvent('ui_task_done', {
      task_id: 'task_index', status: 'success', summary: '42 files indexed',
    });
    display.renderUiEvent('ui_task_done', {
      task_id: 'task_index', status: 'success', summary: '42 files indexed',
    });
    const completed = screen.snapshot();
    expect(completed.match(/Index repository: 42 files/gu)).toHaveLength(1);
    expect(completed.match(/42 files indexed/gu)).toHaveLength(1);
    expect(completed).toContain('✓ 42 files indexed');
    expect(completed).not.toContain('◐ Working');
  });
  it.each([16, 24, 35, 45, 60])(
    'keeps provider activity adjacent to a short prompt at %i rows',
    (rows) => {
      delete process.env.AIDEN_COMPOSER_LANE;
      const { display, screen } = createDisplay(100, rows);
      display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
      display.setIdleComposer('', 'Type your message · /help');
      display.submitIdleComposer('compact provider request', 'Type your message · /help');
      display.setBusyHint('Enter → queue · Ctrl+C stop');
      const provider = display.liveActivityRow('calling provider');

      expect(semanticGap(screen.lines(), 'compact provider request', 'Aiden is thinking')).toBeLessThanOrEqual(1);
      provider.stop();
    },
  );

  it('keeps provider activity adjacent to the final wrapped prompt row', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(44, 45);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer(
      'wrapped request keeps every semantic neighbor close FINAL-PROMPT-LINE',
      'Type your message · /help',
    );
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');

    expect(semanticGap(screen.lines(), 'FINAL-PROMPT-LINE', 'Aiden is thinking')).toBeLessThanOrEqual(1);
    provider.stop();
  });

  it('keeps compact spacing while terminal height changes during provider activity', async () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen, stream } = createDisplay(100, 24);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('resize provider request', 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');

    for (const rows of [60, 16, 35]) {
      stream.resize(100, rows);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(semanticGap(screen.lines(), 'resize provider request', 'Aiden is thinking')).toBeLessThanOrEqual(1);
    }
    provider.stop();
  });

  it('keeps provider and tool activity in semantic order without filler rows', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(100, 45);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('inspect the package manifest', 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');
    const tool = display.toolRow('file_read', { path: 'package.json' }, undefined, {
      activityId: 'activity_package_read',
    });

    const lines = screen.lines();
    expect(semanticGap(lines, 'inspect the package manifest', 'Aiden is thinking')).toBeLessThanOrEqual(1);
    expect(semanticGap(lines, 'Aiden is thinking', 'package.json')).toBe(0);
    tool.ok(20);
    provider.stop();
  });

  it('places the final response immediately after the active provider phase', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(100, 35);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('return one concise answer', 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');
    expect(semanticGap(screen.lines(), 'return one concise answer', 'Aiden is thinking')).toBeLessThanOrEqual(1);

    provider.stop();
    display.write(display.agentHeader());
    display.write('FINAL COMPACT RESPONSE\n');
    expect(semanticGap(screen.lines(), 'return one concise answer', 'Aiden')).toBeLessThanOrEqual(1);
    expect(semanticGap(screen.lines(), 'Aiden', 'FINAL COMPACT RESPONSE')).toBeLessThanOrEqual(1);
  });

  it('opens approval at the active semantic boundary and restores the footer', () => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(100, 35);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('request a guarded action', 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');
    expect(semanticGap(screen.lines(), 'request a guarded action', 'Aiden is thinking')).toBeLessThanOrEqual(1);

    provider.stop();
    display.pauseComposerSurface();
    display.write('Approval required\n');
    expect(semanticGap(screen.lines(), 'request a guarded action', 'Approval required')).toBeLessThanOrEqual(1);
    display.resumeComposerSurface();
    expect(screen.lines().at(-1)).toContain('provider');
  });

  it.each(['clear', 'cls'])('starts a compact provider block after /%s projection reset', (command) => {
    delete process.env.AIDEN_COMPOSER_LANE;
    const { display, screen } = createDisplay(100, 35);
    display.setStatusFooter('◆ provider · model │ ◉ context │ ⧖ 0s');
    display.setIdleComposer('', 'Type your message · /help');
    display.submitIdleComposer('OLD VISIBLE REQUEST', 'Type your message · /help');
    display.clearScreen();
    if (command === 'clear') display.success('New chat started');
    display.submitIdleComposer(`request after ${command}`, 'Type your message · /help');
    display.setBusyHint('Enter → queue · Ctrl+C stop');
    const provider = display.liveActivityRow('calling provider');

    expect(screen.snapshot()).not.toContain('OLD VISIBLE REQUEST');
    expect(semanticGap(screen.lines(), `request after ${command}`, 'Aiden is thinking')).toBeLessThanOrEqual(1);
    provider.stop();
  });
});
