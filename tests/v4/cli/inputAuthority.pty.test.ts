import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import * as pty from 'node-pty';

type RunningPty = ReturnType<typeof pty.spawn>;

const fixture = path.resolve(__dirname, '../harness/inputAuthorityPtyFixture.ts');
const children = new Set<RunningPty>();

afterEach(async () => {
  for (const child of children) {
    try { child.kill(); } catch { /* already exited */ }
  }
  children.clear();
  await new Promise((resolve) => setTimeout(resolve, 500));
});

function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

async function runScenario(
  scenario: 'complete' | 'cancel' | 'approval-clarify' | 'skill-normal',
): Promise<Record<string, unknown>> {
  const child = pty.spawn(process.execPath, [
    '-r',
    'ts-node/register/transpile-only',
    fixture,
    scenario,
  ], {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, FORCE_COLOR: '0' },
    cols: 120,
    rows: 30,
  });
  children.add(child);

  let output = '';
  let firstAnswered = false;
  let secondAnswered = false;
  let normalAnswered = false;
  let result: Record<string, unknown> | undefined;

  const completion = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`PTY regression timed out. Output:\n${stripAnsi(output)}`));
    }, 20_000);

    child.onData((chunk) => {
      output += chunk;
      const plain = stripAnsi(output);
      if (!firstAnswered && plain.includes('Which format would you like for the report?')) {
        firstAnswered = true;
        setTimeout(() => child.write('\r'), 600);
      }
      if (!firstAnswered && plain.includes('Decision')) {
        firstAnswered = true;
        setTimeout(() => child.write('\x1b[B\r'), 600);
      }
      if (!firstAnswered && plain.includes('Save this as a reusable skill?')) {
        firstAnswered = true;
        setTimeout(() => child.write('n\r'), 600);
      }
      if (!secondAnswered && plain.includes('What topic should the Markdown report cover?')) {
        secondAnswered = true;
        setTimeout(() => child.write(scenario === 'complete' ? 'P2A terminal ownership\r' : '\x03'), 600);
      }
      if (!secondAnswered && plain.includes('Clarification after approval')) {
        secondAnswered = true;
        setTimeout(() => child.write('approval isolated\r'), 600);
      }
      if (!normalAnswered && plain.includes('[P2A:NORMAL_READY]')) {
        normalAnswered = true;
        setTimeout(() => child.write('NORMAL_INPUT_OK\r'), 150);
      }
      const match = plain.match(/\[P2A:RESULT\](\{[^\r\n]+\})/);
      if (match) {
        result = JSON.parse(match[1]) as Record<string, unknown>;
      }
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      children.delete(child);
      if (exitCode !== 0 || !result) {
        reject(new Error(`PTY child exited ${exitCode}. Output:\n${stripAnsi(output)}`));
      } else {
        resolve(result);
      }
    });
  });

  return completion;
}

function expectRestored(result: Record<string, unknown>): void {
  const baseline = result.baseline as Record<string, unknown>;
  for (const key of ['firstCleanup', 'secondCleanup'] as const) {
    const cleanup = result[key] as Record<string, unknown>;
    expect(cleanup.paused).toBe(false);
    expect(cleanup.flowing).toBe(true);
    expect(cleanup.raw).toBe(true);
  }
  for (const key of ['firstRestored', 'secondRestored'] as const) {
    const restored = result[key] as Record<string, unknown>;
    expect(restored.paused).toBe(false);
    expect(restored.flowing).toBe(true);
    expect(restored.raw).toBe(true);
    expect(restored.data).toBe(baseline.data);
    expect(restored.keypress).toBe(baseline.keypress);
    expect(restored.readable).toBe(baseline.readable);
    expect(restored.sigint).toBe(baseline.sigint);
  }
  expect(result.leakedBeforeNormal).toEqual(['']);
  expect(result.typedAfterward).toBe('NORMAL_INPUT_OK');
  expect(result.rawLines).toEqual(['NORMAL_INPUT_OK']);
  expect(result.owner).toBe('during_turn');
  expect(result.restoreCount).toBe(2);
  expect(result.turnAborted).toBe(false);
}

describe.skipIf(process.platform !== 'win32')('InputAuthority real Inquirer Windows PTY regression', () => {
  it('restores stdin flow between a select and a separate free-text prompt', async () => {
    const result = await runScenario('complete');
    expect(result.first).toBe('Markdown');
    expect(result.second).toBe('P2A terminal ownership');
    expectRestored(result);
  }, 30_000);

  it('keeps Ctrl+C inside the second prompt and restores normal input', async () => {
    const result = await runScenario('cancel');
    expect(result.first).toBe('Markdown');
    expect(result.second).toBeNull();
    expectRestored(result);
  }, 30_000);

  it('isolates approval cleanup before a separate clarification lease', async () => {
    const result = await runScenario('approval-clarify');
    expect(result.first).toBe('deny');
    expect(result.second).toBe('approval isolated');
    expectRestored(result);
  }, 30_000);

  it('isolates skill-save n and restores ordinary raw input', async () => {
    const result = await runScenario('skill-normal');
    expect(result.first).toBe(false);
    const cleanup = result.firstCleanup as Record<string, unknown>;
    const restored = result.firstRestored as Record<string, unknown>;
    const baseline = result.baseline as Record<string, unknown>;
    expect(cleanup).toMatchObject({ paused: false, flowing: true, raw: true });
    expect(restored).toMatchObject({ paused: false, flowing: true, raw: true });
    expect(restored.data).toBe(baseline.data);
    expect(restored.keypress).toBe(baseline.keypress);
    expect(result.leakedBeforeNormal).toEqual(['']);
    expect(result.typedAfterward).toBe('NORMAL_INPUT_OK');
    expect(result.rawLines).toEqual(['NORMAL_INPUT_OK']);
    expect(result.owner).toBe('during_turn');
    expect(result.restoreCount).toBe(1);
  }, 30_000);
});
