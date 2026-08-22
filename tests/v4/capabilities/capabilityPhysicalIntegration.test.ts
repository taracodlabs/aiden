/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { CapabilityInstaller } from '../../../core/v4/capabilities/installer';
import { CapabilityManagementAuthority } from '../../../core/v4/capabilities/management';
import { DockerCapabilityProcessHost } from '../../../core/v4/capabilities/processHost';
import { CapabilityRuntime, capabilityToolName } from '../../../core/v4/capabilities/runtime';
import { createCapabilityStore } from '../../../core/v4/capabilities/store';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { capabilityIdentity } from '../../../packages/capability-sdk/src';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { fileReadTool } from '../../../tools/v4/files/fileRead';
import { fileWriteTool } from '../../../tools/v4/files/fileWrite';

const physical = process.env.AIDEN_CAPABILITY_DOCKER_SECURITY === '1' ? describe : describe.skip;
let root = '';
let outsideRoot = '';
let db: Database.Database;
let engine: ReturnType<typeof createJobEngine>;
let registry: ToolRegistry;
let store: ReturnType<typeof createCapabilityStore>;
let runtime: CapabilityRuntime;
let readTool = '';
let writeTool = '';

async function runningJob(key: string) {
  const admitted = engine.submitJob({
    entryPoint: 'test', source: 'physical-capability', sessionId: 'physical-capability',
    workspaceId: root, principalId: 'local-user', instanceId: 'physical-capability',
    idempotencyNamespace: 'physical-capability', idempotencyKey: key, goal: key,
  });
  const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'physical-capability', ttlMs: 60_000 });
  engine.transitionAttempt({
    attemptId: admitted.attemptId, expectedStateVersion: lease.stateVersion!, generation: lease.generation!,
    fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: `attempt:${key}`, producer: 'test',
  });
  engine.transitionJob({
    jobId: admitted.jobId, attemptId: admitted.attemptId, generation: lease.generation!,
    fenceToken: lease.fenceToken!, expectedStateVersion: 0, to: 'running',
    eventIdempotencyKey: `job:${key}`, producer: 'test',
  });
  return { admitted, lease };
}

function executor(decision: 'allow' | 'deny') {
  return registry.buildExecutor({
    cwd: root,
    paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
    actionAuthority: createActionAuthority({ db, jobEngine: engine }),
    approvalEngine: new ApprovalEngine('manual', { promptUser: async () => decision }),
    policySnapshot: {
      trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'manual',
      toolMetadataVersion: 'v4.25', sandboxPolicy: { roots: [root], deny: [] },
      networkPolicy: {}, pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
    },
  });
}

