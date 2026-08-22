/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { capabilityIdentity, type CapabilityPermissionDeclaration } from '../../../packages/capability-sdk/src';
import { CapabilityInstaller, computeCapabilityPackageDigest } from './installer';
import type { CapabilityProcessHostPort } from './runtime';
import type { CapabilityStore, InstalledCapabilityVersion } from './store';

export interface CapabilityManagementProjection {
  capabilityId: string;
  displayName: string;
  active: null | { version: string; digest: string; enabled: boolean };
  rollbackTarget: null | { version: string; digest: string };
  health: null | { state: string; consecutiveFailures: number; reason: string | null; checkedAt: number };
  requestedPermissions: CapabilityPermissionDeclaration[];
  grantedPermissions: Array<{ permission: string; scope: Record<string, unknown> }>;
  permissionChanges: { added: CapabilityPermissionDeclaration[]; removed: CapabilityPermissionDeclaration[] };
  versions: Array<{ version: string; digest: string; installedAt: number }>;
  recentInvocations: Array<{
    invocationId: string;
    version: string;
    digest: string;
    state: string;
    startedAt: number;
    terminalAt: number | null;
  }>;
}

export interface CapabilityDoctorProjection {
  broker: 'ready';
  sandbox: { available: boolean; mechanism: 'docker'; image: string; reason?: string };
  installed: number;
  active: number;
  healthy: number;
  degraded: number;
  permissionUpdates: number;
  stagingPending: number;
}

function permissionKey(permission: CapabilityPermissionDeclaration): string {
  return JSON.stringify(permission);
}

