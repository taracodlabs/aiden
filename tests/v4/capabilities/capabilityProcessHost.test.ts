/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDockerCapabilityInvocation,
  DockerCapabilityProcessHost,
} from '../../../core/v4/capabilities/processHost';
import { capabilityIdentity, type CapabilityManifest } from '../../../packages/capability-sdk/src';

const manifest: CapabilityManifest = {
  manifestVersion: 1, id: 'dev.taracod.safe-reader', version: '1.0.0', displayName: 'Safe reader',
  runtime: { kind: 'node', protocolVersion: 1 }, entrypoint: 'index.js',
  tools: [{
    name: 'safe_reader', description: 'Read through the broker.', mutates: false,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object', required: ['ok'], additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
    },
  }],
  permissions: [{ kind: 'filesystem.read', scope: { paths: ['**/*'] } }], effects: [], secretSlots: [],
  compatibility: { aiden: '>=4.20 <5', node: '>=22 <23', os: ['win32', 'linux', 'darwin'], architectures: ['x64'] },
  limits: { runtimeMs: 2_000, maxMessageBytes: 8_192, maxTotalOutputBytes: 32_768, maxBrokerRequests: 4, maxEvidenceClaims: 2 },
  digest: `sha256:${'d'.repeat(64)}`,
};
const identity = capabilityIdentity(manifest);

