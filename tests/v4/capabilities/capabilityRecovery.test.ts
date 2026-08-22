/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapabilityInstaller } from '../../../core/v4/capabilities/installer';
import { CapabilityRecoveryAuthority } from '../../../core/v4/capabilities/recovery';
import { createCapabilityStore } from '../../../core/v4/capabilities/store';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { capabilityIdentity } from '../../../packages/capability-sdk/src';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Capability invocation restart reconciliation', () => {
  it('reopens a dead-host invocation as unknown exactly once and removes its container', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-recovery-'));
    roots.push(root);
    const dbPath = path.join(root, 'daemon.db');
    const first = new Database(dbPath);
    runMigrations(first);
    const firstStore = createCapabilityStore(first);
    const installer = new CapabilityInstaller({ aidenRoot: root, store: firstStore, aidenVersion: '4.20.0' });
    const installed = await installer.install(path.resolve('capabilities/samples/marker-writer'));
    firstStore.createInvocation({
      invocationId: 'cap_inv_recover',
      identity: capabilityIdentity(installed.record.manifest),
      toolName: 'write_marker',
      jobId: 'job_1',
      attemptId: 'attempt_1',
      generation: 1,
      state: 'running',
      permissionDigest: 'sha256:permissions',
      effectRefs: ['effect_1'],
      evidenceRefs: ['evidence_1'],
      startedAt: 1_000,
      terminalAt: null,
      runtimeMs: null,
      exitCode: null,
      exitSignal: null,
      detail: null,
      hostInstanceId: 'host_dead',
      hostPid: 424_242,
      hostStartTime: 900,
    });
    first.close();

    const reopened = new Database(dbPath);
    runMigrations(reopened);
    const store = createCapabilityStore(reopened);
    const removeInvocation = vi.fn(() => 1);
    const authority = new CapabilityRecoveryAuthority({
      store,
      processHost: { removeInvocation },
      currentHost: { instanceId: 'host_new', pid: 7, startTime: 2_000 },
      isProcessAlive: () => false,
      now: () => 5_000,
    });

    expect(authority.reconcile()).toEqual({ recovered: 1, live: 0, failedCleanup: 0 });
    const reconciled = store.getInvocation('cap_inv_recover')!;
    expect(reconciled).toMatchObject({
      state: 'unknown',
      effectRefs: ['effect_1'],
      evidenceRefs: ['evidence_1'],
      terminalAt: 5_000,
      runtimeMs: 4_000,
    });
    expect(() => store.transitionInvocation({
      invocationId: reconciled.invocationId,
      expectedStateVersion: reconciled.stateVersion,
      state: 'completed',
    })).toThrow(/terminal.*immutable/i);
    expect(() => store.transitionInvocation({
      invocationId: reconciled.invocationId,
      expectedStateVersion: reconciled.stateVersion - 1,
      state: 'failed',
    })).toThrow(/state version conflict/i);
    expect(removeInvocation).toHaveBeenCalledWith('cap_inv_recover');
    expect(authority.reconcile()).toEqual({ recovered: 0, live: 0, failedCleanup: 0 });
    reopened.close();
  });

  it('does not reconcile an invocation owned by an exact live process identity', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const store = createCapabilityStore(db);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-recovery-live-'));
    roots.push(root);
    const installer = new CapabilityInstaller({ aidenRoot: root, store, aidenVersion: '4.20.0' });
    const installed = await installer.install(path.resolve('capabilities/samples/workspace-summary'));
    store.createInvocation({
      invocationId: 'cap_inv_live',
      identity: capabilityIdentity(installed.record.manifest),
      toolName: 'workspace_summary',
      jobId: 'job_1',
      attemptId: 'attempt_1',
      generation: 1,
      state: 'running',
      permissionDigest: 'sha256:permissions',
      effectRefs: [],
      evidenceRefs: [],
      startedAt: 1_000,
      terminalAt: null,
      runtimeMs: null,
      exitCode: null,
      exitSignal: null,
      detail: null,
      hostInstanceId: 'host_other',
      hostPid: 77,
      hostStartTime: 900,
    });
    const removeInvocation = vi.fn(() => 1);
    const authority = new CapabilityRecoveryAuthority({
      store,
      processHost: { removeInvocation },
      currentHost: { instanceId: 'host_current', pid: 88, startTime: 800 },
      isProcessAlive: (identity) => identity.pid === 77 && identity.startTime === 900,
      now: () => 5_000,
    });

    expect(authority.reconcile()).toEqual({ recovered: 0, live: 1, failedCleanup: 0 });
    expect(store.getInvocation('cap_inv_live')?.state).toBe('running');
    expect(removeInvocation).not.toHaveBeenCalled();
    db.close();
  });
});