function uniqueVersions(records: InstalledCapabilityVersion[]): InstalledCapabilityVersion[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.manifest.id}\0${record.manifest.version}\0${record.manifest.digest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Management projection over the immutable registry. It can install and move
 * active pointers, but it never executes a Job or grants authority implicitly.
 */
export class CapabilityManagementAuthority {
  constructor(private readonly options: {
    store: CapabilityStore;
    installer: CapabilityInstaller;
    processHost: CapabilityProcessHostPort;
    scopeId: string;
    ownerId: string;
    workspaceId: string;
  }) {}

  list(): CapabilityManagementProjection[] {
    const records = uniqueVersions(this.options.store.listVersions());
    const ids = [...new Set(records.map((record) => record.manifest.id))].sort();
    return ids.map((id) => this.inspect(id));
  }

  inspect(capabilityId: string): CapabilityManagementProjection {
    const versions = this.options.store.listVersions(capabilityId);
    if (versions.length === 0) throw new Error(`Capability is not installed: ${capabilityId}`);
    const active = this.options.store.getActive(capabilityId, this.options.scopeId);
    const activeRecord = active
      ? this.options.store.getVersion(capabilityId, active.version, active.digest)
      : null;
    const selected = versions[versions.length - 1]!;
    const identity = capabilityIdentity(selected.manifest);
    const healthIdentity = active?.enabled && activeRecord
      ? capabilityIdentity(activeRecord.manifest)
      : identity;
    const grants = this.options.store.list({
      identity,
      ownerId: this.options.ownerId,
      workspaceId: this.options.workspaceId,
    });
    const previous = activeRecord && activeRecord.manifest.digest !== selected.manifest.digest
      ? activeRecord
      : versions.length > 1 ? versions[versions.length - 2]! : null;
    const before = new Set((previous?.manifest.permissions ?? []).map(permissionKey));
    const after = new Set(selected.manifest.permissions.map(permissionKey));
    const health = this.options.store.getHealth(healthIdentity);
    const rollbackTarget = active?.enabled
      ? this.options.store.rollbackTarget(capabilityId, this.options.scopeId)
      : null;
    return {
      capabilityId,
      displayName: selected.manifest.displayName,
      active: active ? { version: active.version, digest: active.digest, enabled: active.enabled } : null,
      rollbackTarget: rollbackTarget ? {
        version: rollbackTarget.manifest.version,
        digest: rollbackTarget.manifest.digest,
      } : null,
      health: health ? {
        state: health.state,
        consecutiveFailures: health.consecutiveFailures,
        reason: health.lastReason,
        checkedAt: health.lastCheckedAt,
      } : null,
      requestedPermissions: selected.manifest.permissions,
      grantedPermissions: grants.map((grant) => ({ permission: grant.permission, scope: { ...grant.scope } })),
      permissionChanges: {
        added: selected.manifest.permissions.filter((item) => !before.has(permissionKey(item))),
        removed: (previous?.manifest.permissions ?? []).filter((item) => !after.has(permissionKey(item))),
      },
      versions: versions.map((record) => ({
        version: record.manifest.version,
        digest: record.manifest.digest,
        installedAt: record.installedAt,
      })),
      recentInvocations: this.options.store.listInvocations(capabilityId, 20).map((receipt) => ({
        invocationId: receipt.invocationId,
        version: receipt.identity.version,
        digest: receipt.identity.digest,
        state: receipt.state,
        startedAt: receipt.startedAt,
        terminalAt: receipt.terminalAt,
      })),
    };
  }

  async install(sourcePath: string) {
    return this.options.installer.install(sourcePath);
  }

  sandbox() {
    return this.options.processHost.probe();
  }

  activate(input: { capabilityId: string; version: string; digest?: string; acceptPermissions: boolean }) {
    const record = input.digest
      ? this.options.store.getVersion(input.capabilityId, input.version, input.digest)
      : this.options.store.findVersion(input.capabilityId, input.version);
    if (!record || record.uninstalledAt !== null) throw new Error('Capability version is not installed');
    const activated = this.options.installer.activate({
      capabilityId: input.capabilityId,
      version: input.version,
      digest: record.manifest.digest,
      scopeId: this.options.scopeId,
      permissionReviewAccepted: input.acceptPermissions,
    });
    if (input.acceptPermissions) {
      const identity = capabilityIdentity(record.manifest);
      for (const declaration of record.manifest.permissions) {
        this.options.store.grant({
          identity,
          ownerId: this.options.ownerId,
          workspaceId: this.options.workspaceId,
          permission: declaration.kind,
          scope: declaration.scope,
        });
      }
    }
    return activated;
  }

  rollback(capabilityId: string) {
    return this.options.installer.rollback(capabilityId, this.options.scopeId);
  }

  disable(capabilityId: string) {
    return this.options.store.disable(capabilityId, this.options.scopeId);
  }

  async uninstall(input: { capabilityId: string; version: string; digest?: string }): Promise<boolean> {
    const record = input.digest
      ? this.options.store.getVersion(input.capabilityId, input.version, input.digest)
      : this.options.store.findVersion(input.capabilityId, input.version);
    if (!record || record.uninstalledAt !== null) return false;
    const active = this.options.store.listActive().some((candidate) => candidate.enabled
      && candidate.capabilityId === input.capabilityId
      && candidate.version === record.manifest.version
      && candidate.digest === record.manifest.digest);
    if (active) throw new Error('Active capability version must be disabled before uninstall');
    const removed = this.options.store.markUninstalled(
      input.capabilityId,
      record.manifest.version,
      record.manifest.digest,
    );
    if (removed) await fs.rm(record.installPath, { recursive: true, force: true });
    return removed;
  }

  async test(capabilityId: string): Promise<{ healthy: boolean; reasons: string[] }> {
    const active = this.options.store.getActive(capabilityId, this.options.scopeId);
    if (!active?.enabled) throw new Error('Capability is not active');
    const record = this.options.store.getVersion(capabilityId, active.version, active.digest);
    if (!record || record.uninstalledAt !== null) throw new Error('Active capability bytes are unavailable');
    const identity = capabilityIdentity(record.manifest);
    const reasons: string[] = [];
    const digest = await computeCapabilityPackageDigest(record.installPath).catch(() => 'unavailable');
    if (digest !== identity.digest) reasons.push('immutable package digest mismatch');
    const entrypoint = path.resolve(record.installPath, ...record.manifest.entrypoint.split('/'));
    const entry = await fs.lstat(entrypoint).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink()) reasons.push('entrypoint unavailable');
    const sandbox = this.options.processHost.probe();
    if (!sandbox.available) reasons.push(sandbox.reason ?? 'Docker sandbox unavailable');
    const prior = this.options.store.getHealth(identity);
    this.options.store.recordHealth({
      identity,
      state: reasons.length === 0 ? 'healthy' : 'unavailable',
      consecutiveFailures: reasons.length === 0 ? 0 : (prior?.consecutiveFailures ?? 0) + 1,
      lastReason: reasons.join('; ') || null,
      lastCheckedAt: Date.now(),
      lastInvocationId: prior?.lastInvocationId ?? null,
    });
    return { healthy: reasons.length === 0, reasons };
  }

  async doctor(): Promise<CapabilityDoctorProjection> {
    const stagingPending = (await this.options.installer.inspectStaging()).pending;
    const capabilities = this.list();
    const active = capabilities.filter((item) => item.active?.enabled).length;
    return {
      broker: 'ready',
      sandbox: this.options.processHost.probe(),
      installed: capabilities.length,
      active,
      healthy: capabilities.filter((item) => item.health?.state === 'healthy').length,
      degraded: capabilities.filter((item) => item.health && item.health.state !== 'healthy' && item.health.state !== 'unknown').length,
      permissionUpdates: capabilities.filter((item) => item.permissionChanges.added.length > 0).length,
      stagingPending,
    };
  }
}
