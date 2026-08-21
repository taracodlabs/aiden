/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => childProcess);

import {
  _inspectDockerSessionsForTests,
  _resetDockerSessionForTests,
  _setDockerAvailableForTests,
  dockerSessionExec,
} from '../../../core/v4/dockerSession';
import { _resetSandboxConfigForTests } from '../../../core/v4/sandboxConfig';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

function installDockerProcessFixture(inspectFailure = false): { calls: string[][] } {
  const calls: string[][] = [];
  let activeExec: FakeChild | null = null;
  childProcess.spawnSync.mockReturnValue({ status: 0 });
  childProcess.spawn.mockImplementation((_command: string, args: string[]) => {
    calls.push(args);
    const child = new FakeChild();
    const operation = args[0];
    queueMicrotask(() => {
      if (operation === 'run') {
        child.stdout.end('container_exact\n');
        child.emit('close', 0);
      } else if (operation === 'exec') {
        activeExec = child;
      } else if (operation === 'stop' || operation === 'rm') {
        child.emit('close', 0);
        if (operation === 'stop' && activeExec) {
          activeExec.emit('close', 137);
          activeExec = null;
        }
      } else if (operation === 'inspect') {
        child.stderr.end(inspectFailure ? 'Cannot connect to Docker daemon' : 'No such object: container_exact');
        child.emit('close', 1);
      }
    });
    return child;
  });
  return { calls };
}

beforeEach(() => {
  childProcess.spawn.mockReset();
  childProcess.spawnSync.mockReset();
  _resetDockerSessionForTests();
  _resetSandboxConfigForTests();
  _setDockerAvailableForTests(true);
});

describe('Docker session cancellation authority', () => {
  it('removes the exact Aiden-owned container and resolves only after absence is verified', async () => {
    const { calls } = installDockerProcessFixture();
    const controller = new AbortController();
    const execution = dockerSessionExec({ sessionId: 'cancel-exact', command: 'node slow.js' }, {
      signal: controller.signal,
    });
    while (!calls.some((args) => args[0] === 'exec')) await Promise.resolve();

    controller.abort(new Error('operator cancelled'));
    const result = await execution;

    expect(result).toMatchObject({ exitCode: -1, backend: 'docker', timedOut: false });
    expect(result.stderr).toMatch(/interrupted/i);
    expect(calls).toContainEqual(['stop', '-t', '2', 'container_exact']);
    expect(calls).toContainEqual(['rm', '-f', 'container_exact']);
    expect(calls).toContainEqual(['inspect', '--format', '{{.State.Running}}', 'container_exact']);
    expect(_inspectDockerSessionsForTests().count).toBe(0);
  });

  it('fails closed when exact container death cannot be verified', async () => {
    const { calls } = installDockerProcessFixture(true);
    const controller = new AbortController();
    const execution = dockerSessionExec({ sessionId: 'cancel-unverified', command: 'node slow.js' }, {
      signal: controller.signal,
    });
    while (!calls.some((args) => args[0] === 'exec')) await Promise.resolve();

    controller.abort(new Error('operator cancelled'));

    await expect(execution).rejects.toMatchObject({ name: 'DockerCancellationUnverifiedError' });
  });
});
