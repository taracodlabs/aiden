import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';

import { COMPOSER_READY_TOKEN } from '../../../cli/v4/composerReadiness';
import { startMockProvider, type MockProvider } from '../harness/mockProvider';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidth: (value: string) => number = require('string-width');

type RunningPty = ReturnType<typeof pty.spawn>;
const children: RunningPty[] = [];
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

async function launch(columns: number, paused = false): Promise<{
  child: RunningPty;
  raw: () => string;
  plain: () => string;
}> {
  const repoRoot = path.resolve(__dirname, '../../..');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `aiden-startup-${columns}-home-`));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `aiden-startup-${columns}-cwd-`));
  cleanup.push(home, cwd);
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
      TELEGRAM_BOT_TOKEN: '',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
  children.push(child);
  let output = '';
  child.onData((chunk) => { output += chunk; });
  await waitFor(
    () => output.includes(COMPOSER_READY_TOKEN),
    () => stripAnsi(output),
  );
  return { child, raw: () => output, plain: () => stripAnsi(output) };
}

function dashboardLines(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('█████╗') || /^\s*AIDEN\s*$/.test(line));
  const end = lines.findIndex((line, index) => index >= start && /Type (?:your message|· \/help)/.test(line));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch { /* already exited */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (provider) {
    await provider.stop();
    provider = null;
  }
  await Promise.all(cleanup.splice(0).map(
    (directory) => fs.rm(directory, { recursive: true, force: true }).catch(() => undefined),
  ));
});

describe.skipIf(process.platform !== 'win32')('built CLI responsive startup dashboard', () => {
  it('selects wide, medium, and narrow transcript tiers without resize duplication', async () => {
    provider = await startMockProvider({ modelId: 'custom-default' });

    const wide = await launch(120, true);
    const wideBeforeResize = wide.plain();
    expect(wideBeforeResize).toContain('Environment');
    expect(wideBeforeResize).toContain('Capabilities');
    expect(wideBeforeResize).toContain('Built solo');
    expect(wideBeforeResize).toContain('╭');
    expect(wideBeforeResize).toMatch(/trust\s+Assistant/i);
    expect(wideBeforeResize).toContain('custom-default');
    expect(wideBeforeResize).toMatch(/\d+ loaded/);
    expect(wideBeforeResize).toContain('spawn-pause: ON');
    expect(wide.raw().split(COMPOSER_READY_TOKEN)).toHaveLength(2);
    for (const line of dashboardLines(wideBeforeResize)) {
      expect(stringWidth(line), line).toBeLessThanOrEqual(118);
    }

    const logoCount = (wideBeforeResize.match(/Autonomous AI Engine/g) ?? []).length;
    wide.child.resize(48, 50);
    await new Promise((resolve) => setTimeout(resolve, 250));
    wide.child.resize(120, 50);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((wide.plain().match(/Autonomous AI Engine/g) ?? []).length).toBe(logoCount);
    // ConPTY may replay visible bottom rows while reflowing its screen buffer;
    // the typographic anchor is above that window and detects an actual second
    // application startup render. The unit integration test separately proves
    // the startup renderer owns no resize listener or repaint callback.

    const medium = await launch(80);
    expect(medium.plain()).toContain('Environment');
    expect(medium.plain()).toContain('Capabilities');
    expect(medium.plain()).toContain('github.com/taracodlabs/aiden');
    expect(medium.plain()).not.toContain('╭');
    for (const line of dashboardLines(medium.plain())) {
      expect(stringWidth(line), line).toBeLessThanOrEqual(78);
    }

    const narrow = await launch(48);
    expect(narrow.plain()).toMatch(/\bAIDEN\b/);
    expect(narrow.plain()).toMatch(/Assistant\s+·\s+custom-default/i);
    expect(narrow.plain()).toMatch(/built solo/i);
    expect(narrow.plain()).not.toContain('Environment');
    expect(narrow.plain()).not.toContain('Capabilities');
    expect(narrow.plain()).not.toContain('╭');
    for (const line of dashboardLines(narrow.plain())) {
      expect(stringWidth(line), line).toBeLessThanOrEqual(46);
    }
  }, 75_000);
});
