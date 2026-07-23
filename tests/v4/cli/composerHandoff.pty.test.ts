import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { startMockProvider, type MockProvider, type MockProviderTurn } from '../harness/mockProvider';
import { COMPOSER_READY_TOKEN } from '../../../cli/v4/composerReadiness';

type RunningPty = ReturnType<typeof pty.spawn>;
let child: RunningPty | null = null;
let provider: MockProvider | null = null;
const cleanup: string[] = [];

async function spawnBuiltCli(
  script: MockProviderTurn[],
  chunkDelayMs = 5,
  headerDelayMs = 0,
): Promise<{
  terminal: RunningPty;
  output: () => string;
  diagnostics: () => Promise<string>;
  cwd: string;
}> {
  const repoRoot = path.resolve(__dirname, '../../..');
  const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-handoff-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-handoff-cwd-'));
  const diagnosticPath = path.join(aidenHome, 'turn-idle.jsonl');
  cleanup.push(aidenHome, cwd);
  provider = await startMockProvider({ modelId: 'custom-default', chunkDelayMs, headerDelayMs, script });
  await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'handoff\n', 'utf8');
  await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
    'model:',
    '  provider: custom_openai',
    '  modelId: custom-default',
    'providers:',
    '  custom_openai:',
    '    apiKey: handoff-key',
    'display:',
    '  streaming: true',
    '  renderer: legacy',
  ].join('\n') + '\n', 'utf8');
  child = pty.spawn(process.execPath, [
    '-r', path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs'),
    path.join(repoRoot, 'dist/cli/v4/aidenCLI.js'),
  ], {
    cwd,
    cols: 200,
    rows: 40,
    env: {
      ...process.env,
      AIDEN_HOME: aidenHome,
      AIDEN_TEST_REPO_ROOT: repoRoot,
      AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl,
      CUSTOM_OPENAI_API_KEY: 'handoff-key',
      AIDEN_NO_UPDATE_CHECK: '1',
      AIDEN_TEST_COMPOSER_READY: '1',
      AIDEN_TEST_TURN_IDLE_DIAG: '1',
      AIDEN_TEST_TURN_IDLE_DIAG_FILE: diagnosticPath,
      TELEGRAM_BOT_TOKEN: '',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
  let output = '';
  child.onData((chunk) => { output += chunk; });
  return {
    terminal: child,
    output: () => output,
    diagnostics: () => fs.readFile(diagnosticPath, 'utf8'),
    cwd,
  };
}

function typeLikeKeyboard(terminal: RunningPty, text: string, submitDelayMs = 100): void {
  let index = 0;
  const writeNext = (): void => {
    if (index < text.length) {
      terminal.write(text[index++]);
      setTimeout(writeNext, 12);
    } else {
      setTimeout(() => terminal.write('\r'), submitDelayMs);
    }
  };
  writeNext();
}

function pressDownThenEnter(terminal: RunningPty, count: number): void {
  let remaining = count;
  const next = (): void => {
    if (remaining > 0) {
      remaining -= 1;
      terminal.write('\x1b[B');
      setTimeout(next, 80);
    } else {
      terminal.write('\r');
    }
  };
  next();
}

function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

afterEach(async () => {
  if (child) {
    try { child.kill(); } catch { /* already exited */ }
    child = null;
  }
  if (provider) {
    await provider.stop();
    provider = null;
  }
  await Promise.all(cleanup.splice(0).map(
    (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
  ));
});

describe.skipIf(process.platform !== 'win32')('built CLI turn-to-composer handoff', () => {
  it('accepts three consecutive immediate submissions without a wake-up Enter', async () => {
    const runtime = await spawnBuiltCli([
      { content: 'FIRST' },
      { content: 'SECOND' },
      { content: 'THIRD' },
    ]);
    let firstSent = false;
    let secondSent = false;
    let thirdSent = false;
    let queueSent = false;
    const completion = new Promise<void>((resolve, reject) => {
      let checker: ReturnType<typeof setInterval>;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (error?: Error): void => {
        clearInterval(checker);
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      timeout = setTimeout(() => finish(new Error(
        `handoff timeout (calls=${provider?.callCount() ?? -1}):\n${stripAnsi(runtime.output()).slice(-8000)}`,
      )), 20_000);
      const check = (): void => {
        const output = runtime.output();
        const markerReadyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        const diagnosticReadyCount = output.split('"event":"composer.ready"').length - 1;
        const readyCount = Math.max(markerReadyCount, diagnosticReadyCount);
        const plain = stripAnsi(output);
        if (!firstSent && readyCount >= 1) {
          firstSent = true;
          typeLikeKeyboard(child!, 'Reply with exactly: FIRST');
        }
        if (!secondSent && readyCount >= 2 && plain.includes('FIRST')) {
          secondSent = true;
          // Deliberately send the printable key with no wake-up Enter.
          typeLikeKeyboard(child!, 'Reply with exactly: SECOND', 0);
        }
        if (!thirdSent && readyCount >= 3 && plain.includes('SECOND')) {
          thirdSent = true;
          typeLikeKeyboard(child!, 'Reply with exactly: THIRD', 0);
        }
        if (!queueSent && readyCount >= 4 && plain.includes('THIRD') && provider?.callCount() === 3) {
          queueSent = true;
          typeLikeKeyboard(child!, '/queue', 0);
        }
        if (queueSent && /queue is empty/i.test(plain) && provider?.callCount() === 3) {
          finish();
        }
      };
      checker = setInterval(check, 10);
      child!.onData(check);
      child!.onExit(({ exitCode }) => {
        finish(new Error(`handoff child exited ${exitCode}:\n${stripAnsi(runtime.output()).slice(-8000)}`));
      });
    });

    await completion;
    expect(provider.callCount()).toBe(3);
    const plain = stripAnsi(runtime.output());
    expect(plain).toContain('Reply with exactly: SECOND');
    expect(plain).toContain('Reply with exactly: THIRD');
    expect(plain).toMatch(/queue is empty/i);
    const diagnostics = await runtime.diagnostics();
    const generations = [...diagnostics.matchAll(/"event":"composer\.ready".{0,700}?"generation":(\d+)/g)]
      .map((match) => Number(match[1]));
    expect(generations.length).toBeGreaterThanOrEqual(3);
    expect(new Set(generations).size).toBe(generations.length);
    const thirdReadyAt = diagnostics.search(/"event":"composer\.ready".{0,700}"generation":3/);
    const thirdKeyAt = diagnostics.indexOf('"generation":3,"key":"r"');
    const thirdEnterAt = diagnostics.indexOf('"generation":3,"key":"enter"');
    expect(thirdReadyAt).toBeGreaterThanOrEqual(0);
    expect(thirdKeyAt).toBeGreaterThan(thirdReadyAt);
    expect(thirdEnterAt).toBeGreaterThan(thirdKeyAt);
  }, 30_000);

  it('treats the first empty Enter as a real submission boundary', async () => {
    const runtime = await spawnBuiltCli([{ content: 'AFTER EMPTY' }]);
    let emptySent = false;
    let promptSent = false;
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `empty-enter timeout (calls=${provider?.callCount() ?? -1}):\n${stripAnsi(runtime.output()).slice(-8000)}`,
      )), 20_000);
      child!.onData(() => {
        const output = runtime.output();
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        const plain = stripAnsi(output);
        if (!emptySent && readyCount >= 1) {
          emptySent = true;
          child!.write('\r');
        }
        if (!promptSent && readyCount >= 2) {
          expect(provider?.callCount()).toBe(0);
          promptSent = true;
          typeLikeKeyboard(child!, 'Reply after empty Enter', 0);
        }
        if (plain.includes('AFTER EMPTY') && provider?.callCount() === 1) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await completion;
    expect(provider.callCount()).toBe(1);
  }, 30_000);

  it('hands off immediately after a tool turn with no stale activity timer', async () => {
    const runtime = await spawnBuiltCli([
      { toolCalls: [{
        id: 'read-one', name: 'file_read', arguments: { path: 'fixture.txt' },
      }] },
      { content: 'TOOL COMPLETE' },
      { content: 'NEXT COMPLETE' },
    ]);
    await fs.writeFile(path.join(runtime.cwd, 'fixture.txt'), 'fixture\n', 'utf8');

    let firstSent = false;
    let nextSent = false;
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `tool handoff timeout (calls=${provider?.callCount() ?? -1}):\n${stripAnsi(runtime.output()).slice(-10000)}`,
      )), 25_000);
      child!.onData(() => {
        const output = runtime.output();
        const plain = stripAnsi(output);
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (!firstSent && readyCount >= 1) {
          firstSent = true;
          typeLikeKeyboard(child!, 'Read fixture.txt and report completion');
        }
        if (!nextSent && readyCount >= 2 && plain.includes('TOOL COMPLETE')) {
          nextSent = true;
          typeLikeKeyboard(child!, 'Reply with exactly: NEXT COMPLETE', 0);
        }
        if (provider?.callCount() === 3 && plain.includes('NEXT COMPLETE')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await completion;
    const diagnosticOutput = await runtime.diagnostics();
    const finalReadyIndex = diagnosticOutput.lastIndexOf('"event":"composer.ready"');
    expect(finalReadyIndex).toBeGreaterThan(0);
    expect(diagnosticOutput.slice(finalReadyIndex).includes('"event":"activity.row.timer"')).toBe(false);
    const readStartIndex = diagnosticOutput.lastIndexOf('"event":"composer.read.start"');
    expect(readStartIndex).toBeGreaterThan(0);
    const readStart = diagnosticOutput.slice(readStartIndex, readStartIndex + 1_000);
    expect(readStart).toContain('"activityCount":0');
    expect(readStart).toContain('"activityTimers":0');
  }, 35_000);

  it('hands off immediately after an interrupted provider turn', async () => {
    const runtime = await spawnBuiltCli([
      { content: 'SLOW RESPONSE' },
      { content: 'AFTER INTERRUPT' },
    ], 5, 5_000);
    let firstSent = false;
    let interrupted = false;
    let nextSent = false;
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `interrupt handoff timeout (calls=${provider?.callCount() ?? -1}):\n${stripAnsi(runtime.output()).slice(-10000)}`,
      )), 30_000);
      child!.onData(() => {
        const output = runtime.output();
        const plain = stripAnsi(output);
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (!firstSent && readyCount >= 1) {
          firstSent = true;
          typeLikeKeyboard(child!, 'Start a slow response');
        }
        if (!interrupted && provider?.callCount() === 1) {
          interrupted = true;
          setTimeout(() => child!.write('\x03'), 200);
        }
        if (!nextSent && readyCount >= 2 && plain.includes('(turn interrupted)')) {
          nextSent = true;
          typeLikeKeyboard(child!, 'Reply with exactly: AFTER INTERRUPT', 0);
        }
        if (provider?.callCount() === 2 && plain.includes('AFTER INTERRUPT')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await completion;
    expect(stripAnsi(runtime.output())).toContain('(turn interrupted)');
    expect(provider.callCount()).toBe(2);
  }, 40_000);

  it('hands off immediately after a denied approval without key leakage', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-handoff-outside-'));
    cleanup.push(outside);
    const deniedPath = path.join(outside, 'must-not-exist.txt');
    const runtime = await spawnBuiltCli([
      { toolCalls: [{
        id: 'write-one', name: 'file_write',
        arguments: { path: deniedPath, content: 'must not be written' },
      }] },
      { content: 'DENIAL COMPLETE' },
      { content: 'AFTER APPROVAL' },
    ]);
    let firstSent = false;
    let denied = false;
    let nextSent = false;
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `approval handoff timeout (calls=${provider?.callCount() ?? -1}):\n${stripAnsi(runtime.output()).slice(-10000)}`,
      )), 30_000);
      child!.onData(() => {
        const output = runtime.output();
        const plain = stripAnsi(output);
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (!firstSent && readyCount >= 1) {
          firstSent = true;
          typeLikeKeyboard(child!, 'Write the requested file');
        }
        if (!denied && plain.includes('Decision')) {
          denied = true;
          setTimeout(() => pressDownThenEnter(child!, 3), 200);
        }
        if (!nextSent && readyCount >= 2 && plain.includes('DENIAL COMPLETE')) {
          nextSent = true;
          typeLikeKeyboard(child!, 'Reply with exactly: AFTER APPROVAL', 0);
        }
        if (provider?.callCount() === 3 && plain.includes('AFTER APPROVAL')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await completion;
    await expect(fs.access(deniedPath)).rejects.toThrow();
    expect(provider.callCount()).toBe(3);
  }, 40_000);
});
