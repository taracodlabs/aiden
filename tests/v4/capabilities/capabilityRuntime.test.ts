/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapabilityRuntime, capabilityToolName } from '../../../core/v4/capabilities/runtime';
import { createCapabilityStore, type CapabilityStore } from '../../../core/v4/capabilities/store';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { capabilityIdentity, type CapabilityManifest } from '../../../packages/capability-sdk/src';

let db: Database.Database;
let root: string;
let engine: JobEngine;
let store: CapabilityStore;

function manifest(version = '1.0.0'): CapabilityManifest {
  return {
    manifestVersion: 1, id: 'dev.taracod.summary', version, displayName: 'Summary',
    runtime: { kind: 'node', protocolVersion: 1 }, entrypoint: 'index.js',
    tools: [{
      name: 'summarize', description: 'Summarize granted files.', mutates: false,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      outputSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
    }],
    permissions: [{ kind: 'filesystem.read', scope: { paths: ['**/*'] } }], effects: [], secretSlots: [],
    compatibility: { aiden: '>=4.20 <5', node: '>=20 <21 || >=22 <23', os: ['win32', 'linux', 'darwin'], architectures: ['x64'] },
    limits: { runtimeMs: 5_000, maxMessageBytes: 8_192, maxTotalOutputBytes: 32_768, maxBrokerRequests: 4, maxEvidenceClaims: 2 },
    digest: `sha256:${version.startsWith('2') ? '2' : '1'.repeat(1)}`.replace(/.$/, version.startsWith('2') ? '2'.repeat(64) : '1'.repeat(64)),
  };
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO daemon_instances(instance_id,pid,hostname,started_at,last_heartbeat,version)
    VALUES('cap-runtime',1,'localhost',1,1,'4.20.0')`).run();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-runtime-'));
  engine = createJobEngine({ db });
  store = createCapabilityStore(db);
  const value = manifest();
  store.registerVersion({ manifest: value, installPath: path.join(root, 'installed-v1'), installedAt: 1, uninstalledAt: null, installReceipt: {} });
  store.activate({ capabilityId: value.id, version: value.version, digest: value.digest, scopeId: 'workspace_1', now: 2 });
  store.grant({
    identity: capabilityIdentity(value), ownerId: 'owner_1', workspaceId: 'workspace_1',
    permission: 'filesystem.read', scope: { paths: ['**/*'] },
  });
});

afterEach(async () => {
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function activeJob() {
  const admission = engine.submitJob({
    entryPoint: 'test', source: 'unit', sessionId: 'session_1', workspaceId: 'workspace_1',
    principalId: 'owner_1', instanceId: 'cap-runtime', idempotencyNamespace: 'cap-runtime',
    idempotencyKey: path.basename(root), goal: 'invoke capability',
  });
  const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'cap-runtime', ttlMs: 60_000 });
  engine.transitionAttempt({
    attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!, generation: lease.generation!,
    fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: 'attempt-running', producer: 'test',
  });
  engine.transitionJob({
    jobId: admission.jobId, attemptId: admission.attemptId, generation: lease.generation!, fenceToken: lease.fenceToken!,
    expectedStateVersion: 0, to: 'running', eventIdempotencyKey: 'job-running', producer: 'test',
  });
  return { admission, lease };
}

describe('Capability runtime adapter', () => {
  it('registers an active capability as a normal ToolRegistry adapter with an exact durable receipt', async () => {
    const processHost = { probe: () => ({ available: true, mechanism: 'docker' as const, image: 'test' }), run: vi.fn(async () => ({
      state: 'completed' as const, output: { summary: 'ok' }, claims: [], exitCode: 0,
      exitSignal: null, stderr: '', runtimeMs: 4, isolation: 'docker' as const,
    })) };
    const registry = new ToolRegistry();
    const runtime = new CapabilityRuntime({ store, processHost, canExecute: () => true, integrityVerifier: async () => true });
    runtime.registerActiveTools({ registry, scopeId: 'workspace_1', ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root });
    const toolName = capabilityToolName(capabilityIdentity(manifest()), 'summarize');
    expect(registry.get(toolName)?.toolset).toBe('capabilities');
    const execute = registry.buildExecutor({ cwd: root, paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }) });
    const active = await activeJob();
    const result = await runWithJobExecutionContext({
      engine, jobId: active.admission.jobId, attemptId: active.admission.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => execute({ id: 'provider_capability_1', name: toolName, arguments: {} }));
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ success: true, output: { summary: 'ok' }, invocationId: expect.stringMatching(/^cap_inv_/) });
    expect(processHost.run).toHaveBeenCalledTimes(1);
    expect(store.listInvocations()).toEqual([
      expect.objectContaining({ state: 'completed', jobId: active.admission.jobId, attemptId: active.admission.attemptId, generation: active.lease.generation }),
    ]);
  });

  it('blocks execution when entitlement is unavailable while retaining inspection', async () => {
    const runtime = new CapabilityRuntime({
      store,
      processHost: { probe: () => ({ available: true, mechanism: 'docker' as const, image: 'test' }), run: vi.fn() },
      canExecute: () => false,
      integrityVerifier: async () => true,
    });
    expect(runtime.inspect('dev.taracod.summary', 'workspace_1')).toMatchObject({ active: { version: '1.0.0' } });
    const active = await activeJob();
    await expect(runWithJobExecutionContext({
      engine, jobId: active.admission.jobId, attemptId: active.admission.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => runtime.invoke({
      capabilityId: 'dev.taracod.summary', version: '1.0.0', digest: manifest().digest,
      tool: 'summarize', input: {}, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      executeTool: vi.fn(),
    }))).rejects.toThrow(/entitlement/i);
    expect(store.listInvocations()).toEqual([]);
  });

  it('keeps the admitted immutable version when activation changes during execution', async () => {
    const v2 = manifest('2.0.0');
    store.registerVersion({ manifest: v2, installPath: path.join(root, 'installed-v2'), installedAt: 3, uninstalledAt: null, installReceipt: {} });
    const processHost = { probe: () => ({ available: true, mechanism: 'docker' as const, image: 'test' }), run: vi.fn(async (request: any) => {
      store.activate({ capabilityId: v2.id, version: v2.version, digest: v2.digest, scopeId: 'workspace_1', now: 4 });
      return { state: 'completed' as const, output: { summary: request.identity.version }, claims: [], exitCode: 0, exitSignal: null, stderr: '', runtimeMs: 2, isolation: 'docker' as const };
    }) };
    const runtime = new CapabilityRuntime({ store, processHost, canExecute: () => true, integrityVerifier: async () => true });
    const active = await activeJob();
    const output = await runWithJobExecutionContext({
      engine, jobId: active.admission.jobId, attemptId: active.admission.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => runtime.invoke({
      capabilityId: 'dev.taracod.summary', version: '1.0.0', digest: manifest().digest,
      tool: 'summarize', input: {}, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      executeTool: vi.fn(),
    }));
    expect(output.output).toEqual({ summary: '1.0.0' });
    expect(store.getActive(v2.id, 'workspace_1')?.version).toBe('2.0.0');
    expect(store.listInvocations()[0]?.identity.version).toBe('1.0.0');
  });

  it('refuses execution when installed bytes no longer match the immutable digest', async () => {
    const processHost = {
      probe: () => ({ available: true, mechanism: 'docker' as const, image: 'test' }),
      run: vi.fn(async () => ({
        state: 'completed' as const, output: { summary: 'must-not-run' }, claims: [], exitCode: 0,
        exitSignal: null, stderr: '', runtimeMs: 1, isolation: 'docker' as const,
      })),
    };
    const runtime = new CapabilityRuntime({
      store,
      processHost,
      canExecute: () => true,
      integrityVerifier: vi.fn(async () => false),
    } as never);
    const active = await activeJob();
    await expect(runWithJobExecutionContext({
      engine, jobId: active.admission.jobId, attemptId: active.admission.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => runtime.invoke({
      capabilityId: 'dev.taracod.summary', version: '1.0.0', digest: manifest().digest,
      tool: 'summarize', input: {}, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      executeTool: vi.fn(),
    }))).rejects.toThrow(/immutable.*digest/i);
    expect(processHost.run).not.toHaveBeenCalled();
    expect(store.listInvocations()).toEqual([]);
  });

  it('stores capability claims as non-authoritative events, never host Evidence', async () => {
    const processHost = { probe: () => ({ available: true, mechanism: 'docker' as const, image: 'test' }), run: vi.fn(async () => ({
      state: 'completed' as const, output: { summary: 'claimed' },
      claims: [{ type: 'EVIDENCE_CLAIM', sequence: 1, invocationId: 'child', identity: capabilityIdentity(manifest()), claimId: 'claim_child', category: 'observed', statement: 'I succeeded' }],
      exitCode: 0, exitSignal: null, stderr: '', runtimeMs: 1, isolation: 'docker' as const,
    })) };
    const runtime = new CapabilityRuntime({ store, processHost, canExecute: () => true, integrityVerifier: async () => true });
    const active = await activeJob();
    await runWithJobExecutionContext({
      engine, jobId: active.admission.jobId, attemptId: active.admission.attemptId,
      generation: active.lease.generation!, fenceToken: active.lease.fenceToken!, producer: 'test', workspacePath: root,
    }, () => runtime.invoke({
      capabilityId: 'dev.taracod.summary', version: '1.0.0', digest: manifest().digest,
      tool: 'summarize', input: {}, ownerId: 'owner_1', workspaceId: 'workspace_1', workspaceRoot: root,
      executeTool: vi.fn(),
    }));
    expect(engine.proof.listEvidence(active.admission.jobId)).toEqual([]);
    expect(engine.listEvents(active.admission.jobId).filter((event) => event.type === 'capability.claim_observed')).toHaveLength(1);
  });
});
