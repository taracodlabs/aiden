import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { startMockProvider, type MockProvider } from '../harness/mockProvider';
import { COMPOSER_READY_TOKEN } from '../../../cli/v4/composerReadiness';
import { TerminalScreen } from '../harness/terminalScreen';

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

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
    { label: 'normal width', columns: 100 },
    { label: 'narrow width', columns: 44 },
  ])('keeps idle typing exclusively inside the fixed composer at $label', async ({ columns }) => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-idle-footer-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-idle-footer-cwd-'));
    cleanup.push(aidenHome, cwd);
    provider = await startMockProvider({
      modelId: 'custom-default',
      script: [{ content: 'IDLE OWNER RESPONSE' }],
    });
    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'idle-footer\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:', '  provider: custom_openai', '  modelId: custom-default',
      'providers:', '  custom_openai:', '    apiKey: idle-footer-key',
      'display:', '  streaming: true', '  renderer: legacy',
    ].join('\n') + '\n', 'utf8');

    const rows = 30;
    const screen = new TerminalScreen(columns, rows);
    const preloadPath = path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs');
    const cliPath = path.join(repoRoot, 'dist/cli/v4/aidenCLI.js');
    const powerShellCommand = [
      '&',
      quotePowerShellLiteral(process.execPath),
      '-r',
      quotePowerShellLiteral(preloadPath),
      quotePowerShellLiteral(cliPath),
    ].join(' ');
    child = pty.spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powerShellCommand,
    ], {
      cwd, cols: columns, rows,
      env: {
        ...process.env,
        AIDEN_HOME: aidenHome,
        AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl,
        CUSTOM_OPENAI_API_KEY: 'idle-footer-key',
        AIDEN_NO_UPDATE_CHECK: '1',
        AIDEN_TEST_COMPOSER_READY: '1',
        TELEGRAM_BOT_TOKEN: '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });

    const draft = 'POWERSHELL FIXED DRAFT';
    let output = '';
    let state = 'boot';
    let typingFrame = '';
    let restoredFrame = '';
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `idle footer timeout (${state}):\n${screen.snapshot()}`,
      )), 40_000);
      child!.onData((chunk) => {
        output += chunk;
        screen.write(chunk);
        const rendered = screen.snapshot();
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (state === 'boot' && readyCount >= 1) {
          state = 'typing';
          typeLikeKeyboard(child!, draft, false);
          setTimeout(() => {
            typingFrame = screen.snapshot();
            state = 'submitted';
            child!.write('\r');
          }, 750);
        } else if (
          state === 'submitted'
          && rendered.includes('IDLE OWNER RESPONSE')
          && readyCount >= 2
        ) {
          restoredFrame = rendered;
          state = 'exiting';
          typeLikeKeyboard(child!, '/exit');
        }
      });
      child!.onExit(({ exitCode }) => {
        if (state !== 'exiting') return;
        clearTimeout(timeout);
        child = null;
        if (exitCode === 0) resolve();
        else reject(new Error(`idle footer CLI exited with ${exitCode}`));
      });
    });

    for (const [name, frame, composerNeedle] of [
      ['typing', typingFrame, draft],
      ['restored', restoredFrame, 'Type your message'],
    ] as const) {
      const lines = frame.split('\n');
      expect(lines.at(-2), name).toContain(composerNeedle);
      expect(lines.at(-1), name).toContain('custom_openai');
      expect(lines.at(-1), name).toContain('ctx');
      const rowsAboveFooter = lines.slice(0, -2);
      expect(rowsAboveFooter.filter((line) => line.includes('Type your message')), name).toEqual([]);
      const submittedRows = rowsAboveFooter.filter((line) => line.trimStart().startsWith('▲'));
      if (name === 'typing') {
        expect(submittedRows, name).toEqual([]);
        expect(rowsAboveFooter.filter((line) => line.includes(draft)), name).toEqual([]);
      } else {
        expect(submittedRows, name).toHaveLength(1);
        expect(submittedRows[0], name).toContain(draft);
      }
    }
  });

  it.each([
    { label: 'normal width', columns: 100 },
    { label: 'narrow width', columns: 44 },
  ])('keeps the rendered bottom composer visible after two queued messages at $label', async ({ columns }) => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pinned-queue-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pinned-queue-cwd-'));
    cleanup.push(aidenHome, cwd);
    provider = await startMockProvider({
      modelId: 'custom-default',
      chunkDelayMs: 5,
      script: [
        { toolCalls: [{ id: 'slow-shell', name: 'shell_exec', arguments: {
          command: 'Start-Sleep -Seconds 4; Write-Output TOOL-DONE',
        } }] },
        { content: 'ORIGINAL JOB COMPLETE' },
        { content: 'QUEUE ONE COMPLETE' },
        { content: 'QUEUE TWO COMPLETE' },
      ],
    });
    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'pinned-queue\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:', '  provider: custom_openai', '  modelId: custom-default',
      'providers:', '  custom_openai:', '    apiKey: pinned-queue-key',
      'display:', '  streaming: true', '  renderer: legacy',
    ].join('\n') + '\n', 'utf8');

    const rows = 30;
    const screen = new TerminalScreen(columns, rows);
    const frames: Record<string, string> = {};
    const preloadPath = path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs');
    const cliPath = path.join(repoRoot, 'dist/cli/v4/aidenCLI.js');
    const powerShellCommand = [
      '&',
      quotePowerShellLiteral(process.execPath),
      '-r',
      quotePowerShellLiteral(preloadPath),
      quotePowerShellLiteral(cliPath),
    ].join(' ');
    child = pty.spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powerShellCommand,
    ], {
      cwd, cols: columns, rows,
      env: { ...process.env, AIDEN_HOME: aidenHome, AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl, CUSTOM_OPENAI_API_KEY: 'pinned-queue-key',
        AIDEN_NO_UPDATE_CHECK: '1', AIDEN_TEST_COMPOSER_READY: '1', TELEGRAM_BOT_TOKEN: '',
        AIDEN_SANDBOX: '0', FORCE_COLOR: '0', NO_COLOR: '1' },
    });

    let output = '';
    let state = 'boot';
    let firstComposer = '';
    let secondComposer = '';
    let firstStatus = '';
    let secondStatus = '';
    let providerCallsBeforeExit = 0;
    let queuedRequestContents: Array<string | undefined> = [];
    let finishPoll: ReturnType<typeof setInterval> | null = null;
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `pinned queue timeout (${state}):\n${stripAnsi(output).slice(-12000)}`,
      )), 65_000);
      child!.onExit(({ exitCode }) => {
        if (state !== 'exiting') return;
        clearTimeout(timeout);
        if (finishPoll) clearInterval(finishPoll);
        child = null;
        if (exitCode === 0) resolve();
        else reject(new Error(`pinned queue CLI exited with ${exitCode}`));
      });
      child!.onData((chunk) => {
        output += chunk;
        screen.write(chunk);
        const plain = stripAnsi(output);
        const rendered = screen.snapshot();
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        const ids = [...new Set(plain.match(/input_[a-zA-Z0-9_-]+/g) ?? [])];

        if (state === 'boot' && readyCount >= 1) {
          state = 'approval';
          typeLikeKeyboard(child!, 'run a slow safe tool');
        } else if (state === 'approval' && plain.includes('Decision')) {
          state = 'tool';
          frames.approval = screen.snapshot();
          setTimeout(() => child!.write('\r'), 250);
        } else if (
          state === 'tool'
          && /running[\s\S]*Start-Sleep/i.test(plain)
          && screen.lines().at(-2)?.includes('Enter → queue')
          && screen.bottomLine().includes('custom_openai')
        ) {
          state = 'queue-one';
          frames.toolRunning = screen.snapshot();
          typeLikeKeyboard(child!, 'QUEUE ONE');
        } else if (state === 'queue-one' && ids.length >= 1) {
          state = 'queue-one-reset';
        } else if (state === 'queue-one-reset' && screen.lines().at(-2)?.includes('Enter → queue')) {
          firstComposer = screen.lines().at(-2) ?? '';
          firstStatus = screen.bottomLine();
          frames.firstQueue = screen.snapshot();
          state = 'queue-two';
          typeLikeKeyboard(child!, 'QUEUE TWO');
        } else if (state === 'queue-two' && ids.length >= 2) {
          state = 'queue-two-reset';
        } else if (state === 'queue-two-reset' && screen.lines().at(-2)?.includes('Enter → queue')) {
          secondComposer = screen.lines().at(-2) ?? '';
          secondStatus = screen.bottomLine();
          frames.secondQueue = screen.snapshot();
          state = 'finishing';
          finishPoll = setInterval(() => {
            if ((provider?.callCount() ?? 0) < 4) return;
            if (finishPoll) clearInterval(finishPoll);
            finishPoll = null;
            providerCallsBeforeExit = provider!.callCount();
            queuedRequestContents = (provider!.requests().slice(2, 4) as Array<{
              messages?: Array<{ role?: string; content?: string }>;
            }>).map((request) => (
              request.messages?.filter((message) => message.role === 'user').at(-1)?.content
            ));
            state = 'queue-check-pending';
            setTimeout(() => {
              state = 'queue-check';
              typeLikeKeyboard(child!, '/queue');
            }, 250);
          }, 25);
        } else if (state === 'queue-check' && /queue is empty/i.test(rendered)) {
          frames.queueEmpty = rendered;
          state = 'exiting';
          typeLikeKeyboard(child!, '/exit');
        }
      });
    });
    await completion;

    const plain = stripAnsi(output);
    const ids = [...new Set(plain.match(/input_[a-zA-Z0-9_-]+/g) ?? [])];
    expect(firstComposer).toContain('Enter → queue');
    expect(secondComposer).toContain('Enter → queue');
    expect(firstStatus).toContain('custom_openai');
    expect(secondStatus).toContain('custom_openai');
    expect(firstStatus).toContain('ctx');
    expect(secondStatus).toContain('ctx');
    expect(firstStatus).toMatch(/\b(?:\d+ms|\d+s)\b/);
    expect(secondStatus).toMatch(/\b(?:\d+ms|\d+s)\b/);
    expect(frames.toolRunning.split('\n').at(-2)).toContain('Enter → queue');
    expect(frames.toolRunning.split('\n').at(-1)).toContain('custom_openai');
    expect(
      frames.toolRunning.split('\n').filter((line) => line.includes('run a slow safe tool')),
    ).toHaveLength(1);
    for (const frame of Object.values(frames)) {
      const lines = frame.split('\n');
      expect(lines.slice(0, -1).filter((line) => line.includes('custom_openai'))).toHaveLength(0);
    }
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    const queuedRuns = plain.match(/running queued: QUEUE (?:ONE|TWO)/g) ?? [];
    expect(queuedRuns).toEqual(['running queued: QUEUE ONE', 'running queued: QUEUE TWO']);
    expect(queuedRequestContents).toEqual(['QUEUE ONE', 'QUEUE TWO']);
    expect(providerCallsBeforeExit).toBe(4);
    expect(frames.queueEmpty).toMatch(/queue is empty/i);

    const evidenceDir = process.env.AIDEN_ACCEPTANCE_EVIDENCE_DIR;
    if (evidenceDir) {
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(
        path.join(evidenceDir, `busy-queue-${columns}-columns.txt`),
        Object.entries(frames).map(([name, frame]) => `--- ${name} ---\n${frame}`).join('\n\n'),
        'utf8',
      );
    }
  }, 75_000);

  it('preserves an exact multiline busy submission through resize and provider handoff', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-busy-queue-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-busy-queue-cwd-'));
    cleanup.push(aidenHome, cwd);
    const queued = '  first line\n\n    second line  \n';
    provider = await startMockProvider({
      modelId: 'custom-default',
      headerDelayMs: 2_500,
      chunkDelayMs: 5,
      script: [
        { content: 'ACTIVE TURN COMPLETE' },
        { content: 'QUEUED TURN COMPLETE' },
      ],
    });
    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'busy-queue\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:', '  provider: custom_openai', '  modelId: custom-default',
      'providers:', '  custom_openai:', '    apiKey: busy-queue-key',
      'display:', '  streaming: true', '  renderer: legacy',
    ].join('\n') + '\n', 'utf8');
    child = pty.spawn(process.execPath, [
      '-r', path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs'),
      path.join(repoRoot, 'dist/cli/v4/aidenCLI.js'),
    ], {
      cwd, cols: 120, rows: 40,
      env: { ...process.env, AIDEN_HOME: aidenHome, AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl, CUSTOM_OPENAI_API_KEY: 'busy-queue-key',
        AIDEN_NO_UPDATE_CHECK: '1', AIDEN_TEST_COMPOSER_READY: '1', TELEGRAM_BOT_TOKEN: '',
        FORCE_COLOR: '0', NO_COLOR: '1' },
    });

    let output = '';
    let state = 'boot';
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `busy queue timeout (${state}):\n${stripAnsi(output).slice(-12000)}`,
      )), 45_000);
      child!.onData((chunk) => {
        output += chunk;
        const plain = stripAnsi(output);
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (state === 'boot' && readyCount >= 1) {
          state = 'active';
          typeLikeKeyboard(child!, 'hold the provider open');
        } else if (state === 'active' && plain.includes('calling provider')) {
          state = 'queueing';
          child!.write(`\x1b[200~${queued}\x1b[201~`);
          setTimeout(() => child!.resize(44, 40), 120);
          setTimeout(() => child!.resize(110, 40), 240);
          setTimeout(() => child!.write('\r'), 400);
        } else if (state === 'queueing' && provider!.callCount() >= 2 && readyCount >= 2) {
          state = 'queue-check';
          typeLikeKeyboard(child!, '/queue');
        } else if (state === 'queue-check' && /queue is empty/i.test(plain)) {
          state = 'done';
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await completion;

    expect(provider.callCount()).toBe(2);
    const request = provider.lastRequest() as { messages?: Array<{ role?: string; content?: string }> };
    const userMessages = request.messages?.filter((message) => message.role === 'user') ?? [];
    expect(userMessages.at(-1)?.content).toBe(queued);
    expect(stripAnsi(output)).toMatch(/queue is empty/i);
  }, 55_000);

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
        } else if (state === 'normal' && provider!.callCount() >= 3 && readyCount >= 3) {
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
    const screen = new TerminalScreen(240, 40);
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
        screen.write(chunk);
        const plain = stripAnsi(output);
        const rendered = screen.snapshot();
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (state === 'boot' && readyCount >= 1) {
          state = 'first-select';
          setTimeout(() => typeLikeKeyboard(child!, 'Run consecutive clarification acceptance'), 500);
        }
        if (state === 'first-select' && rendered.includes('Which format?')) {
          state = 'second-text';
          setTimeout(() => pressDownThenEnter(child!, 1), 500);
        }
        if (state === 'second-text' && rendered.includes('What topic?')) {
          state = 'clarify-final';
          setTimeout(() => typeLikeKeyboard(child!, 'P2A terminal ownership'), secondPromptDelayMs);
        }
        if (state === 'clarify-final' && rendered.includes('clarifications complete: PDF | P2A terminal ownership')) {
          state = 'queue-ready';
        }
        if (state === 'queue-ready' && readyCount >= 2) {
          state = 'queue-1';
          queueCommandSent = true;
          typeLikeKeyboard(child!, '/queue');
        }
        const emptyQueueCount = rendered.match(/queue is empty/gi)?.length ?? 0;
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