describe('Docker capability process boundary', () => {
  it('constructs a deny-by-default container without workspace or parent secret authority', () => {
    const built = buildDockerCapabilityInvocation({
      manifest, identity, invocationId: 'inv_test_1', nonce: 'nonce_test_1',
      installPath: 'C:/aiden/capabilities/safe-reader', runtimePath: 'C:/aiden/dist/containerRuntime.js',
      sourceEnvironment: {
        PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows',
        PARENT_SECRET: 'must-not-cross', OPENAI_API_KEY: 'must-not-cross', AIDEN_HOME: 'C:\\Users\\private',
      }, now: 10,
    });
    expect(built.environment).toEqual({ PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' });
    expect(built.args).toEqual(expect.arrayContaining([
      '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '16',
      '--user', '65532:65532', '--experimental-permission', '--no-addons',
      '--allow-fs-read=/capability', '--allow-fs-read=/aiden-host',
    ]));
    expect(built.args.join(' ')).not.toMatch(/PARENT_SECRET|OPENAI_API_KEY|AIDEN_HOME|--allow-child-process|--allow-fs-write/);
    expect(built.args.join(' ')).not.toContain('C:\\workspace');
    expect(built.args.filter((value) => value === '-v')).toHaveLength(2);
  });

  it('accepts one exact handshake and validated terminal result', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    let nonce = '';
    let invocationId = '';
    let sentIdentity: typeof identity;
    child.pid = 44_001;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn();
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        const messages = String(chunk).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
        for (const message of messages) {
          if (message.type === 'HELLO') {
            nonce = message.nonce;
            invocationId = message.invocationId;
            sentIdentity = message.identity;
          }
          if (message.type === 'INVOKE') {
            stdout.write(`${JSON.stringify({
              type: 'RESULT', sequence: 1, invocationId, identity: sentIdentity, output: { ok: true },
            })}\n`);
            setImmediate(() => child.emit('close', 0, null));
          }
        }
        done();
      },
    });
    const spawn = vi.fn(() => ({ child, resolvedCmd: 'docker', resolvedArgs: [], viaCmdExe: false }));
    const host = new DockerCapabilityProcessHost({
      probe: () => ({ available: true, mechanism: 'docker', image: 'test-image' }),
      spawn: spawn as never,
      removeContainer: vi.fn(),
    });
    setImmediate(() => {
      const invocation = spawn.mock.calls[0]?.[1] as string[];
      const envNonce = invocation?.find((value) => value.startsWith('AIDEN_CAPABILITY_NONCE='))?.split('=')[1];
      const envInvocation = invocation?.find((value) => value.startsWith('AIDEN_CAPABILITY_INVOCATION_ID='))?.split('=')[1];
      stdout.write(`${JSON.stringify({
        type: 'HELLO', sequence: 0, invocationId: envInvocation, identity,
        nonce: envNonce, protocolVersion: 1,
      })}\n`);
    });
    const result = await host.run({
      manifest, identity, invocationId: 'inv_test_2', installPath: 'C:/capability',
      tool: 'safe_reader', value: {}, broker: {} as never,
    });
    expect(result).toMatchObject({ state: 'completed', output: { ok: true }, exitCode: 0, isolation: 'docker' });
    expect(nonce).toHaveLength(24);
  });

  it('applies the declared runtime limit after the isolated child handshake', async () => {
    const delayedManifest: CapabilityManifest = {
      ...manifest,
      limits: { ...manifest.limits, runtimeMs: 100 },
    };
    const delayedIdentity = capabilityIdentity(delayedManifest);
    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    child.pid = 44_003;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        for (const message of String(chunk).trim().split(/\r?\n/u).map((line) => JSON.parse(line))) {
          if (message.type === 'INVOKE') {
            stdout.write(`${JSON.stringify({
              type: 'RESULT', sequence: 1, invocationId: message.invocationId,
              identity: message.identity, output: { ok: true },
            })}\n`);
            setImmediate(() => child.emit('close', 0, null));
          }
        }
        done();
      },
    });
    const spawn = vi.fn(() => ({ child, resolvedCmd: 'docker', resolvedArgs: [], viaCmdExe: false }));
    const host = new DockerCapabilityProcessHost({
      probe: () => ({ available: true, mechanism: 'docker', image: 'test-image' }),
      spawn: spawn as never,
      removeContainer: vi.fn(),
    });
    setTimeout(() => {
      const invocation = spawn.mock.calls[0]?.[1] as string[];
      const nonce = invocation.find((value) => value.startsWith('AIDEN_CAPABILITY_NONCE='))?.split('=')[1];
      stdout.write(`${JSON.stringify({
        type: 'HELLO', sequence: 0, invocationId: 'inv_delayed_handshake',
        identity: delayedIdentity, nonce, protocolVersion: 1,
      })}\n`);
    }, 150).unref?.();

    await expect(host.run({
      manifest: delayedManifest, identity: delayedIdentity, invocationId: 'inv_delayed_handshake',
      installPath: 'C:/capability', tool: 'safe_reader', value: {}, broker: {} as never,
    })).resolves.toMatchObject({ state: 'completed', output: { ok: true } });
  });

  it('terminates an authenticated child that exceeds its declared execution budget', async () => {
    const boundedManifest: CapabilityManifest = {
      ...manifest,
      limits: { ...manifest.limits, runtimeMs: 100 },
    };
    const boundedIdentity = capabilityIdentity(boundedManifest);
    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    child.pid = 44_004;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn(() => true);
    const remove = vi.fn(() => setImmediate(() => child.emit('close', 137, 'SIGKILL')));
    const spawn = vi.fn(() => ({ child, resolvedCmd: 'docker', resolvedArgs: [], viaCmdExe: false }));
    const host = new DockerCapabilityProcessHost({
      probe: () => ({ available: true, mechanism: 'docker', image: 'test-image' }),
      spawn: spawn as never,
      removeContainer: remove,
    });
    setImmediate(() => {
      const invocation = spawn.mock.calls[0]?.[1] as string[];
      const nonce = invocation.find((value) => value.startsWith('AIDEN_CAPABILITY_NONCE='))?.split('=')[1];
      stdout.write(`${JSON.stringify({
        type: 'HELLO', sequence: 0, invocationId: 'inv_runtime_limit',
        identity: boundedIdentity, nonce, protocolVersion: 1,
      })}\n`);
    });

    await expect(host.run({
      manifest: boundedManifest, identity: boundedIdentity, invocationId: 'inv_runtime_limit',
      installPath: 'C:/capability', tool: 'safe_reader', value: {}, broker: {} as never,
    })).resolves.toMatchObject({ state: 'timed_out', exitCode: 137 });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an identity mismatch and removes the exact container', async () => {
    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    child.pid = undefined;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn(() => { setImmediate(() => child.emit('close', 137, 'SIGKILL')); return true; });
    const remove = vi.fn(() => setImmediate(() => child.emit('close', 137, 'SIGKILL')));
    const spawn = vi.fn(() => ({ child, resolvedCmd: 'docker', resolvedArgs: [], viaCmdExe: false }));
    const host = new DockerCapabilityProcessHost({
      probe: () => ({ available: true, mechanism: 'docker', image: 'test-image' }),
      spawn: spawn as never, removeContainer: remove,
    });
    setImmediate(() => {
      const invocation = spawn.mock.calls[0]?.[1] as string[];
      const envNonce = invocation?.find((value) => value.startsWith('AIDEN_CAPABILITY_NONCE='))?.split('=')[1];
      stdout.write(`${JSON.stringify({
        type: 'HELLO', sequence: 0, invocationId: 'inv_test_3',
        identity: { ...identity, digest: `sha256:${'e'.repeat(64)}` }, nonce: envNonce, protocolVersion: 1,
      })}\n`);
    });
    const result = await host.run({
      manifest, identity, invocationId: 'inv_test_3', installPath: 'C:/capability',
      tool: 'safe_reader', value: {}, broker: {} as never,
    });
    expect(result.state).toBe('protocol_error');
    expect(result.error).toMatch(/identity_mismatch/);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('contains a late stdin EPIPE after cancellation closes the container transport', async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    child.pid = undefined;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.stdin = stdin;
    child.kill = vi.fn(() => true);
    const remove = vi.fn(() => {
      setImmediate(() => {
        const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        stdin.emit('error', error);
        child.emit('close', 137, 'SIGKILL');
      });
    });
    const spawn = vi.fn(() => ({ child, resolvedCmd: 'docker', resolvedArgs: [], viaCmdExe: false }));
    const host = new DockerCapabilityProcessHost({
      probe: () => ({ available: true, mechanism: 'docker', image: 'test-image' }),
      spawn: spawn as never,
      removeContainer: remove,
    });
    const controller = new AbortController();
    const running = host.run({
      manifest, identity, invocationId: 'inv_test_cancel_epipe', installPath: 'C:/capability',
      tool: 'safe_reader', value: {}, broker: {} as never, signal: controller.signal,
    });
    controller.abort();
    await expect(running).resolves.toMatchObject({ state: 'cancelled', exitCode: 137 });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('bounds each JSONL frame independently when one transport chunk carries many valid rows', async () => {
    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    let invocationId = '';
    let sentIdentity: typeof identity;
    child.pid = 44_002;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        for (const message of String(chunk).trim().split(/\r?\n/u).map((line) => JSON.parse(line))) {
          invocationId = message.invocationId;
          sentIdentity = message.identity;
          if (message.type === 'INVOKE') {
            const rows = Array.from({ length: 20 }, (_, index) => JSON.stringify({
              type: 'PROGRESS', sequence: index + 1, invocationId,
              identity: sentIdentity, message: `${index}:${'x'.repeat(400)}`,
            }));
            rows.push(JSON.stringify({
              type: 'RESULT', sequence: 21, invocationId, identity: sentIdentity, output: { ok: true },
            }));
            stdout.write(`${rows.join('\n')}\n`);
            setImmediate(() => child.emit('close', 0, null));
          }
        }
        done();
      },
    });
    const spawn = vi.fn(() => ({ child, resolvedCmd: 'docker', resolvedArgs: [], viaCmdExe: false }));
    const host = new DockerCapabilityProcessHost({
      probe: () => ({ available: true, mechanism: 'docker', image: 'test-image' }),
      spawn: spawn as never,
      removeContainer: vi.fn(),
    });
    setImmediate(() => {
      const invocation = spawn.mock.calls[0]?.[1] as string[];
      const envNonce = invocation.find((value) => value.startsWith('AIDEN_CAPABILITY_NONCE='))?.split('=')[1];
      stdout.write(`${JSON.stringify({
        type: 'HELLO', sequence: 0, invocationId: 'inv_batched_rows', identity,
        nonce: envNonce, protocolVersion: 1,
      })}\n`);
    });

    await expect(host.run({
      manifest, identity, invocationId: 'inv_batched_rows', installPath: 'C:/capability',
      tool: 'safe_reader', value: {}, broker: {} as never,
    })).resolves.toMatchObject({ state: 'completed', output: { ok: true } });
  });
});
