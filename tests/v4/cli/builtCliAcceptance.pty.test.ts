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
  it('does not repaint or continue the provider after approval Ctrl+C', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-approval-cancel-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-approval-cancel-cwd-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-approval-cancel-outside-'));
    cleanup.push(aidenHome, cwd, outside);
    const blockedPath = path.join(outside, 'approval-cancelled.txt');
    provider = await startMockProvider({
      modelId: 'custom-default', chunkDelayMs: 5,
      script: [
        { toolCalls: [{ id: 'cancel-shell', name: 'shell_exec', arguments: {
          command: `Set-Content -LiteralPath '${blockedPath.replace(/'/g, "''")}' -Value blocked`,
        } }] },
        { content: 'UNEXPECTED PROVIDER CONTINUATION' },
      ],
    });
    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'approval-cancel\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:', '  provider: custom_openai', '  modelId: custom-default',
      'providers:', '  custom_openai:', '    apiKey: approval-cancel-key',
      'display:', '  streaming: true', '  renderer: legacy',
    ].join('\n') + '\n', 'utf8');
    child = pty.spawn(process.execPath, [
      '-r', path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs'),
      path.join(repoRoot, 'dist/cli/v4/aidenCLI.js'),
    ], {
      cwd, cols: 100, rows: 40,
      env: { ...process.env, AIDEN_HOME: aidenHome, AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl, CUSTOM_OPENAI_API_KEY: 'approval-cancel-key',
        AIDEN_NO_UPDATE_CHECK: '1', AIDEN_TEST_COMPOSER_READY: '1', TELEGRAM_BOT_TOKEN: '',
        FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let output = '';
    let state = 'boot';
    let interruptedAt = 0;
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `approval cancellation timeout (${state}):\n${stripAnsi(output).slice(-12000)}`,
      )), 45_000);
      child!.onData((chunk) => {
        output += chunk;
        const plain = stripAnsi(output);
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (state === 'boot' && readyCount >= 1) {
          state = 'approval';
          typeLikeKeyboard(child!, 'request approval then cancel');
        } else if (state === 'approval' && plain.includes('Decision')) {
          state = 'cancelled';
          interruptedAt = output.length;
          child!.write('\x03');
        } else if (state === 'cancelled' && plain.includes('Cancelled') && readyCount >= 2) {
          state = 'queue';
          typeLikeKeyboard(child!, '/queue');
        } else if (state === 'queue' && /queue is empty/i.test(plain)) {
          state = 'done';
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await completion;
    const afterInterrupt = stripAnsi(output.slice(interruptedAt));
    expect(afterInterrupt).not.toContain('calling provider');
    expect(afterInterrupt).not.toContain('UNEXPECTED PROVIDER CONTINUATION');
    expect(afterInterrupt).toContain('(turn interrupted)');
    expect(afterInterrupt).toContain('Cancelled');
    expect(afterInterrupt).toContain('queue is empty');
    expect(provider.callCount()).toBe(1);
    await expect(fs.access(blockedPath)).rejects.toThrow();
  }, 55_000);

  it('keeps provider activity bounded through resize and approval handoff', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-resize-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-resize-cwd-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-resize-outside-'));
    cleanup.push(aidenHome, cwd, outside);
    const deniedPath = path.join(outside, 'resize-denied.txt');
    provider = await startMockProvider({
      modelId: 'custom-default', headerDelayMs: 3_000, chunkDelayMs: 5,
      script: [
        { toolCalls: [{ id: 'resize-shell', name: 'shell_exec', arguments: {
          command: `Set-Content -LiteralPath '${deniedPath.replace(/'/g, "''")}' -Value denied`,
        } }] },
        { content: 'RESIZE APPROVAL COMPLETE' },
        { content: 'NORMAL AFTER RESIZE' },
      ],
    });
    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'resize\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:', '  provider: custom_openai', '  modelId: custom-default',
      'providers:', '  custom_openai:', '    apiKey: resize-key',
      'display:', '  streaming: true', '  renderer: legacy',
    ].join('\n') + '\n', 'utf8');
    child = pty.spawn(process.execPath, [
      '-r', path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs'),
      path.join(repoRoot, 'dist/cli/v4/aidenCLI.js'),
    ], {
      cwd, cols: 120, rows: 40,
      env: { ...process.env, AIDEN_HOME: aidenHome, AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl, CUSTOM_OPENAI_API_KEY: 'resize-key',
        AIDEN_NO_UPDATE_CHECK: '1', AIDEN_TEST_COMPOSER_READY: '1', TELEGRAM_BOT_TOKEN: '',
        FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let output = '';
    let state = 'boot';
    let modalStart = 0;
    let modalEnd = 0;
    const providerAnimationPrefixes: string[] = [];
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `resize acceptance timeout (${state}):\n${stripAnsi(output).slice(-12000)}`,
      )), 50_000);
      child!.onData((chunk) => {
        if (state === 'provider' || state === 'resizing') {
          for (const line of stripAnsi(chunk).split(/\r?\n/)) {
            const match = line.match(/([─█◐◓◑◒ ]+)calling provider/);
            if (match) providerAnimationPrefixes.push(match[1].trim());
          }
        }
        output += chunk;
        const plain = stripAnsi(output);
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (state === 'boot' && readyCount >= 1) {
          state = 'provider';
          typeLikeKeyboard(child!, 'request resize approval');
        } else if (state === 'provider' && plain.includes('calling provider')) {
          state = 'resizing';
          setTimeout(() => child!.resize(44, 40), 500);
          setTimeout(() => child!.resize(110, 40), 1_700);
        } else if (state === 'resizing' && plain.includes('Decision')) {
          state = 'denying';
          modalStart = output.length;
          setTimeout(() => {
            modalEnd = output.length;
            pressDownThenEnter(child!, 1);
          }, 350);
        } else if (state === 'denying' && plain.includes('RESIZE APPROVAL COMPLETE') && readyCount >= 2) {
          state = 'normal';
          typeLikeKeyboard(child!, 'normal after resize');
        } else if (state === 'normal' && plain.includes('NORMAL AFTER RESIZE') && readyCount >= 3) {
          state = 'queue';
          typeLikeKeyboard(child!, '/queue');
        } else if (state === 'queue' && /queue is empty/i.test(plain)) {
          state = 'done';
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await completion;
    const plain = stripAnsi(output);
    expect(provider.callCount()).toBe(3);
    expect(new Set(providerAnimationPrefixes).size).toBeGreaterThanOrEqual(2);
    expect(stripAnsi(output.slice(modalStart, modalEnd))).not.toContain('calling provider');
    expect(plain).not.toContain('[preflight]');
    expect(plain).toContain('queue is empty');
    await expect(fs.access(deniedPath)).rejects.toThrow();
  }, 60_000);

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
