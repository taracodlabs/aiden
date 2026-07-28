/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';

import { COMPOSER_READY_TOKEN } from '../../../cli/v4/composerReadiness';
import { startMockProvider, type MockProvider } from '../harness/mockProvider';
import { TerminalScreen } from '../harness/terminalScreen';

type RunningPty = ReturnType<typeof pty.spawn>;
let child: RunningPty | null = null;
let provider: MockProvider | null = null;
const cleanup: string[] = [];

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function typeLine(terminal: RunningPty, value: string): void {
  terminal.write(`${value}\r`);
}

function occurrence(lines: string[], value: string): number {
  return lines.filter((line) => line.includes(value)).length;
}

function assertClearedFrame(screen: TerminalScreen, oldRows: readonly string[]): void {
  const frame = screen.snapshot();
  for (const old of oldRows) expect(frame, `stale row: ${old}\n${frame}`).not.toContain(old);
  const lines = screen.lines();
  const composerTop = lines.findIndex((line) => line.includes('▲ You'));
  expect(composerTop, frame).toBeGreaterThanOrEqual(0);
  expect(occurrence(lines, '▲ You'), frame).toBe(1);
  expect(occurrence(lines, '◆'), frame).toBe(1);
  expect(lines.at(-1), frame).toContain('◆');
  expect(lines.slice(0, composerTop).every((line) => line === ''), frame).toBe(true);
  expect(screen.cursorPosition().row, frame).toBe(composerTop + 1);
}

afterEach(async () => {
  if (child) {
    try { child.kill(); } catch { /* already exited */ }
    child = null;
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

describe.skipIf(process.platform !== 'win32')('built CLI physical viewport epoch', () => {
  it.each([100, 44])('keeps pre-/cls rows hidden across resize and later repaint at %i columns', async (columns) => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-viewport-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-viewport-cwd-'));
    cleanup.push(aidenHome, cwd);
    provider = await startMockProvider({
      modelId: 'custom-default',
      responseText: 'VIEWPORT RESPONSE',
      chunkDelayMs: 5,
    });
    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'viewport\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:', '  provider: custom_openai', '  modelId: custom-default',
      'providers:', '  custom_openai:', '    apiKey: viewport-key',
      'display:', '  streaming: true', '  renderer: frame',
    ].join('\n') + '\n', 'utf8');

    const screen = new TerminalScreen(columns, 35);
    const preloadPath = path.join(
      repoRoot,
      'tests/v4/harness',
      process.env.AIDEN_TEST_INSTALLED_ROOT
        ? 'installedProviderPreload.cjs'
        : 'builtProviderPreload.cjs',
    );
    const cliPath = process.env.AIDEN_TEST_CLI_PATH
      ? path.resolve(process.env.AIDEN_TEST_CLI_PATH)
      : path.join(repoRoot, 'dist/cli/v4/aidenCLI.js');
    const command = ['&', quotePowerShellLiteral(process.execPath), '-r',
      quotePowerShellLiteral(preloadPath), quotePowerShellLiteral(cliPath)].join(' ');
    child = pty.spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
    ], {
      cwd, cols: columns, rows: 35,
      env: {
        ...process.env,
        AIDEN_HOME: aidenHome,
        AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl,
        CUSTOM_OPENAI_API_KEY: 'viewport-key',
        AIDEN_NO_UPDATE_CHECK: '1',
        AIDEN_TEST_COMPOSER_READY: '1',
        AIDEN_RENDERER: 'frame',
        TELEGRAM_BOT_TOKEN: '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });

    const oldRows = ['FIRST VIEWPORT TURN', 'SECOND VIEWPORT TURN', 'Available themes:', 'AIDEN'];
    let raw = '';
    let state = 'boot';
    let clearStart = 0;
    await new Promise<void>((resolve, reject) => {
      let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => reject(new Error(
        `viewport PTY timeout (${state}, calls=${provider?.callCount() ?? -1})\n${screen.snapshot()}\nRAW:\n${raw.slice(-5000)}`,
      )), 60_000);
      const fail = (error: unknown): void => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = null;
        reject(error);
      };
      const later = (fn: () => void, ms: number): void => {
        setTimeout(() => {
          try { fn(); } catch (error) { fail(error); }
        }, ms);
      };
      const dataSubscription = child!.onData((chunk) => {
        raw += chunk;
        screen.write(chunk);
        const readyCount = raw.split(COMPOSER_READY_TOKEN).length - 1;
        const frame = screen.snapshot();
        if (state === 'boot' && readyCount >= 1) {
          state = 'first';
          later(() => typeLine(child!, 'FIRST VIEWPORT TURN'), 100);
        } else if (state === 'first' && readyCount >= 2 && frame.includes('VIEWPORT RESPONSE')) {
          state = 'second';
          later(() => typeLine(child!, 'SECOND VIEWPORT TURN'), 100);
        } else if (state === 'second' && readyCount >= 3 && frame.includes('SECOND VIEWPORT TURN')) {
          state = 'theme';
          later(() => typeLine(child!, '/theme list'), 100);
        } else if (state === 'theme' && readyCount >= 4 && frame.includes('Available themes:')) {
          state = 'clear';
          clearStart = raw.length;
          later(() => typeLine(child!, '/cls'), 100);
        } else if (state === 'clear' && readyCount >= 5
          && raw.slice(clearStart).includes('\x1b[3J')
          && raw.slice(clearStart).includes('\x1b[2J')
          && raw.slice(clearStart).includes('\x1b[H')) {
          state = 'cleared';
          later(() => {
            assertClearedFrame(screen, oldRows);
            const nextColumns = columns === 100 ? 44 : 100;
            child!.resize(nextColumns, 24);
            screen.resize(nextColumns, 24);
            later(() => {
              assertClearedFrame(screen, oldRows);
              child!.resize(columns, 35);
              screen.resize(columns, 35);
              later(() => {
                assertClearedFrame(screen, oldRows);
                state = 'after';
                typeLine(child!, 'AFTER VIEWPORT CLEAR');
              }, 1_200);
            }, 1_200);
          }, 1_200);
        } else if (state === 'after' && readyCount >= 6
          && frame.includes('AFTER VIEWPORT CLEAR') && frame.includes('VIEWPORT RESPONSE')
          && !frame.includes('queue mode')) {
          try {
            for (const old of oldRows) expect(frame).not.toContain(old);
            expect(occurrence(screen.lines(), 'AFTER VIEWPORT CLEAR')).toBe(1);
            expect(provider?.callCount()).toBe(3);
            const thirdRequest = provider?.requests()[2] as {
              messages?: Array<{ content?: unknown }>;
            } | undefined;
            const retainedContext = JSON.stringify(thirdRequest?.messages ?? []);
            expect(retainedContext).toContain('FIRST VIEWPORT TURN');
            expect(retainedContext).toContain('SECOND VIEWPORT TURN');
            expect(retainedContext).toContain('AFTER VIEWPORT CLEAR');
            state = 'exit';
            later(() => typeLine(child!, '/quit'), 100);
          } catch (error) { fail(error); }
        }
      });
      const exitSubscription = child!.onExit(({ exitCode }) => {
        dataSubscription.dispose();
        exitSubscription.dispose();
        if (watchdog) clearTimeout(watchdog);
        watchdog = null;
        child = null;
        if (state === 'exit' && exitCode === 0) resolve();
        else reject(new Error(
          `viewport PTY exited ${exitCode} in ${state}\n${screen.snapshot()}\nRAW:\n${raw.slice(-5000)}`,
        ));
      });
    });
  }, 90_000);
});
