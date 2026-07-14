import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { startMockProvider, type MockProvider } from '../harness/mockProvider';
import { COMPOSER_READY_TOKEN } from '../../../cli/v4/composerReadiness';

type RunningPty = ReturnType<typeof pty.spawn>;
let child: RunningPty | null = null;
let provider: MockProvider | null = null;
const cleanup: string[] = [];

function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function typeLikeKeyboard(terminal: RunningPty, text: string, submit = true): void {
  let index = 0;
  const next = (): void => {
    if (index < text.length) {
      terminal.write(text[index++]);
      setTimeout(next, 10);
    } else if (submit) {
      setTimeout(() => terminal.write('\r'), 100);
    }
  };
  next();
}

function pressDownThenEnter(terminal: RunningPty, count: number): void {
  let remaining = count;
  const next = (): void => {
    if (remaining-- > 0) {
      terminal.write('\x1b[B');
      setTimeout(next, 120);
    } else {
      setTimeout(() => terminal.write('\r'), 200);
    }
  };
  next();
}

afterEach(async () => {
  if (child) {
    try { child.kill(); } catch { /* already exited */ }
    child = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (provider) {
    await provider.stop();
    provider = null;
  }
  await Promise.all(cleanup.splice(0).map(
    (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
  ));
});

describe.skipIf(process.platform !== 'win32')('built CLI P2A/P2C acceptance', () => {
  it.each([
    { label: '600 ms', secondPromptDelayMs: 600 },
    { label: '10 seconds', secondPromptDelayMs: 10_000 },
  ])('isolates consecutive clarification with second-prompt input after $label', async ({ secondPromptDelayMs }) => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-built-accept-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-built-accept-cwd-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-built-accept-outside-'));
    cleanup.push(aidenHome, cwd, outside);
    const deniedPath = path.join(outside, 'must-not-exist.txt');

    provider = await startMockProvider({
      modelId: 'custom-default',
      chunkDelayMs: 5,
      script: [
        { toolCalls: [{
          id: 'q-format', name: 'clarify',
          arguments: { question: 'Which format?', options: ['Markdown', 'PDF'] },
        }] },
        { toolCalls: [{
          id: 'q-topic', name: 'clarify',
          arguments: { question: 'What topic?' },
        }] },
        { content: 'clarifications complete: PDF | P2A terminal ownership' },
      ],
    });

    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'acceptance\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:',
      '  provider: custom_openai',
      '  modelId: custom-default',
      'providers:',
      '  custom_openai:',
      '    apiKey: acceptance-key',
      'display:',
      '  streaming: true',
      '  renderer: legacy',
    ].join('\n') + '\n', 'utf8');

    const entry = path.join(repoRoot, 'dist/cli/v4/aidenCLI.js');
    const preload = path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs');
    child = pty.spawn(process.execPath, [
      '-r', preload, entry,
    ], {
      cwd,
      cols: 240,
      rows: 40,
      env: {
        ...process.env,
        AIDEN_HOME: aidenHome,
        AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl,
        CUSTOM_OPENAI_API_KEY: 'acceptance-key',
        AIDEN_NO_UPDATE_CHECK: '1',
        AIDEN_TEST_COMPOSER_READY: '1',
        TELEGRAM_BOT_TOKEN: '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });

    let output = '';
    let state = 'boot';
    let queueChecks = 0;
    let queueCommandSent = false;
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `built acceptance timeout (${state}, providerCalls=${provider?.callCount() ?? -1}):\n` +
        stripAnsi(output).slice(-12000),
      )), 75_000);
      child!.onData((chunk) => {
        output += chunk;
        const plain = stripAnsi(output);
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (state === 'boot' && readyCount >= 1) {
          state = 'first-select';
          setTimeout(() => typeLikeKeyboard(child!, 'Run consecutive clarification acceptance'), 500);
        }
        if (state === 'first-select' && plain.includes('Which format?')) {
          state = 'second-text';
          setTimeout(() => pressDownThenEnter(child!, 1), 500);
        }
        if (state === 'second-text' && plain.includes('What topic?')) {
          state = 'clarify-final';
          setTimeout(() => typeLikeKeyboard(child!, 'P2A terminal ownership'), secondPromptDelayMs);
        }
        if (state === 'clarify-final' && plain.includes('clarifications complete: PDF | P2A terminal ownership')) {
          state = 'queue-ready';
        }
        if (state === 'queue-ready' && readyCount >= 2) {
          state = 'queue-1';
          queueCommandSent = true;
          typeLikeKeyboard(child!, '/queue');
        }
        const emptyQueueCount = plain.match(/queue is empty/gi)?.length ?? 0;
        if (state === 'queue-1' && emptyQueueCount >= 1) {
          queueChecks += 1;
          state = 'done';
          clearTimeout(timeout);
          resolve();
        }
      });
      child!.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (state === 'done') return;
        if (exitCode === 0) resolve();
        else reject(new Error(`built acceptance exited ${exitCode} in ${state}:\n${stripAnsi(output).slice(-12000)}`));
      });
    });

    await completion;
    const plain = stripAnsi(output);
    expect(provider.callCount()).toBe(3);
    expect(queueCommandSent).toBe(true);
    expect(queueChecks).toBe(1);
    expect(plain).toContain('Which format? PDF');
    expect(plain).toContain('What topic? P2A terminal ownership');
    expect(plain).not.toMatch(/▲\s+partial text/);
    await expect(fs.access(deniedPath)).rejects.toThrow();
  }, 120_000);
});
