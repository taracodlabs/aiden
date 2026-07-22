import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import * as pty from 'node-pty';

type RunningPty = ReturnType<typeof pty.spawn>;
let child: RunningPty | null = null;
const fixture = path.resolve(__dirname, '../harness/ollamaModelPickerPtyFixture.ts');

function plain(value: string): string {
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
  await new Promise((resolve) => setTimeout(resolve, 300));
});

describe.skipIf(process.platform !== 'win32')('live Ollama model picker ConPTY', () => {
  it('selects an installed exact tag and leaves static recommendations disabled', async () => {
    child = pty.spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', fixture], {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      cols: 140,
      rows: 40,
    });
    let output = '';
    let state = 'provider';
    const result = await new Promise<{ providerId: string; modelId: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `Ollama picker PTY timeout (${state}):\n${plain(output).slice(-10_000)}`,
      )), 20_000);
      child!.onData((chunk) => {
        output += chunk;
        const text = plain(output);
        if (state === 'provider' && text.includes('Select Provider')) {
          state = 'model';
          setTimeout(() => child!.write('\r'), 300);
        } else if (state === 'model' && text.includes('Select a model')) {
          state = 'result';
          setTimeout(() => child!.write('\x1b[B\x1b[B\r'), 300);
        }
        const match = text.match(/\[OLLAMA_PICKER_RESULT\](\{[^\n]+\})/);
        if (match) {
          clearTimeout(timeout);
          resolve(JSON.parse(match[1]) as { providerId: string; modelId: string });
        }
      });
      child!.onExit(({ exitCode }) => {
        if (exitCode !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Ollama picker exited ${exitCode}:\n${plain(output).slice(-10_000)}`));
        }
      });
    });

    expect(result).toEqual({ providerId: 'ollama', modelId: 'gemma4:e4b-32k' });
    for (const model of ['gemma4:e4b-32k', 'gemma4:e4b-16k', 'gemma4:e4b-8k', 'gemma4:e4b']) {
      expect(plain(output)).toContain(model);
    }
    expect(plain(output)).toMatch(/Llama 3\.2 \(local\).*not installed.*ollama pull llama3\.2/i);
  }, 25_000);
});