physical('physical brokered capability execution', () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-physical-'));
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-outside-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO daemon_instances(instance_id,pid,hostname,started_at,last_heartbeat,version)
      VALUES('physical-capability',1,'localhost',1,1,'4.20.0')`).run();
    engine = createJobEngine({ db });
    store = createCapabilityStore(db);
    const installer = new CapabilityInstaller({ aidenRoot: path.join(root, '.aiden'), store, aidenVersion: '4.20.0', nodeVersion: '22.23.1' });
    const processHost = new DockerCapabilityProcessHost({
      runtimePath: path.resolve('dist/core/v4/capabilities/containerRuntime.js'),
    });
    const management = new CapabilityManagementAuthority({
      store, installer, processHost, scopeId: root, ownerId: 'local-user', workspaceId: root,
    });
    const read = await management.install(path.resolve('capabilities/samples/workspace-summary'));
    const write = await management.install(path.resolve('capabilities/samples/marker-writer'));
    management.activate({ capabilityId: read.record.manifest.id, version: read.record.manifest.version, acceptPermissions: true });
    management.activate({ capabilityId: write.record.manifest.id, version: write.record.manifest.version, acceptPermissions: true });
    registry = new ToolRegistry();
    registry.register(fileReadTool);
    registry.register(withBuiltInEffectContract(fileWriteTool));
    runtime = new CapabilityRuntime({ store, processHost, canExecute: () => true });
    runtime.registerActiveTools({ registry, scopeId: root, ownerId: 'local-user', workspaceId: root, workspaceRoot: root });
    readTool = capabilityToolName(capabilityIdentity(read.record.manifest), 'workspace_summary');
    writeTool = capabilityToolName(capabilityIdentity(write.record.manifest), 'write_marker');
  }, 30_000);

  afterAll(async () => {
    db.close();
    await Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  it('reads only a granted workspace file through the normal durable ToolCall path', async () => {
    await fs.writeFile(path.join(root, 'allowed.txt'), 'BROKER_READ_OK', 'utf8');
    const active = await runningJob(`read-${randomBytes(4).toString('hex')}`);
    const result = await runWithJobExecutionContext({
      engine, jobId: active.admitted.jobId, attemptId: active.admitted.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => executor('deny')({ id: 'physical_read', name: readTool, arguments: { paths: ['allowed.txt'] } }));
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.result)).toContain('BROKER_READ_OK');
    expect(store.listInvocations()[0]).toMatchObject({ state: 'completed', jobId: active.admitted.jobId });
  }, 30_000);

  it('denies a brokered read through a workspace symlink or junction to another root', async () => {
    const secret = `CROSS_WORKSPACE_${randomBytes(12).toString('hex')}`;
    await fs.writeFile(path.join(outsideRoot, 'secret.txt'), secret, 'utf8');
    await fs.symlink(outsideRoot, path.join(root, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const active = await runningJob(`symlink-${randomBytes(4).toString('hex')}`);
    const result = await runWithJobExecutionContext({
      engine, jobId: active.admitted.jobId, attemptId: active.admitted.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => executor('deny')({
      id: 'physical_read_symlink', name: readTool, arguments: { paths: ['linked-outside/secret.txt'] },
    }));
    expect(JSON.stringify(result)).toMatch(/outside_workspace|permission_denied/i);
    expect(JSON.stringify(result)).not.toContain(secret);
  }, 30_000);

  it('keeps a denied mutation absent and performs an approved mutation once with Evidence', async () => {
    const target = path.join(root, 'capability-output', 'marker.txt');
    const denied = await runningJob(`deny-${randomBytes(4).toString('hex')}`);
    await runWithJobExecutionContext({
      engine, jobId: denied.admitted.jobId, attemptId: denied.admitted.attemptId,
      generation: denied.lease.generation!, fenceToken: denied.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => executor('deny')({ id: 'physical_write_deny', name: writeTool, arguments: { path: 'capability-output/marker.txt', content: 'marker' } }));
    await expect(fs.stat(target)).rejects.toThrow();

    const approved = await runningJob(`allow-${randomBytes(4).toString('hex')}`);
    const result = await runWithJobExecutionContext({
      engine, jobId: approved.admitted.jobId, attemptId: approved.admitted.attemptId,
      generation: approved.lease.generation!, fenceToken: approved.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => executor('allow')({ id: 'physical_write_allow', name: writeTool, arguments: { path: 'capability-output/marker.txt', content: 'marker' } }));
    expect(result.error).toBeUndefined();
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('marker');
    expect(engine.proof.listEvidence(approved.admitted.jobId)).toEqual([
      expect.objectContaining({ source: 'repository.change.readback', verificationResult: 'verified' }),
    ]);
  }, 30_000);

  it('rejects a delayed physical broker mutation after fence loss', async () => {
    const target = path.join(root, 'capability-output', 'stale.txt');
    const active = await runningJob(`stale-${randomBytes(4).toString('hex')}`);
    const running = runWithJobExecutionContext({
      engine, jobId: active.admitted.jobId, attemptId: active.admitted.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => executor('allow')({
      id: 'physical_write_stale', name: writeTool,
      arguments: { path: 'capability-output/stale.txt', content: 'late', delayMs: 700 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const attempt = engine.getAttempt(active.admitted.attemptId)!;
    engine.transitionAttempt({
      attemptId: attempt.id, expectedStateVersion: attempt.stateVersion, generation: attempt.generation,
      fenceToken: attempt.fenceToken!, to: 'cancelled', eventIdempotencyKey: 'physical-fence-loss', producer: 'test',
    });
    const result = await running;
    expect(JSON.stringify(result)).toMatch(/stale|authority|denied/i);
    await expect(fs.stat(target)).rejects.toThrow();
    expect(store.listInvocations()[0]?.state).not.toBe('completed');
  }, 30_000);

  it('keeps a brokered mutation unknown when the child exits before acknowledging it', async () => {
    const target = path.join(root, 'capability-output', 'unknown.txt');
    const active = await runningJob(`unknown-${randomBytes(4).toString('hex')}`);
    const result = await runWithJobExecutionContext({
      engine, jobId: active.admitted.jobId, attemptId: active.admitted.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => executor('allow')({
      id: 'physical_write_unknown', name: writeTool,
      arguments: {
        path: 'capability-output/unknown.txt', content: 'written-before-child-exit', crashAfterBroker: true,
      },
    }));

    expect(JSON.stringify(result)).toMatch(/unknown/i);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('written-before-child-exit');
    const receipt = store.listInvocations()[0]!;
    expect(receipt).toMatchObject({
      state: 'unknown',
      effectRefs: [expect.any(String)],
      evidenceRefs: [expect.any(String)],
    });
    expect(engine.proof.listEvidence(active.admitted.jobId)).toHaveLength(1);
  }, 30_000);
});
