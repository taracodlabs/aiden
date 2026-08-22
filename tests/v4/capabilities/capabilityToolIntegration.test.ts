/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { CapabilityRuntime, capabilityToolName } from '../../../core/v4/capabilities/runtime';
import { createCapabilityStore, type CapabilityStore } from '../../../core/v4/capabilities/store';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { capabilityIdentity, type CapabilityManifest } from '../../../packages/capability-sdk/src';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { fileWriteTool } from '../../../tools/v4/files/fileWrite';

let db: Database.Database;
let engine: JobEngine;
let store: CapabilityStore;
let root: string;

const writeManifest: CapabilityManifest = {
  manifestVersion: 1, id: 'dev.taracod.marker-writer', version: '1.0.0', displayName: 'Marker writer',
  runtime: { kind: 'node', protocolVersion: 1 }, entrypoint: 'index.js',
  tools: [{
    name: 'write_marker', description: 'Write a reversible marker through Aiden.', mutates: true,
    inputSchema: {
      type: 'object', required: ['path', 'content'], additionalProperties: false,
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    },
    outputSchema: { type: 'object', required: ['written'], properties: { written: { type: 'boolean' } } },
  }],
  permissions: [{ kind: 'filesystem.write', scope: { paths: ['allowed/**/*'] } }],
  effects: [{ tool: 'write_marker', kind: 'filesystem.write', approval: 'required', reversible: true }],
  secretSlots: [],
  compatibility: { aiden: '>=4.20 <5', node: '>=20 <21 || >=22 <23', os: ['win32', 'linux', 'darwin'], architectures: ['x64'] },
  limits: { runtimeMs: 5_000, maxMessageBytes: 8_192, maxTotalOutputBytes: 32_768, maxBrokerRequests: 4, maxEvidenceClaims: 0 },
  digest: `sha256:${'a'.repeat(64)}`,
};

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances(instance_id,pid,hostname,started_at,last_heartbeat,version)
    VALUES('cap-tool',1,'localhost',1,1,'4.20.0')`).run();
  engine = createJobEngine({ db });
  store = createCapabilityStore(db);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-tool-'));
  store.registerVersion({ manifest: writeManifest, installPath: path.join(root, 'installed'), installedAt: 1, uninstalledAt: null, installReceipt: {} });
  store.activate({ capabilityId: writeManifest.id, version: writeManifest.version, digest: writeManifest.digest, scopeId: 'workspace_1' });
  store.grant({
    identity: capabilityIdentity(writeManifest), ownerId: 'owner_1', workspaceId: 'workspace_1',
    permission: 'filesystem.write', scope: { paths: ['allowed/**/*'] },
  });
});

afterEach(async () => {
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function job() {
  const admitted = engine.submitJob({
    entryPoint: 'test', source: 'unit', sessionId: 'cap-tool', workspaceId: 'workspace_1', principalId: 'owner_1',
    instanceId: 'cap-tool', idempotencyNamespace: 'cap-tool', idempotencyKey: path.basename(root), goal: 'write marker',
  });
  const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'cap-tool', ttlMs: 60_000 });
  engine.transitionAttempt({
    attemptId: admitted.attemptId, expectedStateVersion: lease.stateVersion!, generation: lease.generation!,
    fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: 'attempt-running', producer: 'test',
  });
  engine.transitionJob({
    jobId: admitted.jobId, attemptId: admitted.attemptId, generation: lease.generation!, fenceToken: lease.fenceToken!,
    expectedStateVersion: 0, to: 'running', eventIdempotencyKey: 'job-running', producer: 'test',
  });
  return { admitted, lease };
}

function setup(
  decision: 'allow' | 'deny',
  beforeBroker?: () => void,
  failAfterBroker = false,
  terminalAfterBroker?: 'failed' | 'cancelled' | 'timed_out' | 'protocol_error',
) {
  const processHost = {
    probe: () => ({ available: true, mechanism: 'docker' as const, image: 'test' }),
    run: vi.fn(async (request: any) => {
      beforeBroker?.();
      const brokerResult = await request.broker.handle({
        type: 'BROKER_REQUEST', sequence: 1, invocationId: request.invocationId, identity: request.identity,
        requestId: 'request_marker', operation: 'filesystem.write',
        resource: String(request.value.path), arguments: { content: String(request.value.content) },
      });
      if (!brokerResult.ok) return {
        state: 'failed' as const, error: brokerResult.error?.message ?? 'denied', claims: [],
        exitCode: 1, exitSignal: null, stderr: '', runtimeMs: 2, isolation: 'docker' as const,
      };
      if (failAfterBroker) throw new Error('transport lost after broker dispatch');
      if (terminalAfterBroker) return {
        state: terminalAfterBroker,
        error: `child ${terminalAfterBroker} after broker dispatch`,
        claims: [], exitCode: 137, exitSignal: 'SIGKILL', stderr: '', runtimeMs: 3, isolation: 'docker' as const,
      };
      return {
        state: 'completed' as const, output: { written: true }, claims: [], exitCode: 0,
        exitSignal: null, stderr: '', runtimeMs: 3, isolation: 'docker' as const,
      };
    }),
  };
  const registry = new ToolRegistry();
  registry.register(withBuiltInEffectContract(fileWriteTool));
  const runtime = new CapabilityRuntime({
    store, processHost, canExecute: () => true, integrityVerifier: async () => true,
  });
  runtime.registerActiveTools({ registry, scopeId: 'workspace_1', ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root });
  const execute = registry.buildExecutor({
    cwd: root,
    paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
    actionAuthority: createActionAuthority({ db, jobEngine: engine }),
    approvalEngine: new ApprovalEngine('manual', { promptUser: async () => decision }),
    policySnapshot: {
      trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'manual', toolMetadataVersion: 'v4.25',
      sandboxPolicy: { roots: [root], deny: [] }, networkPolicy: {}, pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
    },
  });
  return { runtime, registry, execute, processHost };
}

describe('Capability ToolRegistry integration', () => {
  it('keeps a denied brokered write absent and records no Effect', async () => {
    const subject = setup('deny');
    const active = await job();
    const target = path.join(root, 'allowed', 'marker.txt');
    const result = await runWithJobExecutionContext({
      engine, jobId: active.admitted.jobId, attemptId: active.admitted.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => subject.execute({
      id: 'provider_cap_write_deny', name: capabilityToolName(capabilityIdentity(writeManifest), 'write_marker'),
      arguments: { path: 'allowed/marker.txt', content: 'marker' },
    }));
    expect(result.result).toMatchObject({ success: false, status: 'failed' });
    await expect(fs.stat(target)).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM side_effect_ledger').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT effect_state,approval_state FROM side_effect_ledger').get()).toMatchObject({ approval_state: 'denied' });
  });

  it('writes once only after approval and links host-generated readback Evidence', async () => {
    const subject = setup('allow');
    const active = await job();
    const target = path.join(root, 'allowed', 'marker.txt');
    const call = {
      id: 'provider_cap_write_allow', name: capabilityToolName(capabilityIdentity(writeManifest), 'write_marker'),
      arguments: { path: 'allowed/marker.txt', content: 'marker' },
    };
    const context = {
      engine, jobId: active.admitted.jobId, attemptId: active.admitted.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    };
    const first = await runWithJobExecutionContext(context, () => subject.execute(call));
    expect(first.result).toMatchObject({ success: true, output: { written: true }, effectRefs: [expect.any(String)], evidenceRefs: [expect.any(String)] });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('marker');
    expect(engine.proof.listEvidence(active.admitted.jobId)).toEqual([
      expect.objectContaining({ source: 'repository.change.readback', verificationResult: 'verified', coverage: 'full' }),
    ]);
    expect(store.listInvocations()[0]).toMatchObject({ state: 'completed', effectRefs: [expect.any(String)], evidenceRefs: [expect.any(String)] });
  });

  it('rejects a brokered mutation after fence loss and cannot accept a late success', async () => {
    const active = await job();
    const subject = setup('allow', () => {
      const attempt = engine.getAttempt(active.admitted.attemptId)!;
      engine.transitionAttempt({
        attemptId: attempt.id, expectedStateVersion: attempt.stateVersion, generation: attempt.generation,
        fenceToken: attempt.fenceToken!, to: 'cancelled', eventIdempotencyKey: 'cancel-before-broker', producer: 'test',
      });
    });
    const target = path.join(root, 'allowed', 'marker.txt');
    const result = await runWithJobExecutionContext({
      engine, jobId: active.admitted.jobId, attemptId: active.admitted.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => subject.execute({
      id: 'provider_cap_write_stale', name: capabilityToolName(capabilityIdentity(writeManifest), 'write_marker'),
      arguments: { path: 'allowed/marker.txt', content: 'late' },
    }));
    expect(result.error).toMatch(/stale|authority|cancel/i);
    await expect(fs.stat(target)).rejects.toThrow();
    expect(store.listInvocations()[0]?.state).not.toBe('completed');
  });

  it('records unknown rather than ordinary failure when the host is lost after a brokered mutation', async () => {
    const subject = setup('allow', undefined, true);
    const active = await job();
    const target = path.join(root, 'allowed', 'marker.txt');
    const result = await runWithJobExecutionContext({
      engine, jobId: active.admitted.jobId, attemptId: active.admitted.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => subject.execute({
      id: 'provider_cap_write_unknown', name: capabilityToolName(capabilityIdentity(writeManifest), 'write_marker'),
      arguments: { path: 'allowed/marker.txt', content: 'uncertain' },
    }));
    expect(result.error).toMatch(/transport lost/i);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('uncertain');
    expect(store.listInvocations()[0]).toMatchObject({
      state: 'unknown',
      effectRefs: [expect.any(String)],
      evidenceRefs: [expect.any(String)],
    });
  });

  it('records unknown when timeout follows a successfully brokered mutation', async () => {
    const subject = setup('allow', undefined, false, 'timed_out');
    const active = await job();
    const target = path.join(root, 'allowed', 'marker.txt');
    const result = await runWithJobExecutionContext({
      engine, jobId: active.admitted.jobId, attemptId: active.admitted.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => subject.execute({
      id: 'provider_cap_write_timeout_unknown', name: capabilityToolName(capabilityIdentity(writeManifest), 'write_marker'),
      arguments: { path: 'allowed/marker.txt', content: 'uncertain-timeout' },
    }));
    expect(result.result).toMatchObject({ success: false, status: 'unknown' });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('uncertain-timeout');
    expect(store.listInvocations()[0]).toMatchObject({
      state: 'unknown',
      effectRefs: [expect.any(String)],
      evidenceRefs: [expect.any(String)],
    });
  });
});
