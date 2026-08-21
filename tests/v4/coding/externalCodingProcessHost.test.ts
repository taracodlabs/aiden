/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createExternalCodingEnvironment,
  ExternalCodingEnvironmentError,
} from '../../../core/v4/coding/environmentPolicy';
import {
  ExternalCodingProcessHost,
  ExternalCodingProcessHostError,
  terminatePersistedExternalCodingProcess,
} from '../../../core/v4/coding/processHost';

const roots: string[] = [];

async function directories() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-host-workspace-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-host-home-'));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-host-temp-'));
  roots.push(workspace, home, temp);
  return { workspace, home, temp };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('external coding environment policy', () => {
  it('constructs an explicit environment with isolated HOME and no ambient canary', async () => {
    const dirs = await directories();
    const environment = createExternalCodingEnvironment({
      platform: process.platform,
      source: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        SECRET_CANARY: 'must-not-cross',
        GITHUB_TOKEN: 'must-not-cross',
        SSH_AUTH_SOCK: 'must-not-cross',
      },
      sessionHome: dirs.home,
      sessionTemp: dirs.temp,
      approved: { CODING_RUNTIME_MARKER: 'approved' },
      approvedKeys: ['CODING_RUNTIME_MARKER'],
    });

    expect(environment.HOME).toBe(dirs.home);
    expect(environment.USERPROFILE).toBe(dirs.home);
    expect(environment.TEMP).toBe(dirs.temp);
    expect(environment.SECRET_CANARY).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.SSH_AUTH_SOCK).toBeUndefined();
    expect(environment.CODING_RUNTIME_MARKER).toBe('approved');
  });

  it('keeps Windows application caches inside the isolated session home', async () => {
    const dirs = await directories();
    const environment = createExternalCodingEnvironment({
      platform: 'win32',
      source: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        APPDATA: 'C:\\Users\\real\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local',
      },
      sessionHome: dirs.home,
      sessionTemp: dirs.temp,
    });

    expect(environment.APPDATA).toBe(path.join(dirs.home, 'AppData', 'Roaming'));
    expect(environment.LOCALAPPDATA).toBe(path.join(dirs.home, 'AppData', 'Local'));
    expect(environment.APPDATA).not.toContain('Users\\real');
    expect(environment.LOCALAPPDATA).not.toContain('Users\\real');
  });

  it('rejects undeclared adapter environment and unsafe HOME override', async () => {
    const dirs = await directories();
    expect(() => createExternalCodingEnvironment({
      source: process.env,
      sessionHome: dirs.home,
      sessionTemp: dirs.temp,
      approved: { UNDECLARED_SECRET: 'no' },
      approvedKeys: [],
    })).toThrow(ExternalCodingEnvironmentError);
    expect(() => createExternalCodingEnvironment({
      source: process.env,
      sessionHome: dirs.home,
      sessionTemp: dirs.temp,
      approved: { HOME: 'C:\\Users\\real' },
      approvedKeys: ['HOME'],
    })).toThrow(/HOME|reserved/i);
  });
});

