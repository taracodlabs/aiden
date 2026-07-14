import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import * as pty from 'node-pty';
import { COMPOSER_READY_TOKEN } from '../../../cli/v4/composerReadiness';

type RunningPty = ReturnType<typeof pty.spawn>;
const children = new Set<RunningPty>();
const fixture = path.resolve(__dirname, '../harness/fullRuntimeInputPtyFixture.ts');

function typeLikeKeyboard(child: RunningPty, text: string, submit = true): void {
  let index = 0;
  const writeNext = (): void => {
    if (index < text.length) {
      child.write(text[index]);
      index += 1;
      setTimeout(writeNext, 12);
    } else if (submit) {
      setTimeout(() => child.write('\r'), 100);
    }
  };
  writeNext();
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
  for (const child of children) {
    try { child.kill(); } catch { /* already exited */ }
  }
  children.clear();
  await new Promise((resolve) => setTimeout(resolve, 300));
});

describe.skipIf(process.platform !== 'win32')('full-runtime consecutive clarification PTY', () => {
  it('delivers delayed ordinary text to the second real prompt without queue leakage', async () => {
    const child = pty.spawn(process.execPath, [
      '-r', 'ts-node/register/transpile-only', fixture,
    ], {
      cwd: path.resolve(__dirname, '../../..'),
      env: {
        ...process.env,
        AIDEN_HOME: path.join(os.tmpdir(), `aiden-p2a-full-${Date.now()}`),
        FORCE_COLOR: '0', NO_COLOR: '1', AIDEN_NO_UPDATE_CHECK: '1',
        AIDEN_TEST_COMPOSER_READY: '1',
      },
      cols: 300,
      rows: 30,
    });
    children.add(child);
    let output = '';
    let started = false;
    let formatAnswered = false;
    let topicAnswered = false;
    let finishSent = false;
    let result: Record<string, unknown> | null = null;

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`full runtime PTY timeout:\n${stripAnsi(output).slice(-10000)}`)), 30_000);
      child.onData((chunk) => {
        output += chunk;
        const plain = stripAnsi(output);
        const readyCount = output.split(COMPOSER_READY_TOKEN).length - 1;
        if (!started && readyCount >= 1) {
          started = true;
          setTimeout(() => typeLikeKeyboard(child, 'Create a report after asking format and topic'), 600);
        }
        if (!formatAnswered && plain.includes('Which format would you like for the report?')) {
          formatAnswered = true;
          setTimeout(() => child.write('\r'), 600);
        }
        if (!topicAnswered && plain.includes('What topic should the Markdown report cover?')) {
          topicAnswered = true;
          setTimeout(() => typeLikeKeyboard(child, 'P2A terminal ownership'), 1_500);
        }
        if (!finishSent && plain.includes('Clarifications completed.') && readyCount >= 2) {
          finishSent = true;
          setTimeout(() => typeLikeKeyboard(child, '/p2a-result'), 600);
        }
        const match = plain.match(/\[P2A_FULL:RESULT\](\{[^\n]+\})/);
        if (match) result = JSON.parse(match[1]) as Record<string, unknown>;
      });
      child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        children.delete(child);
        if (exitCode !== 0 || !result) {
          reject(new Error(`full runtime PTY exited ${exitCode}:\n${stripAnsi(output).slice(-3000)}`));
        } else {
          resolve();
        }
      });
    });

    await completion;
    expect(stripAnsi(output)).toContain('P2A terminal ownership');
    expect(result?.providerCalls).toBe(3);
    expect(result?.queue).toEqual([]);
    expect(result?.activityCount).toBe(0);
    expect(result?.activityTimers).toBe(0);
  }, 40_000);
});
