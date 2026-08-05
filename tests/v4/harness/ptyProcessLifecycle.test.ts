/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { isProcessRunning, killPtyIfRunning } from './ptyProcessLifecycle';

describe('PTY process cleanup', () => {
  it('does not invoke PTY cleanup after the child has exited', () => {
    const kill = vi.fn();
    expect(killPtyIfRunning({ pid: 2_147_483_647, kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not kill during PTY output drain after native process exit', () => {
    const kill = vi.fn();
    expect(killPtyIfRunning({
      pid: process.pid,
      kill,
      _agent: { exitCode: 0 },
    })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('recognizes the current process as running', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('terminates only the recorded Windows process tree', async () => {
    const processUnderTest = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], { windowsHide: true });
    await once(processUnderTest, 'spawn');
    const exited = once(processUnderTest, 'exit');
    const fallbackKill = vi.fn();

    expect(killPtyIfRunning({ pid: processUnderTest.pid!, kill: fallbackKill })).toBe(true);
    await exited;
    expect(fallbackKill).not.toHaveBeenCalled();
    expect(isProcessRunning(processUnderTest.pid!)).toBe(false);
  });
});
