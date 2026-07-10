/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * fix/shell-exec-tree-kill — a turn interrupted while shell_exec has a child
 * running must reap the whole PROCESS TREE, not just the direct child.
 *
 * On Windows `child.kill()` is TerminateProcess on the root only — a
 * `powershell → nmap` (or any re-spawn) subtree orphans. The correct reap is
 * `killProcessTree` (`taskkill /pid <pid> /t /f`), already proven by
 * spawnCommand.test.ts. This test drives the local backend with a running child
 * and an abort signal, and asserts the tree-killer's taskkill fired — mocking
 * taskkill via `execSyncImpl` + `platform:'win32'`, exactly like
 * spawnCommand.test.ts, so it is deterministic on any CI host.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { localBackendExecute } from '../../../tools/v4/backends/local';
import * as spawnCmd from '../../../core/v4/util/spawnCommand';

/** A fake, still-running child: has a pid, streams, and never emits 'close'. */
function fakeRunningChild(pid = 4242) {
  const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
  c.pid = pid;
  const out = new EventEmitter() as EventEmitter & { resume: () => void };
  out.resume = () => { /* noop */ };
  const err = new EventEmitter() as EventEmitter & { resume: () => void };
  err.resume = () => { /* noop */ };
  c.stdout = out;
  c.stderr = err;
  c.kill = vi.fn(() => true);
  return c;
}

describe('shell_exec local backend — abort reaps the child TREE (fix/shell-exec-tree-kill)', () => {
  it('★ a turn interrupt kills the whole tree via taskkill /t /f — not just the direct child', async () => {
    const child = fakeRunningChild(4242);
    spawnMock.mockReturnValueOnce(child);

    const taskkill = vi.fn();   // stands in for execSync running the taskkill command
    // Force the Windows tree-kill path with a mocked taskkill — same seam as
    // spawnCommand.test.ts (execSyncImpl + platform).
    const killTree = (ch: unknown, sig: NodeJS.Signals) =>
      spawnCmd.killProcessTree(ch as never, sig, { platform: 'win32', execSyncImpl: taskkill as never });

    const ac = new AbortController();
    const p = localBackendExecute(
      { command: 'while ($true) { Start-Sleep 1 }', captureOutput: false },
      { signal: ac.signal, killTree } as never,
    );

    // The child is "running" (no 'close' yet). Interrupt the turn.
    ac.abort();   // AbortController dispatches 'abort' synchronously

    // The WHOLE tree is reaped (taskkill /t /f), not `child.kill()` on the root.
    expect(taskkill).toHaveBeenCalledTimes(1);
    expect(String(taskkill.mock.calls[0][0])).toBe('taskkill /pid 4242 /t /f');

    // The tool resolves so the turn can settle (belt-and-suspenders cleanup).
    child.emit('close', null);
    await p;
  });
});
