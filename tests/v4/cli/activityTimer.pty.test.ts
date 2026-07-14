import { describe, expect, it } from 'vitest';
import path from 'node:path';
import * as pty from 'node-pty';

function stripAnsi(value: string): string {
  return value
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
    child.onData((chunk) => { raw += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`activity fixture timeout:\n${JSON.stringify(raw)}`));
      }, 9_000);
      child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (exitCode === 0) resolve();
        else reject(new Error(`activity fixture exited ${exitCode}:\n${JSON.stringify(raw)}`));
      });
    });

    const frames = [...raw.matchAll(/\x1b\[(?:H|\d+;1H)([^\r\n]*)/g)]
      .map((match) => stripAnsi(match[1]))
      .filter((line) => line.includes('calling') || line.includes('running'));
    expect(frames.length, JSON.stringify(raw)).toBeGreaterThanOrEqual(5);
    for (const frame of frames) {
      expect(frame.length, JSON.stringify({ frame, raw })).toBeLessThanOrEqual(48);
      expect((frame.match(/running/g) ?? []).length).toBeLessThanOrEqual(1);
    }
    expect(frames.filter((frame) => frame.includes('running')).length).toBeGreaterThanOrEqual(4);
    const activityCursorRows = [...raw.matchAll(/\x1b\[(H|(\d+);1H)([^\r\n]*(?:calling|running)[^\r\n]*)/g)]
      .map((match) => match[2] === undefined ? 1 : Number(match[2]));
    expect(activityCursorRows.every((row) => row === 1), JSON.stringify(raw)).toBe(true);
    const settledAt = raw.indexOf('__ACTIVITY_SETTLED__');
    expect(settledAt).toBeGreaterThan(0);
    expect(raw.slice(settledAt)).not.toContain('running');
  }, 12_000);
});
