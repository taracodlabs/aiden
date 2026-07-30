import { describe, expect, it } from 'vitest';
import path from 'node:path';
import * as pty from 'node-pty';
import { TerminalScreen } from '../harness/terminalScreen';

function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

describe.skipIf(process.platform !== 'win32')('activity timer ConPTY rendering', () => {
  it('keeps every replacement within one terminal row and stops after settlement', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const child = pty.spawn(process.execPath, [
      '-r', 'ts-node/register/transpile-only',
      path.join(repoRoot, 'tests/v4/harness/activityTimerPtyFixture.ts'),
    ], {
      cwd: repoRoot,
      cols: 48,
      rows: 20,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', AIDEN_UI_ICONS: '0' },
    });
    let raw = '';
    let currentWidth = 48;
    const screen = new TerminalScreen(currentWidth, 20);
    const dataSubscription = child.onData((chunk) => {
      raw += chunk;
      screen.write(chunk);
    });
    const resizeTo = (cols: number): void => {
      currentWidth = cols;
      screen.resize(cols, 20);
      child.resize(cols, 20);
    };
    const firstResize = setTimeout(() => resizeTo(44), 1_100);
    const secondResize = setTimeout(() => resizeTo(90), 2_600);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`activity fixture timeout:\n${JSON.stringify(raw)}`));
      }, 20_000);
      child.onExit(({ exitCode }) => {
        clearTimeout(firstResize);
        clearTimeout(secondResize);
        clearTimeout(timeout);
        dataSubscription.dispose();
        if (exitCode === 0) resolve();
        else reject(new Error(`activity fixture exited ${exitCode}:\n${JSON.stringify(raw)}`));
      });
    });

    const frames = [...raw.matchAll(/\x1b\[(?:H|\d+;1H)([^\r\n]*)/g)]
      .map((match) => stripAnsi(match[1]))
      .filter((line) => line.includes('working'))
      // ConPTY reflows its existing screen into one synthetic chunk while a
      // resize is applied. It is not an application repaint frame.
      .filter((line) => (line.match(/┊/gu) ?? []).length <= 1);
    expect(frames.length, JSON.stringify(raw)).toBeGreaterThanOrEqual(5);
    for (const frame of frames) {
      expect(frame.length, JSON.stringify({ frame, raw })).toBeLessThanOrEqual(48);
      expect((frame.match(/working/g) ?? []).length).toBeLessThanOrEqual(1);
    }
    expect(frames.filter((frame) => frame.includes('working')).length).toBeGreaterThanOrEqual(4);
    const finalActivityLines = screen.lines().filter((line) => line.includes('working'));
    expect(finalActivityLines.length, JSON.stringify({ finalActivityLines, raw })).toBeLessThanOrEqual(1);
    for (const line of finalActivityLines) {
      expect(line.length, JSON.stringify({ line, raw })).toBeLessThanOrEqual(currentWidth);
    }
    const settledAt = raw.indexOf('__ACTIVITY_SETTLED__');
    expect(settledAt).toBeGreaterThan(0);
    expect(raw.slice(settledAt)).not.toContain('working');
  }, 25_000);
});