describe('external coding structured process host', () => {
  it('fails closed when the required sandbox grant is unavailable', async () => {
    const dirs = await directories();
    const host = new ExternalCodingProcessHost();
    await expect(host.start({
      codingSessionId: 'coding_session_no_sandbox', childAttemptId: 'attempt_one', generation: 1,
      executable: process.execPath, executableVersion: process.version, args: ['-e', ''], cwd: dirs.workspace,
      environment: { PATH: process.env.PATH ?? '', HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp },
      protocolMode: 'structured',
      sandbox: { required: true, available: false, authority: 'none', networkEnforced: false, workspaceWriteBoundaryEnforced: false },
      limits: { outputBytes: 1024, rawLogBytes: 1024 },
    })).rejects.toBeInstanceOf(ExternalCodingProcessHostError);
  });

  it('captures bounded redacted output and receives one authoritative clean exit', async () => {
    const dirs = await directories();
    const host = new ExternalCodingProcessHost();
    const canary = 'CANARY_SECRET_4X9Q';
    const handle = await host.start({
      codingSessionId: 'coding_session_output', childAttemptId: 'attempt_output', generation: 2,
      executable: process.execPath,
      executableVersion: process.version,
      args: ['-e', `process.stdout.write(JSON.stringify({type:'ready'})+'\\n');process.stderr.write('${canary} '+'x'.repeat(5000));`],
      cwd: dirs.workspace,
      environment: { PATH: process.env.PATH ?? '', HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp },
      protocolMode: 'structured',
      sandbox: { required: true, available: true, authority: 'test-fixture', networkEnforced: true, workspaceWriteBoundaryEnforced: true },
      limits: { outputBytes: 512, rawLogBytes: 256 },
      redactionCanaries: [canary],
    });
    const exit = await host.wait(handle.processRecordId, 10_000);
    const output = host.output(handle.processRecordId);

    expect(exit).toMatchObject({ exitCode: 0, treeDeadVerified: true });
    expect(output.text).not.toContain(canary);
    expect(output.text).toContain('[redacted]');
    expect(output.stdout).toContain('"type":"ready"');
    expect(output.stderr).toContain('[redacted]');
    expect(output.stdout).not.toContain('[redacted]');
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.text, 'utf8')).toBeLessThanOrEqual(256);
    expect(host.active()).toEqual([]);
  });

  it('does not settle before output pipes close', async () => {
    const dirs = await directories();
    const host = new ExternalCodingProcessHost();
    const lateRecord = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final-result' } });
    const parent = `process.stdout.write('x'.repeat(512 * 1024) + ${JSON.stringify(`${lateRecord}\n`)})`;
    const handle = await host.start({
      codingSessionId: 'coding_session_late_pipe', childAttemptId: 'attempt_late_pipe', generation: 1,
      executable: process.execPath, executableVersion: process.version, args: ['-e', parent], cwd: dirs.workspace,
      environment: { PATH: process.env.PATH ?? '', HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp },
      protocolMode: 'structured',
      sandbox: { required: true, available: true, authority: 'test-fixture', networkEnforced: true, workspaceWriteBoundaryEnforced: true },
      limits: { outputBytes: 1024 * 1024, rawLogBytes: 1024 * 1024 },
    });

    const exit = await host.wait(handle.processRecordId, 10_000);

    expect(exit).toMatchObject({ exitCode: 0, treeDeadVerified: true });
    expect(host.output(handle.processRecordId).stdout).toContain(lateRecord);
    expect(host.active()).toEqual([]);
  });

  it('writes structured stdin and terminates only the owned process identity', async () => {
    const dirs = await directories();
    const host = new ExternalCodingProcessHost();
    const handle = await host.start({
      codingSessionId: 'coding_session_stdin', childAttemptId: 'attempt_stdin', generation: 4,
      executable: process.execPath, executableVersion: process.version,
      args: ['-e', `process.stdin.once('data',d=>{process.stdout.write(d,()=>process.exit(0))})`],
      cwd: dirs.workspace,
      environment: { PATH: process.env.PATH ?? '', HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp },
      protocolMode: 'structured',
      sandbox: { required: true, available: true, authority: 'test-fixture', networkEnforced: true, workspaceWriteBoundaryEnforced: true },
      limits: { outputBytes: 4096, rawLogBytes: 4096 },
    });
    host.send(handle.processRecordId, '{"kind":"clarification"}\n');
    const exit = await host.wait(handle.processRecordId, 10_000);
    expect(host.output(handle.processRecordId).text).toContain('clarification');
    expect(exit.exitCode).toBe(0);
  });

  it('redacts a canary even when it is split across output chunks', async () => {
    const dirs = await directories();
    const host = new ExternalCodingProcessHost();
    const canary = 'CANARY_SPLIT_SECRET_8K2Q';
    const handle = await host.start({
      codingSessionId: 'coding_session_split_canary', childAttemptId: 'attempt_split_canary', generation: 5,
      executable: process.execPath, executableVersion: process.version,
      args: ['-e', `process.stdout.write('${canary.slice(0, 12)}');setTimeout(()=>process.stdout.end('${canary.slice(12)}'),75)`],
      cwd: dirs.workspace,
      environment: { PATH: process.env.PATH ?? '', HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp },
      protocolMode: 'structured',
      sandbox: { required: true, available: true, authority: 'test-fixture', networkEnforced: true, workspaceWriteBoundaryEnforced: true },
      limits: { outputBytes: 4096, rawLogBytes: 4096 },
      redactionCanaries: [canary],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.output(handle.processRecordId).text).not.toContain(canary.slice(0, 12));
    await host.wait(handle.processRecordId, 10_000);
    expect(host.output(handle.processRecordId).text).toContain('[redacted]');
    expect(host.output(handle.processRecordId).text).not.toContain(canary);
  });

  it('kills and verifies an attributable parent and child process tree', async () => {
    const dirs = await directories();
    const host = new ExternalCodingProcessHost();
    const script = [
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      "process.stdout.write(String(child.pid)+'\\n')",
      "setInterval(()=>{},1000)",
    ].join(';');
    const handle = await host.start({
      codingSessionId: 'coding_session_tree', childAttemptId: 'attempt_tree', generation: 6,
      executable: process.execPath, executableVersion: process.version, args: ['-e', script], cwd: dirs.workspace,
      environment: { PATH: process.env.PATH ?? '', HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp },
      protocolMode: 'structured',
      sandbox: { required: true, available: true, authority: 'test-fixture', networkEnforced: true, workspaceWriteBoundaryEnforced: true },
      limits: { outputBytes: 4096, rawLogBytes: 4096 },
    });
    let childPid = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && childPid === 0) {
      const parsed = Number(host.output(handle.processRecordId).text.trim());
      if (Number.isInteger(parsed) && parsed > 0) childPid = parsed;
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(childPid).toBeGreaterThan(0);
    host.inspect(handle.processRecordId);
    const exit = await host.cancel(handle.processRecordId);
    expect(exit.treeDeadVerified).toBe(true);
    expect(() => process.kill(handle.identity.pid, 0)).toThrow();
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(host.active()).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('captures and terminates a child when its Windows parent exits before the periodic tree sample', async () => {
    const dirs = await directories();
    const host = new ExternalCodingProcessHost();
    const script = [
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true})",
      'child.unref()',
      "process.stdout.write(String(child.pid)+'\\n')",
      'setTimeout(()=>process.exit(0),150)',
    ].join(';');
    const handle = await host.start({
      codingSessionId: 'coding_session_fast_parent', childAttemptId: 'attempt_fast_parent', generation: 7,
      executable: process.execPath, executableVersion: process.version, args: ['-e', script], cwd: dirs.workspace,
      environment: { PATH: process.env.PATH ?? '', HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp },
      protocolMode: 'structured',
      sandbox: { required: true, available: true, authority: 'test-fixture', networkEnforced: true, workspaceWriteBoundaryEnforced: true },
      limits: { outputBytes: 4096, rawLogBytes: 4096 },
    });
    let childPid = 0;
    try {
      const exit = await host.wait(handle.processRecordId, 10_000);
      childPid = Number(host.output(handle.processRecordId).stdout.trim());
      expect(childPid).toBeGreaterThan(0);
      expect(() => process.kill(childPid, 0)).not.toThrow();
      expect(exit.treeDeadVerified).toBe(false);

      const cancelled = await host.cancel(handle.processRecordId);
      expect(cancelled.treeDeadVerified).toBe(true);
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(host.active()).toEqual([]);
    } finally {
      if (childPid > 0) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* exact test child already exited */ }
      }
    }
  });

  it('terminates an exact persisted process identity after the original host is lost', async () => {
    const dirs = await directories();
    const host = new ExternalCodingProcessHost();
    const handle = await host.start({
      codingSessionId: 'coding_session_recovery_tree', childAttemptId: 'attempt_recovery_tree', generation: 7,
      executable: process.execPath, executableVersion: process.version,
      args: ['-e', 'setInterval(()=>{},1000)'], cwd: dirs.workspace,
      environment: { PATH: process.env.PATH ?? '', HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp },
      protocolMode: 'structured',
      sandbox: { required: true, available: true, authority: 'test-fixture', networkEnforced: true, workspaceWriteBoundaryEnforced: true },
      limits: { outputBytes: 4096, rawLogBytes: 4096 },
    });

    const result = terminatePersistedExternalCodingProcess(handle.identity);
    const exit = await host.wait(handle.processRecordId, 10_000);

    expect(result).toMatchObject({ identityMatched: true, treeDeadVerified: true });
    expect(exit.treeDeadVerified).toBe(true);
    expect(() => process.kill(handle.identity.pid, 0)).toThrow();
    expect(host.active()).toEqual([]);
  });

  it('never kills a PID whose persisted creation time no longer matches', async () => {
    const dirs = await directories();
    const host = new ExternalCodingProcessHost();
    const handle = await host.start({
      codingSessionId: 'coding_session_reused_pid', childAttemptId: 'attempt_reused_pid', generation: 8,
      executable: process.execPath, executableVersion: process.version,
      args: ['-e', 'setInterval(()=>{},1000)'], cwd: dirs.workspace,
      environment: { PATH: process.env.PATH ?? '', HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp },
      protocolMode: 'structured',
      sandbox: { required: true, available: true, authority: 'test-fixture', networkEnforced: true, workspaceWriteBoundaryEnforced: true },
      limits: { outputBytes: 4096, rawLogBytes: 4096 },
    });

    const result = terminatePersistedExternalCodingProcess({ ...handle.identity, startTime: 1 });

    expect(result).toMatchObject({ identityMatched: false, treeDeadVerified: false });
    expect(() => process.kill(handle.identity.pid, 0)).not.toThrow();
    await host.cancel(handle.processRecordId);
    expect(host.active()).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('proves an already-exited persisted Windows process has no surviving child lineage', async () => {
    expect(terminatePersistedExternalCodingProcess({
      pid: 2_147_480_000,
      startTime: Date.now() - 1_000,
      executable: process.execPath,
      version: process.version,
      cwd: os.tmpdir(),
      mode: 'structured',
    })).toMatchObject({
      identityMatched: true,
      signalIssued: false,
      treeDeadVerified: true,
    });
  });
});
