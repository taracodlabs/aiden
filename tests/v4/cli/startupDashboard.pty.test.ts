import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';

import { COMPOSER_READY_TOKEN, RESIZE_READY_TOKEN } from '../../../cli/v4/composerReadiness';
import { startMockProvider, type MockProvider } from '../harness/mockProvider';
import { TerminalScreen } from '../harness/terminalScreen';
import { AIDEN_LOGO_LINES as CANONICAL_LOGO } from '../../../core/v4/ui/identity';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidth: (value: string) => number = require('string-width');

type RunningPty = ReturnType<typeof pty.spawn>;
const children: RunningPty[] = [];
const childResources = new Map<RunningPty, {
  exited: () => boolean;
  exit: Promise<void>;
  dataSubscription: { dispose(): void };
  exitSubscription: { dispose(): void };
}>();
const cleanup: string[] = [];
let provider: MockProvider | null = null;

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // ConPTY may project blank transcript rows as an absolute cursor move
    // to column one instead of emitting CRLF bytes. Preserve that visual row
    // boundary before removing the remaining control sequences.
    .replace(/\x1b\[\d+;1H/g, '\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

async function waitFor(
  predicate: () => boolean,
  diagnostic: () => string,
  timeoutMs = 25_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`startup PTY timeout:\n${diagnostic().slice(-8000)}`);
}

async function launch(columns: number, paused = false, promoteToColumns?: number): Promise<{
  child: RunningPty;
  raw: () => string;
  plain: () => string;
  rendered: () => string;
  physicalBuffer: () => string;
  scrollbackHistory: () => string;
  reviewableHistory: () => string;
  activeComposerCount: () => number;
  blockedProjection: () => string;
  resize: (columns: number, rows?: number) => Promise<void>;
}> {
  const repoRoot = path.resolve(__dirname, '../../..');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `aiden-startup-${columns}-home-`));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `aiden-startup-${columns}-cwd-`));
  const terminalSizeFile = path.join(home, '.terminal-size.json');
  cleanup.push(home, cwd);
  await fs.writeFile(
    terminalSizeFile,
    JSON.stringify({ columns, rows: 50 }),
    'utf8',
  );
  await fs.writeFile(path.join(home, '.onboarding-shown'), 'startup-dashboard\n', 'utf8');
  await fs.writeFile(path.join(home, 'config.yaml'), [
    'model:', '  provider: custom_openai', '  modelId: custom-default',
    'providers:', '  custom_openai:', '    apiKey: startup-key',
    'display:', '  streaming: true', '  renderer: legacy',
  ].join('\n') + '\n', 'utf8');
  if (paused) {
    await fs.writeFile(path.join(home, 'spawn.paused'), JSON.stringify({
      pausedAt: Date.now(), reason: 'startup fixture', pausedBy: 'repl',
    }), 'utf8');
  }

  const child = pty.spawn(process.execPath, [
    '-r', path.join(repoRoot, 'tests/v4/harness/terminalResizePreload.cjs'),
    '-r', path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs'),
    path.join(repoRoot, 'dist/cli/v4/aidenCLI.js'),
  ], {
    cwd,
    cols: columns,
    rows: 50,
    env: {
      ...process.env,
      AIDEN_HOME: home,
      AIDEN_TEST_REPO_ROOT: repoRoot,
      AIDEN_TEST_PROVIDER_BASE_URL: provider!.baseUrl,
      CUSTOM_OPENAI_API_KEY: 'startup-key',
      AIDEN_NO_UPDATE_CHECK: '1',
      AIDEN_TEST_COMPOSER_READY: '1',
      AIDEN_TEST_TERMINAL_SIZE_FILE: terminalSizeFile,
      TELEGRAM_BOT_TOKEN: '',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
  let output = '';
  let pendingHostResize: { columns: number; rows: number } | null = null;
  let hostResizeCapture = '';
  let exited = false;
  let resolveExit: () => void = () => undefined;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  // Windows reflows the main buffer before the application receives its resize
  // callback. Retain that physical history so a repaint cannot hide obsolete
  // composer generations behind a synthetic viewport reset.
  const screen = new TerminalScreen(columns, 50, { retainResizeHistory: true });
  const dataSubscription = child.onData((chunk) => {
    output += chunk;
    if (pendingHostResize) {
      hostResizeCapture += chunk;
      if (!hostResizeCapture.includes('\x1b[?25h')) return;
      const { columns, rows } = pendingHostResize;
      screen.prepareHostResize(columns, rows);
      screen.write(hostResizeCapture);
      screen.completeHostResizeSnapshot();
      screen.discardHostSnapshotComposer();
      hostResizeCapture = '';
      pendingHostResize = null;
      return;
    }
    screen.write(chunk);
  });
  const exitSubscription = child.onExit(() => {
    exited = true;
    resolveExit();
  });
  children.push(child);
  childResources.set(child, {
    exited: () => exited,
    exit,
    dataSubscription,
    exitSubscription,
  });
  let blockedProjection = '';
  if (promoteToColumns !== undefined) {
    await waitFor(
      () => stripAnsi(output).includes('Widen the terminal to continue.'),
      () => stripAnsi(output),
    );
    blockedProjection = stripAnsi(output);
    pendingHostResize = { columns: promoteToColumns, rows: 50 };
    hostResizeCapture = '';
    child.resize(promoteToColumns, 50);
    await fs.writeFile(
      terminalSizeFile,
      JSON.stringify({ columns: promoteToColumns, rows: 50 }),
      'utf8',
    );
  }
  await waitFor(
    () => output.includes(COMPOSER_READY_TOKEN),
    () => stripAnsi(output),
  );
  await waitFor(
    () => {
      const lines = screen.snapshot().split('\n');
      return (lines.at(-5)?.includes('You') ?? false)
        && (lines.at(-1)?.includes('custom-default') ?? false);
    },
    () => screen.snapshot(),
  );
  return {
    child,
    raw: () => output,
    plain: () => stripAnsi(output),
    rendered: () => screen.snapshot(),
    physicalBuffer: () => screen.bufferSnapshot(),
    scrollbackHistory: () => screen.scrollbackSnapshot(),
    reviewableHistory: () => screen.reviewableSnapshot(),
    activeComposerCount: () => screen.activeComposerSurfaces().length,
    blockedProjection: () => blockedProjection,
    resize: async (nextColumns, nextRows = 50) => {
      const outputStart = output.length;
      pendingHostResize = { columns: nextColumns, rows: nextRows };
      hostResizeCapture = '';
      child.resize(nextColumns, nextRows);
      await waitFor(
        () => pendingHostResize === null,
        () => output.slice(outputStart),
        2_000,
      );
      await fs.writeFile(
        terminalSizeFile,
        JSON.stringify({ columns: nextColumns, rows: nextRows }),
        'utf8',
      );
      await waitFor(
        () => output.slice(outputStart).includes(`${RESIZE_READY_TOKEN}:`)
          && output.slice(outputStart).includes(`:${nextColumns}x${nextRows}`)
          && screen.activeComposerSurfaces().length === 1
          && screen.bottomLine().includes('custom-default'),
        () => `${JSON.stringify({
          active: screen.activeComposerSurfaces().length,
          bottom: screen.bottomLine(),
          labels: screen.snapshot().match(/▲ You/gu)?.length ?? 0,
          resizeReady: output.slice(outputStart).split(RESIZE_READY_TOKEN).length - 1,
          resizeTokens: output.slice(outputStart).match(/__RESIZE_READY__:[^\x07]+/gu) ?? [],
        })}\n${screen.bufferSnapshot()}`,
        5_000,
      );
    },
  };
}

function maxBlankRun(value: string): number {
  let current = 0;
  let maximum = 0;
  for (const line of value.split('\n')) {
    if (line.trim() === '') {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function expectCleanMainBuffer(startup: Awaited<ReturnType<typeof launch>>): void {
  const current = startup.rendered();
  const history = startup.scrollbackHistory();
  const reviewable = startup.reviewableHistory();
  expect(reviewable.match(/Autonomous AI Engine/gu) ?? [], reviewable).toHaveLength(1);
  expect(reviewable.match(/Environment/gu) ?? [], reviewable).toHaveLength(1);
  expect(reviewable.match(/Capabilities/gu) ?? [], reviewable).toHaveLength(1);
  expect(reviewable.match(/Built solo/giu) ?? [], reviewable).toHaveLength(1);
  expect(reviewable, reviewable).toContain('GitHub:');
  expect(reviewable, reviewable).toContain('Web:');
  expect(history, history).not.toMatch(/^▲ You/mu);
  expect(history, history).not.toMatch(/^◆\s*custom_openai/mu);
  // Six rows are the established startup-to-composer breathing room. Resize
  // must not add another blank surface generation beyond that baseline.
  expect(maxBlankRun(history), history).toBeLessThanOrEqual(6);
  expect(startup.activeComposerCount(), current).toBe(1);
}

function dashboardLines(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(CANONICAL_LOGO[0]));
  const end = lines.findIndex((line, index) => index >= start && line.startsWith('▲ You'));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, Math.max(start, end - 1));
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    const resources = childResources.get(child);
    if (resources && !resources.exited()) {
      try { child.write('/quit\r'); } catch { /* already exited */ }
      await Promise.race([
        resources.exit,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (!resources?.exited()) {
      try { child.kill(); } catch { /* already exited */ }
      if (resources) {
        await Promise.race([
          resources.exit,
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      }
    }
    resources?.dataSubscription.dispose();
    resources?.exitSubscription.dispose();
    childResources.delete(child);
  }
  if (provider) {
    await provider.stop();
    provider = null;
  }
  await Promise.all(cleanup.splice(0).map(
    (directory) => fs.rm(directory, { recursive: true, force: true }).catch(() => undefined),
  ));
});

describe.skipIf(process.platform !== 'win32')('built CLI responsive startup dashboard', () => {
  it('emits the canonical six-line logo exactly once before composer ownership begins', async () => {
    provider = await startMockProvider({ modelId: 'custom-default' });
    const startup = await launch(100);
    const physical = startup.plain();

    for (const row of CANONICAL_LOGO) {
      expect(physical.split(row)).toHaveLength(2);
    }
    expect(physical).not.toMatch(/\x1b\[3[13]m/u);
  }, 30_000);

  it('holds a too-narrow boot and renders one complete startup after widening', async () => {
    provider = await startMockProvider({ modelId: 'custom-default' });
    const startup = await launch(40, false, 44);
    const blocked = startup.blockedProjection();
    const logicalBlocked = blocked.replace(/\s+/gu, ' ');

    expect(logicalBlocked).toContain('Aiden requires at least 41 columns to display its boot interface.');
    expect(logicalBlocked).toContain('Widen the terminal to continue.');
    expect(blocked).not.toContain('Autonomous AI Engine');
    expect(blocked).not.toContain('A I D E N');
    expect(blocked).not.toContain('Environment');

    const projection = startup.plain();
    for (const row of CANONICAL_LOGO) expect(projection.split(row)).toHaveLength(2);
    expect(projection.match(/Autonomous AI Engine/gu) ?? []).toHaveLength(1);
    expect(projection.match(/Built solo/giu) ?? []).toHaveLength(1);
    expect(startup.activeComposerCount()).toBe(1);
    await startup.resize(60);
    await startup.resize(44);
    expect(startup.reviewableHistory().match(/Autonomous AI Engine/gu) ?? []).toHaveLength(1);
    expect(startup.activeComposerCount()).toBe(1);
  }, 30_000);

  it('selects wide, medium, and narrow transcript tiers without resize duplication', async () => {
    provider = await startMockProvider({ modelId: 'custom-default' });

    const wide = await launch(120, true);
    const wideBeforeResize = wide.rendered();
    expect(wideBeforeResize).toContain('Environment');
    expect(wideBeforeResize).toContain('Capabilities');
    expect(wideBeforeResize).toContain('Built solo');
    expect(wideBeforeResize).toContain('╭');
    expect(wideBeforeResize).toMatch(/trust\s+Assistant/i);
    expect(wideBeforeResize).toContain('custom-default');
    expect(wideBeforeResize).toMatch(/\d+ loaded/);
    expect(wideBeforeResize).toContain('spawn-pause: ON');
    expect(wide.raw().split(COMPOSER_READY_TOKEN)).toHaveLength(2);
    for (const line of dashboardLines(wide.plain())) {
      expect(stringWidth(line), line).toBeLessThanOrEqual(118);
    }

    const logoCount = (wideBeforeResize.match(/Autonomous AI Engine/g) ?? []).length;
    await wide.resize(48);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await wide.resize(120);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((wide.reviewableHistory().match(/Autonomous AI Engine/g) ?? []).length).toBe(logoCount);

    const medium = await launch(80);
    const mediumRendered = medium.rendered();
    expect(mediumRendered).toContain('Environment');
    expect(mediumRendered).toContain('Capabilities');
    expect(mediumRendered).toContain('github.com/taracodlabs/aiden');
    expect(dashboardLines(medium.plain()).join('\n')).toContain('╭');
    expect(mediumRendered).toContain('GitHub:');
    expect(mediumRendered).toContain('Web:');
    expect(mediumRendered).toContain('Contact:');
    for (const line of dashboardLines(medium.plain())) {
      expect(stringWidth(line), line).toBeLessThanOrEqual(78);
    }

    const narrow = await launch(48);
    const narrowRendered = narrow.rendered();
    const narrowProjection = narrow.plain();
    for (const row of CANONICAL_LOGO) expect(narrowProjection).toContain(row);
    expect(narrowProjection).not.toContain('A I D E N');
    expect(narrowRendered).toMatch(/◇\s+Assistant\s+·\s+◆\s+custom-default/i);
    expect(narrowRendered).toMatch(/built solo/i);
    expect(narrowRendered).toContain('Environment');
    expect(narrowRendered).toContain('Capabilities');
    expect(dashboardLines(narrow.plain()).join('\n')).toContain('╭');
    expect(narrowRendered).toContain('GitHub:');
    expect(narrowRendered).toContain('Web:');
    expect(narrowRendered).toContain('Contact:');
    for (const line of dashboardLines(narrow.plain())) {
      expect(stringWidth(line), line).toBeLessThanOrEqual(46);
    }
    const narrowRows = narrowRendered.split('\n');
    expect(narrowRows.at(-6)).toMatch(/^─+$/u);
    expect(narrowRows.at(-5)).toContain('▲ You');
    expect(narrowRows.at(-4)).toBe('─'.repeat(21));
    expect(narrowRows.at(-3)).toBe('');
    expect(narrowRows.at(-2)).toMatch(/^─+$/u);
    expect(narrowRows.at(-1)).toContain('◉');
    expect(stringWidth(narrowRows.at(-6) ?? '')).toBeLessThanOrEqual(47);
    expect(stringWidth(narrowRows.at(-5) ?? '')).toBeLessThanOrEqual(47);
    expect(stringWidth(narrowRows.at(-1) ?? '')).toBeLessThanOrEqual(46);
    expect(narrowRows.slice(0, -6).filter((line) => line.includes('▲ You'))).toEqual([]);
  }, 75_000);

  it.each([
    [100, [60, 100]],
    [100, [44, 100]],
    [80, [44, 80]],
    [100, [60, 100, 44, 100, 60, 100]],
  ] as const)('preserves one reviewable startup generation after %i → %j', async (initial, widths) => {
    provider = await startMockProvider({ modelId: 'custom-default' });
    const startup = await launch(initial);

    const rapid = widths.length > 2;
    const expectOneCurrentBuffer = (): void => {
      const rendered = startup.rendered();
      expect(startup.activeComposerCount(), rendered).toBe(1);
      expect(rendered.split('\n').at(-1), rendered).toContain('custom-default');
      const history = startup.reviewableHistory();
      expect(history, history).toContain('Environment');
      expect(history, history).toContain('Capabilities');
      expect(history, history).toMatch(/Built solo/iu);
      expectCleanMainBuffer(startup);
    };
    for (const width of widths) {
      await startup.resize(width);
      if (!rapid) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expectOneCurrentBuffer();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expectOneCurrentBuffer();
  }, 45_000);

  it.each([
    [[60]],
    [[60, 100]],
    [[60, 100, 44]],
    [[60, 100, 44, 100]],
    [[60, 100, 44, 100, 60]],
    [[60, 100, 44, 100, 60, 100]],
  ] as const)('keeps one composer after the rapid resize prefix %j', async (widths) => {
    provider = await startMockProvider({ modelId: 'custom-default' });
    const startup = await launch(100);
    for (const width of widths) {
      await startup.resize(width);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    const rendered = startup.rendered();
    expect(startup.activeComposerCount(), rendered).toBe(1);
    expectCleanMainBuffer(startup);
  }, 45_000);

  it('replaces the owned viewport generation after a completed turn and wide-narrow-wide resize', async () => {
    provider = await startMockProvider({
      modelId: 'custom-default',
      responseText: 'COMPLETED RESIZE ANSWER',
      chunkDelayMs: 5,
    });
    const startup = await launch(100);
    startup.child.write('COMPLETED RESIZE PROMPT\r');
    await waitFor(
      () => startup.raw().split(COMPOSER_READY_TOKEN).length - 1 >= 2
        && startup.rendered().includes('COMPLETED RESIZE ANSWER'),
      () => startup.physicalBuffer(),
    );

    await startup.resize(44, 24);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await startup.resize(100, 50);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(startup.raw()).not.toContain('\x1b[?1049h');
    for (const marker of [
      'Environment',
      'Capabilities',
      'Built solo',
      'COMPLETED RESIZE PROMPT',
      'COMPLETED RESIZE ANSWER',
    ]) {
      expect(startup.reviewableHistory().match(new RegExp(marker, 'gu')) ?? [], marker).toHaveLength(1);
    }
    const current = startup.rendered();
    expect(startup.activeComposerCount(), current).toBe(1);
    expectCleanMainBuffer(startup);
  }, 45_000);

  it('keeps multiple completed turns reviewable through narrow-wide-narrow main-buffer reflow', async () => {
    const turns = [
      ['HISTORY PROMPT ONE', 'HISTORY ANSWER ONE'],
      ['HISTORY PROMPT TWO', 'HISTORY ANSWER TWO'],
      ['HISTORY PROMPT THREE', 'HISTORY ANSWER THREE'],
    ] as const;
    provider = await startMockProvider({
      modelId: 'custom-default',
      script: turns.map(([, content]) => ({ content })),
      chunkDelayMs: 5,
    });
    const startup = await launch(100);
    for (let index = 0; index < turns.length; index += 1) {
      const [prompt, answer] = turns[index];
      startup.child.write(`${prompt}\r`);
      await waitFor(
        () => startup.raw().split(COMPOSER_READY_TOKEN).length - 1 >= index + 2
          && startup.rendered().includes(answer),
        () => startup.physicalBuffer(),
      );
    }

    for (const width of [44, 100, 44]) {
      await startup.resize(width, 24);
      await new Promise((resolve) => setTimeout(resolve, 175));
    }

    expect(startup.raw()).not.toContain('\x1b[?1049h');
    for (const [prompt, answer] of turns) {
      expect(startup.reviewableHistory().match(new RegExp(prompt, 'gu')) ?? [], prompt).toHaveLength(1);
      expect(startup.reviewableHistory().match(new RegExp(answer, 'gu')) ?? [], answer).toHaveLength(1);
    }
    const current = startup.rendered();
    expect(startup.activeComposerCount(), current).toBe(1);
    expectCleanMainBuffer(startup);
  }, 60_000);
});
