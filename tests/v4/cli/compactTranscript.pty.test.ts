/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { startMockProvider, type MockProvider } from '../harness/mockProvider';
import { COMPOSER_READY_TOKEN } from '../../../cli/v4/composerReadiness';
import { TerminalScreen } from '../harness/terminalScreen';
import { killPtyIfRunning } from '../harness/ptyProcessLifecycle';

type RunningPty = ReturnType<typeof pty.spawn>;
let child: RunningPty | null = null;
let provider: MockProvider | null = null;
const cleanup: string[] = [];

function typeLine(terminal: RunningPty, value: string): void {
  terminal.write(value);
  terminal.write('\r');
}

function processTableContains(pid: number): boolean {
  const rows = execFileSync(
    'tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true },
  );
  return new RegExp(`^"[^"]+","${pid}",`, 'm').test(rows);
}

function semanticGap(frame: string, before: string, after: string): number {
  const lines = frame.split('\n');
  const beforeRow = lines.findLastIndex((line) => line.includes(before));
  const afterRow = lines.findLastIndex((line) => line.includes(after));
  expect(beforeRow, `missing ${before}\n${frame}`).toBeGreaterThanOrEqual(0);
  expect(afterRow, `missing ${after}\n${frame}`).toBeGreaterThan(beforeRow);
  return afterRow - beforeRow - 1;
}

afterEach(async () => {
  if (child) {
    try { killPtyIfRunning(child); } catch { /* already exited */ }
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

describe.skipIf(process.platform !== 'win32')('built CLI compact hybrid transcript', () => {
  it.each([100, 44])('keeps prompt and provider activity adjacent at %i columns across live height changes', async (columns) => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-compact-transcript-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-compact-transcript-cwd-'));
    cleanup.push(aidenHome, cwd);
    provider = await startMockProvider({
      modelId: 'custom-default',
      headerDelayMs: 8_000,
      responseText: 'COMPACT TRANSCRIPT COMPLETE',
      chunkDelayMs: 5,
    });
    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'compact-transcript\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:', '  provider: custom_openai', '  modelId: custom-default',
      'providers:', '  custom_openai:', '    apiKey: compact-transcript-key',
      'display:', '  streaming: true', '  renderer: frame',
    ].join('\n') + '\n', 'utf8');

    const screen = new TerminalScreen(columns, 60);
    const preloadPath = path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs');
    const cliPath = path.join(repoRoot, 'dist/cli/v4/aidenCLI.js');
    child = pty.spawn(process.execPath, ['-r', preloadPath, cliPath], {
      cwd, cols: columns, rows: 60,
      env: {
        ...process.env,
        AIDEN_HOME: aidenHome,
        AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl,
        CUSTOM_OPENAI_API_KEY: 'compact-transcript-key',
        AIDEN_NO_UPDATE_CHECK: '1',
        AIDEN_TEST_COMPOSER_READY: '1',
        AIDEN_RENDERER: 'frame',
        TELEGRAM_BOT_TOKEN: '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });

    let raw = '';
    let state = 'boot';
    const frames = new Map<number, string>();
    const heights = [60, 45, 35, 24, 16];
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let exitProbe: ReturnType<typeof setInterval> | null = null;
      let settled = false;
      let observedProcessExitAt: number | null = null;
      let dataSubscription: { dispose(): void } | null = null;
      let exitSubscription: { dispose(): void } | null = null;
      const childPid = child!.pid;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (exitProbe) clearInterval(exitProbe);
        dataSubscription?.dispose();
        exitSubscription?.dispose();
        child = null;
        if (error) reject(error);
        else resolve();
      };
      const observeChildExit = (): void => {
        if (exitProbe) return;
        // Repeated ConPTY resizes can occasionally lose the adapter's exit
        // callback. Verify the built CLI process disappeared directly, while
        // requiring its clean Goodbye boundary so a crash cannot pass.
        exitProbe = setInterval(() => {
          try {
            if (processTableContains(childPid)) return;
            if (raw.includes('Goodbye.')) {
              finish();
              return;
            }
            observedProcessExitAt ??= Date.now();
            if (Date.now() - observedProcessExitAt < 1_500) return;
            finish(new Error('compact transcript process exited before clean CLI shutdown output drained'));
          } catch (error) {
            finish(error as Error);
          }
        }, 250);
      };
      const armTimeout = (ms: number): void => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => finish(new Error(
          `compact transcript timeout (${state}, calls=${provider?.callCount() ?? -1}):\n${screen.snapshot()}\nRAW:\n${raw.slice(-4000)}`,
        )), ms);
      };
      armTimeout(30_000);
      dataSubscription = child!.onData((chunk) => {
        raw += chunk;
        screen.write(chunk);
        const readyCount = raw.split(COMPOSER_READY_TOKEN).length - 1;
        const rendered = screen.snapshot();
        if (state === 'boot' && readyCount >= 1) {
          state = 'provider';
          armTimeout(20_000);
          setTimeout(() => typeLine(child!, 'COMPACT HEIGHT REQUEST'), 250);
        } else if (state === 'provider' && rendered.includes('Aiden is thinking')) {
          state = 'resizing';
          armTimeout(20_000);
          let index = 0;
          const capture = (): void => {
            const rows = heights[index]!;
            if (index > 0) {
              child!.resize(columns, rows);
              screen.resize(columns, rows);
            }
            setTimeout(() => {
              frames.set(rows, screen.snapshot());
              index += 1;
              if (index < heights.length) capture();
              else {
                state = 'response';
                armTimeout(20_000);
              }
            }, 150);
          };
          capture();
        } else if (state === 'response' && rendered.includes('COMPACT TRANSCRIPT COMPLETE') && readyCount >= 2) {
          state = 'exit';
          armTimeout(20_000);
          observeChildExit();
          setTimeout(() => typeLine(child!, '/quit'), 250);
        }
      });
      exitSubscription = child!.onExit(({ exitCode }) => {
        if (state === 'exit' && exitCode === 0) finish();
        else finish(new Error(`compact transcript exited ${exitCode} in ${state}`));
      });
    });

    expect([...frames.keys()]).toEqual(heights);
    for (const [rows, frame] of frames) {
      expect(semanticGap(frame, 'COMPACT HEIGHT REQUEST', 'Aiden is thinking'), `${rows} rows\n${frame}`)
        .toBeLessThanOrEqual(1);
    }
  }, 90_000);
});
