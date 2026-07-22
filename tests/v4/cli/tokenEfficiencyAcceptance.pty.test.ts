import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';

import { ProviderAttemptLedger } from '../../../core/v4/usageLedger';
import { COMPOSER_READY_TOKEN } from '../../../cli/v4/composerReadiness';
import { startMockProvider, type MockProvider } from '../harness/mockProvider';

type RunningPty = ReturnType<typeof pty.spawn>;
let child: RunningPty | null = null;
let provider: MockProvider | null = null;
const cleanup: string[] = [];

function plain(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function submit(terminal: RunningPty, text: string): void {
  let index = 0;
  const next = (): void => {
    if (index < text.length) {
      terminal.write(text[index++]!);
      setTimeout(next, 5);
      return;
    }
    setTimeout(() => terminal.write('\r'), 100);
  };
  next();
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

describe.skipIf(process.platform !== 'win32')('built CLI token-efficiency acceptance', () => {
  it('keeps estimates local and persists one Economy provider attempt', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-token-efficiency-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-token-efficiency-cwd-'));
    cleanup.push(aidenHome, cwd);
    provider = await startMockProvider({
      modelId: 'custom-default',
      script: [{ content: 'TOKEN EFFICIENCY ACCEPTANCE' }],
    });
    await fs.writeFile(path.join(aidenHome, '.onboarding-shown'), 'token-efficiency\n', 'utf8');
    await fs.writeFile(path.join(aidenHome, 'config.yaml'), [
      'model:', '  provider: custom_openai', '  modelId: custom-default',
      'providers:', '  custom_openai:', '    apiKey: controlled-test-value',
      'display:', '  streaming: true', '  renderer: legacy',
    ].join('\n') + '\n', 'utf8');

    child = pty.spawn(process.execPath, [
      '-r', path.join(repoRoot, 'tests/v4/harness/builtProviderPreload.cjs'),
      path.join(repoRoot, 'dist/cli/v4/aidenCLI.js'),
    ], {
      cwd, cols: 110, rows: 40,
      env: {
        ...process.env,
        AIDEN_HOME: aidenHome,
        AIDEN_TEST_REPO_ROOT: repoRoot,
        AIDEN_TEST_PROVIDER_BASE_URL: provider.baseUrl,
        CUSTOM_OPENAI_API_KEY: 'controlled-test-value',
        AIDEN_NO_UPDATE_CHECK: '1',
        AIDEN_TEST_COMPOSER_READY: '1',
        TELEGRAM_BOT_TOKEN: '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });

    let output = '';
    let state = 'boot';
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `token-efficiency acceptance timeout (${state}):\n${plain(output).slice(-12_000)}`,
      )), 45_000);
      child!.onData((chunk) => {
        output += chunk;
        const text = plain(output);
        const ready = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (state === 'boot' && ready >= 1) {
          state = 'estimate';
          submit(child!, '/estimate --json inspect one file');
        } else if (state === 'estimate' && text.includes('"selectedMode":"balanced"') && ready >= 2) {
          expect(provider!.callCount()).toBe(0);
          state = 'mode'; submit(child!, '/mode economy');
        } else if (state === 'mode' && text.includes('Usage mode: economy') && ready >= 3) {
          state = 'budget'; submit(child!, '/budget 100000');
        } else if (state === 'budget' && text.includes('Session token cap set') && ready >= 4) {
          state = 'turn'; submit(child!, 'reply with the acceptance phrase');
        } else if (state === 'turn' && text.includes('TOKEN EFFICIENCY ACCEPTANCE') && ready >= 5) {
          state = 'usage-json'; submit(child!, '/usage --json');
        } else if (state === 'usage-json' && text.includes('"physicalAttempts":1') && ready >= 6) {
          state = 'usage-human'; submit(child!, '/usage');
        } else if (state === 'usage-human' && text.includes('Usage — Current session') && ready >= 7) {
          expect(text).toContain('cumulative exposures');
          expect(text).not.toContain('Cost        0');
          state = 'usage-details'; submit(child!, '/usage details');
        } else if (state === 'usage-details' && text.includes('Usage details — Current session') && ready >= 8) {
          expect(text).toContain('Providers and models');
          expect(text).toContain('Purposes');
          state = 'budget-json'; submit(child!, '/budget --json');
        } else if (state === 'budget-json' && text.includes('"tokenBudget":100000') && ready >= 9) {
          state = 'queue'; submit(child!, '/queue');
        } else if (state === 'queue' && /queue is empty/i.test(text) && ready >= 10) {
          state = 'quit'; submit(child!, '/quit');
        }
      });
      child!.onExit(() => {
        if (state !== 'quit') return;
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(provider.callCount()).toBe(1);
    expect(plain(output)).not.toContain('controlled-test-value');
    const ledger = new ProviderAttemptLedger(path.join(aidenHome, 'sessions.db'));
    try {
      const records = ledger.query({ entryPoint: undefined }).filter((record) => record.entryPoint === 'cli');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ selectedMode: 'economy', status: 'success' });
    } finally {
      ledger.close();
    }
  }, 55_000);
});
