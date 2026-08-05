/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { spawnSync } from 'node:child_process';

export interface KillablePtyProcess {
  pid: number;
  kill(): void;
  /** The PTY records native process exit before its output-drain event fires. */
  _agent?: {
    exitCode?: number;
  };
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Avoid asking node-pty to enumerate a console that already disappeared. */
export function killPtyIfRunning(child: KillablePtyProcess): boolean {
  if (child._agent?.exitCode !== undefined) return false;
  if (!isProcessRunning(child.pid)) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', [
      '/PID', String(child.pid), '/T', '/F',
    ], { stdio: 'ignore', windowsHide: true });
    return result.status === 0;
  }
  child.kill();
  return true;
}
