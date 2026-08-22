/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DockerCapabilityProcessHost } from '../../../core/v4/capabilities/processHost';
import { CapabilityInstaller } from '../../../core/v4/capabilities/installer';
import { CapabilityRecoveryAuthority } from '../../../core/v4/capabilities/recovery';
import { createCapabilityStore } from '../../../core/v4/capabilities/store';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { getProcessCreationTime } from '../../../core/v4/util/spawnCommand';
import { capabilityIdentity, validateCapabilityManifest, type CapabilityManifest } from '../../../packages/capability-sdk/src';
import Database from 'better-sqlite3';

const physical = process.env.AIDEN_CAPABILITY_DOCKER_SECURITY === '1' ? describe : describe.skip;
let root = '';
let server: http.Server;
let serverUrl = '';
let requests = 0;

async function manifestAt(directory: string): Promise<CapabilityManifest> {
  const parsed = JSON.parse(await fs.readFile(path.join(directory, 'capability.json'), 'utf8'));
  const checked = validateCapabilityManifest(parsed);
  if (!checked.ok || !checked.manifest) throw new Error(checked.errors.join('; '));
  return checked.manifest;
}

physical('physical Docker capability security boundary', () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-hostile-'));
    server = http.createServer((_request, response) => {
      requests += 1;
      response.end('unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local sentinel listener did not bind');
    serverUrl = `http://host.docker.internal:${address.port}/sentinel`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('denies direct host files, parent secrets, network, writes and child processes', async () => {
    const forbiddenRead = path.join(root, 'forbidden-read.txt');
    const forbiddenWrite = path.join(root, 'forbidden-write.txt');
    const marker = randomBytes(24).toString('hex');
    await fs.writeFile(forbiddenRead, marker, 'utf8');
    const fixture = path.resolve('capabilities/fixtures/malicious-host-access');
    const manifest = await manifestAt(fixture);
    const host = new DockerCapabilityProcessHost({
      runtimePath: path.resolve('dist/core/v4/capabilities/containerRuntime.js'),
      sourceEnvironment: { ...process.env, AIDEN_HOST_SENTINEL_SECRET: marker },
    });
    const result = await host.run({
      manifest, identity: capabilityIdentity(manifest), invocationId: `inv_hostile_${randomBytes(6).toString('hex')}`,
      installPath: fixture, tool: 'hostile_probe',
      value: { forbiddenRead, forbiddenWrite, url: serverUrl },
      broker: {} as never,
    });
    expect(result).toMatchObject({
      state: 'completed',
      output: {
        directRead: false, traversalRead: false, directWrite: false,
        network: false, childSpawn: false, parentSecretObserved: false,
      },
    });
    await expect(fs.readFile(forbiddenRead, 'utf8')).resolves.toBe(marker);
    await expect(fs.stat(forbiddenWrite)).rejects.toThrow();
    expect(requests).toBe(0);
    expect(result.stderr).not.toContain(marker);
  }, 30_000);

  it('cancels a hanging capability and leaves no labeled container', async () => {
    const fixture = path.resolve('capabilities/fixtures/hanging');
    const manifest = await manifestAt(fixture);
    const host = new DockerCapabilityProcessHost({
      runtimePath: path.resolve('dist/core/v4/capabilities/containerRuntime.js'),
    });
    const controller = new AbortController();
    const invocationId = `inv_cancel_${randomBytes(6).toString('hex')}`;
    const running = host.run({
      manifest, identity: capabilityIdentity(manifest), invocationId,
      installPath: fixture, tool: 'hang', value: {}, broker: {} as never, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 500).unref?.();
    await expect(running).resolves.toMatchObject({ state: 'cancelled' });
    const containers = execFileSync('docker', [
      'ps', '-a', '--filter', `label=com.taracod.aiden.invocation=${invocationId}`, '--format', '{{.ID}}',
    ], { encoding: 'utf8', timeout: 5_000 }).trim();
    expect(containers).toBe('');
  }, 30_000);

  it('kills an orphaned container and marks its durable invocation unknown after host death', async () => {
    const durableRoot = path.join(root, 'host-kill');
    await fs.mkdir(durableRoot, { recursive: true });
    const dbPath = path.join(durableRoot, 'daemon.db');
    let durableDb = new Database(dbPath);
    durableDb.pragma('foreign_keys = ON');
    runMigrations(durableDb);
    const firstStore = createCapabilityStore(durableDb);
    const installer = new CapabilityInstaller({ aidenRoot: durableRoot, store: firstStore, aidenVersion: '4.20.0' });
    const installed = await installer.install(path.resolve('capabilities/fixtures/hanging'));
    durableDb.close();

    const invocationId = `inv_host_kill_${randomBytes(6).toString('hex')}`;
    const child = spawn(process.execPath, [
      path.resolve('tests/v4/capabilities/fixtures/hostKillChild.cjs'),
      path.resolve('.'), dbPath, installed.record.installPath, invocationId,
    ], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const ready = await new Promise<{ pid: number }>((resolve, reject) => {
      let output = '';
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('exit', onEarlyExit);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onEarlyExit = (code: number | null) => {
        cleanup();
        reject(new Error(`host-kill fixture exited early: ${code}`));
      };
      const onData = (chunk: Buffer) => {
        output += String(chunk);
        const line = output.split(/\r?\n/u).find(Boolean);
        if (!line) return;
        cleanup();
        try { resolve(JSON.parse(line) as { pid: number }); } catch (error) { reject(error); }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('host-kill fixture did not become ready'));
      }, 10_000);
      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('exit', onEarlyExit);
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const container = execFileSync('docker', [
        'ps', '-a', '--filter', `label=com.taracod.aiden.invocation=${invocationId}`, '--format', '{{.ID}}',
      ], { encoding: 'utf8', timeout: 5_000 }).trim();
      if (container) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const beforeKill = execFileSync('docker', [
      'ps', '-a', '--filter', `label=com.taracod.aiden.invocation=${invocationId}`, '--format', '{{.ID}}',
    ], { encoding: 'utf8', timeout: 5_000 }).trim();
    expect(beforeKill).not.toBe('');
    expect(ready.pid).toBe(child.pid);
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', timeout: 5_000, windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
    await exited;

    durableDb = new Database(dbPath);
    durableDb.pragma('foreign_keys = ON');
    runMigrations(durableDb);
    const reopenedStore = createCapabilityStore(durableDb);
    const host = new DockerCapabilityProcessHost({
      runtimePath: path.resolve('dist/core/v4/capabilities/containerRuntime.js'),
    });
    const recovery = new CapabilityRecoveryAuthority({
      store: reopenedStore,
      processHost: host,
      currentHost: {
        instanceId: `recovery_${process.pid}`,
        pid: process.pid,
        startTime: getProcessCreationTime(process.pid),
      },
    }).reconcile();
    expect(recovery).toEqual({ recovered: 1, live: 0, failedCleanup: 0 });
    expect(reopenedStore.getInvocation(invocationId)).toMatchObject({ state: 'unknown' });
    const afterRecovery = execFileSync('docker', [
      'ps', '-a', '--filter', `label=com.taracod.aiden.invocation=${invocationId}`, '--format', '{{.ID}}',
    ], { encoding: 'utf8', timeout: 5_000 }).trim();
    expect(afterRecovery).toBe('');
    durableDb.close();
  }, 45_000);
});
