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

function typeLine(terminal: RunningPty, text: string): void {
  let index = 0;
  const next = (): void => {
    if (index < text.length) {
      terminal.write(text[index++]);
      setTimeout(next, 10);
      return;
    }
    setTimeout(() => terminal.write('\r'), 80);
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

describe.skipIf(process.platform !== 'win32')('built CLI interactive decision outcomes', () => {
  it('keeps interruption, invalid retry, cancellation, and explicit none distinct', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-decision-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-decision-cwd-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-decision-outside-'));
    cleanup.push(aidenHome, cwd, outside);

    const interruptedPath = path.join(outside, 'interrupted.txt');
    const singleDeniedPath = path.join(outside, 'single-denied.txt');
    const singleAllowedPath = path.join(outside, 'single-allowed.txt');
    const approvedPath = path.join(cwd, 'approved.txt');
    const declinedPath = path.join(cwd, 'declined.txt');
    const cancelledPath = path.join(cwd, 'cancelled.txt');
    const deniedPath = path.join(cwd, 'denied.txt');

    provider = await startMockProvider({
      modelId: 'custom-default',
      chunkDelayMs: 5,
      script: [
        { toolCalls: [{
          id: 'single-approval', name: 'file_write',
          arguments: { path: interruptedPath, content: 'must not exist' },
        }] },
        { toolCalls: [{
          id: 'single-denial', name: 'shell_exec',
          arguments: {
            command: `Set-Content -LiteralPath '${singleDeniedPath.replace(/'/g, "''")}' -Value 'DENIED' -NoNewline`,
          },
        }] },
        { content: 'The user approved the command and it completed. SINGLE DENIAL COMPLETE' },
        { toolCalls: [{
          id: 'single-allow', name: 'shell_exec',
          arguments: {
            command: `Set-Content -LiteralPath '${singleAllowedPath.replace(/'/g, "''")}' -Value 'ALLOWED' -NoNewline`,
          },
        }] },
        { content: 'No approval modal was triggered by the runtime. SINGLE ALLOW COMPLETE' },
        { toolCalls: [{
          id: 'batch-valid', name: 'plan_approval',
          arguments: {
            title: 'Choose one write',
            operations: [
              { tool: 'file_write', args: { path: approvedPath, content: 'approved' }, reason: 'required first write' },
              { tool: 'file_write', args: { path: declinedPath, content: 'declined' }, reason: 'required second write' },
            ],
          },
        }] },
        { toolCalls: [{
          id: 'approved-write', name: 'file_write',
          arguments: { path: approvedPath, content: 'approved' },
        }] },
        { content: 'All operations were approved and completed. BATCH RETRY COMPLETE' },
        { toolCalls: [{
          id: 'batch-cancel', name: 'plan_approval',
          arguments: {
            title: 'Cancel this write',
            operations: [{
              tool: 'file_write', args: { path: cancelledPath, content: 'cancelled' }, reason: 'must remain absent',
            }],
          },
        }] },
        { content: 'BATCH CANCELLATION COMPLETE' },
        { toolCalls: [{
          id: 'batch-none', name: 'plan_approval',
          arguments: {
            title: 'Deny this write',
            operations: [{
              tool: 'file_write', args: { path: deniedPath, content: 'denied' }, reason: 'must remain absent',
            }],
          },
        }] },
        { content: 'BATCH NONE COMPLETE' },
      ],
    });

    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'decision\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:',
      '  provider: custom_openai',
      '  modelId: custom-default',
      'providers:',
      '  custom_openai:',
      '    apiKey: decision-key',
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
      rows: 45,
      env: {
        ...process.env,
        AIDEN_HOME: aidenHome,
        AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl,
        CUSTOM_OPENAI_API_KEY: 'decision-key',
        AIDEN_NO_UPDATE_CHECK: '1',
        AIDEN_TEST_COMPOSER_READY: '1',
        AIDEN_SANDBOX: '0',
        TELEGRAM_BOT_TOKEN: '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });

    let output = '';
    let state = 'boot';
    let turnStart = 0;
    const settled: Record<string, string> = {};

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `decision acceptance timeout (${state}, providerCalls=${provider?.callCount() ?? -1}):\n${stripAnsi(output).slice(-16000)}`,
      )), 120_000);

      child!.onData((chunk) => {
        output += chunk;
        const plain = stripAnsi(output);
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;

        if (state === 'boot' && readyCount >= 1) {
          state = 'single-prompt';
          turnStart = plain.length;
          typeLine(child!, 'request interrupted write');
        } else if (state === 'single-prompt' && plain.includes('Decision')) {
          state = 'single-settle';
          setTimeout(() => child!.write('\x03'), 250);
        } else if (state === 'single-settle' && plain.slice(turnStart).includes('Cancelled') && readyCount >= 2) {
          settled.single = plain.slice(turnStart);
          state = 'single-denial-prompt';
          turnStart = plain.length;
          typeLine(child!, 'request explicitly denied command');
        } else if (state === 'single-denial-prompt' && plain.slice(turnStart).includes('Decision')) {
          state = 'single-denial-settle';
          setTimeout(() => {
            child!.write('\x1b[B');
            setTimeout(() => child!.write('\r'), 150);
          }, 250);
        } else if (
          state === 'single-denial-settle'
          && provider!.callCount() >= 3
          && plain.slice(turnStart).includes('Denied · Task:')
          && readyCount >= 3
        ) {
          settled.denial = plain.slice(turnStart);
          state = 'clear-before-allow';
          typeLine(child!, '/clear');
        } else if (state === 'clear-before-allow' && plain.match(/History cleared\./g)?.length === 1 && readyCount >= 4) {
          state = 'single-allow-prompt';
          turnStart = plain.length;
          typeLine(child!, 'request approved command');
        } else if (state === 'single-allow-prompt' && plain.slice(turnStart).includes('Decision')) {
          state = 'single-allow-settle';
          setTimeout(() => child!.write('\r'), 250);
        } else if (
          state === 'single-allow-settle'
          && provider!.callCount() >= 5
          && plain.slice(turnStart).includes('Completed · Task:')
          && readyCount >= 5
        ) {
          settled.allow = plain.slice(turnStart);
          state = 'clear-after-single';
          typeLine(child!, '/clear');
        } else if (state === 'clear-after-single' && plain.match(/History cleared\./g)?.length === 2 && readyCount >= 6) {
          state = 'batch-valid-prompt';
          turnStart = plain.length;
          typeLine(child!, 'request partial batch');
        } else if (state === 'batch-valid-prompt' && plain.includes('Approve which operations?')) {
          state = 'batch-valid-retry';
          setTimeout(() => typeLine(child!, '1.5'), 200);
        } else if (state === 'batch-valid-retry' && plain.includes('Could not parse')) {
          state = 'batch-valid-settle';
          setTimeout(() => typeLine(child!, '1'), 200);
        } else if (
          state === 'batch-valid-settle'
          && provider!.callCount() >= 8
          && /(?:Partially completed|Verified) · Task:/.test(plain.slice(turnStart))
          && readyCount >= 7
        ) {
          settled.retry = plain.slice(turnStart);
          state = 'clear-after-retry';
          typeLine(child!, '/clear');
        } else if (state === 'clear-after-retry' && plain.match(/History cleared\./g)?.length === 3 && readyCount >= 8) {
          state = 'batch-cancel-prompt';
          turnStart = plain.length;
          typeLine(child!, 'request cancelled batch');
        } else if (state === 'batch-cancel-prompt' && plain.includes('Cancel this write')) {
          state = 'batch-cancel-settle';
          setTimeout(() => child!.write('\x03'), 250);
        } else if (
          state === 'batch-cancel-settle'
          && provider!.callCount() >= 10
          && plain.slice(turnStart).includes('Cancelled · Task:')
          && readyCount >= 9
        ) {
          settled.cancel = plain.slice(turnStart);
          state = 'clear-after-cancel';
          typeLine(child!, '/clear');
        } else if (state === 'clear-after-cancel' && plain.match(/History cleared\./g)?.length === 4 && readyCount >= 10) {
          state = 'batch-none-prompt';
          turnStart = plain.length;
          typeLine(child!, 'request denied batch');
        } else if (state === 'batch-none-prompt' && plain.includes('Deny this write')) {
          state = 'batch-none-settle';
          setTimeout(() => typeLine(child!, 'none'), 200);
        } else if (
          state === 'batch-none-settle'
          && provider!.callCount() >= 12
          && plain.slice(turnStart).includes('Denied · Task:')
          && readyCount >= 11
        ) {
          settled.none = plain.slice(turnStart);
          state = 'queue';
          typeLine(child!, '/queue');
        } else if (state === 'queue' && /queue is empty/i.test(plain)) {
          state = 'done';
          clearTimeout(timeout);
          resolve();
        }
      });

      child!.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (state !== 'done') reject(new Error(`decision CLI exited ${exitCode} in ${state}`));
      });
    });

    expect(provider.callCount()).toBe(12);
    expect(settled.single).toContain('Cancelled');
    expect(settled.single).not.toMatch(/\bfailed\b/i);
    expect(settled.single).not.toMatch(/denied by approval engine/i);
    expect(settled.denial).toContain('Denied');
    expect(settled.denial).toContain('The command was denied and was not executed.');
    expect(settled.denial).not.toContain('The user approved the command and it completed.');
    expect(settled.denial).not.toMatch(/Could not verify required outcome|\bFailed\b|\bCancelled\b/i);
    expect(settled.cancel).toContain('Cancelled');
    expect(settled.cancel).not.toContain('Denied');
    expect(settled.none).toContain('Denied');
    expect(settled.retry).toMatch(/Partially completed|Verified/);
    expect(settled.retry).toContain('Only the approved operations were executed; the remaining operations were denied.');
    expect(settled.retry).not.toContain('All operations were approved and completed.');
    expect(settled.allow).toContain('The command was approved and executed successfully.');
    expect(settled.allow).not.toContain('No approval modal was triggered by the runtime.');
    await expect(fs.access(interruptedPath)).rejects.toThrow();
    await expect(fs.access(singleDeniedPath)).rejects.toThrow();
    await expect(fs.readFile(singleAllowedPath, 'utf8')).resolves.toBe('ALLOWED');
    await expect(fs.readFile(approvedPath, 'utf8')).resolves.toBe('approved');
    await expect(fs.access(declinedPath)).rejects.toThrow();
    await expect(fs.access(cancelledPath)).rejects.toThrow();
    await expect(fs.access(deniedPath)).rejects.toThrow();
    expect(stripAnsi(output)).toMatch(/queue is empty/i);
  }, 135_000);
});
