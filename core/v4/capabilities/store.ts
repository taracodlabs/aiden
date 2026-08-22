/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import {
  capabilityIdentity,
  type CapabilityIdentity,
  type CapabilityManifest,
  type CapabilityPermissionKind,
  type CapabilityPermissionScope,
} from '../../../packages/capability-sdk/src';
import type { CapabilityGrant, CapabilityGrantReader } from './permissionAuthority';

export interface InstalledCapabilityVersion {
  manifest: CapabilityManifest;
  installPath: string;
  installedAt: number;
  uninstalledAt: number | null;
  installReceipt: Record<string, unknown>;
}

export interface ActiveCapabilityVersion {
  capabilityId: string;
  scopeId: string;
  version: string;
  digest: string;
  enabled: boolean;
  stateVersion: number;
  activatedAt: number;
}

export type CapabilityInvocationState =
  | 'admitted' | 'starting' | 'running' | 'waiting_approval' | 'completed'
  | 'failed' | 'cancelled' | 'timed_out' | 'protocol_error' | 'unknown';

export interface CapabilityInvocationReceipt {
  invocationId: string;
  identity: CapabilityIdentity;
  toolName: string;
  jobId: string | null;
  attemptId: string | null;
  generation: number | null;
  hostInstanceId: string;
  hostPid: number;
  hostStartTime: number | null;
  state: CapabilityInvocationState;
  permissionDigest: string;
  effectRefs: string[];
  evidenceRefs: string[];
  startedAt: number;
  terminalAt: number | null;
  runtimeMs: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  detail: string | null;
  stateVersion: number;
}

export interface CapabilityHealthRecord {
  identity: CapabilityIdentity;
  state: 'unknown' | 'healthy' | 'degraded' | 'unavailable' | 'quarantined';
  consecutiveFailures: number;
  lastReason: string | null;
  lastCheckedAt: number;
  lastInvocationId: string | null;
}

export interface CapabilityStore extends CapabilityGrantReader {
  registerVersion(record: InstalledCapabilityVersion): { inserted: boolean; record: InstalledCapabilityVersion };
  getVersion(capabilityId: string, version: string, digest: string): InstalledCapabilityVersion | null;
  findVersion(capabilityId: string, version: string): InstalledCapabilityVersion | null;
  listVersions(capabilityId?: string): InstalledCapabilityVersion[];
  markUninstalled(capabilityId: string, version: string, digest: string, now?: number): boolean;
  getActive(capabilityId: string, scopeId: string): ActiveCapabilityVersion | null;
  listActive(scopeId?: string): ActiveCapabilityVersion[];
  activate(command: { capabilityId: string; version: string; digest: string; scopeId: string; action?: 'activate' | 'rollback' | 'enable'; now?: number }): ActiveCapabilityVersion;
  disable(capabilityId: string, scopeId: string, now?: number): ActiveCapabilityVersion | null;
  rollbackTarget(capabilityId: string, scopeId: string): InstalledCapabilityVersion | null;
  grant(command: Omit<CapabilityGrant, 'grantId' | 'grantedAt'> & { grantId?: string; grantedAt?: number }): CapabilityGrant;
  revoke(grantId: string, now?: number): boolean;
  createInvocation(command: Omit<CapabilityInvocationReceipt, 'stateVersion'> & { fenceToken?: string }): CapabilityInvocationReceipt;
  transitionInvocation(command: {
    invocationId: string;
    expectedStateVersion: number;
    state: CapabilityInvocationState;
    terminalAt?: number | null;
    runtimeMs?: number | null;
    exitCode?: number | null;
    exitSignal?: string | null;
    detail?: string | null;
    effectRefs?: string[];
    evidenceRefs?: string[];
  }): CapabilityInvocationReceipt;
  getInvocation(invocationId: string): CapabilityInvocationReceipt | null;
  listInvocations(capabilityId?: string, limit?: number): CapabilityInvocationReceipt[];
  listNonterminalInvocations(): CapabilityInvocationReceipt[];
  recordHealth(command: CapabilityHealthRecord): CapabilityHealthRecord;
  getHealth(identity: CapabilityIdentity): CapabilityHealthRecord | null;
}

type VersionRow = {
  capability_id: string; version: string; digest: string; manifest_json: string;
  install_path: string; install_receipt_json: string; installed_at: number; uninstalled_at: number | null;
};
type ActiveRow = {
  capability_id: string; scope_id: string; version: string; digest: string;
  enabled: number; state_version: number; activated_at: number;
};
type GrantRow = {
  grant_id: string; capability_id: string; version: string; digest: string;
  owner_id: string; workspace_id: string; permission: CapabilityPermissionKind;
  scope_json: string; granted_at: number;
};
type InvocationRow = {
  invocation_id: string; capability_id: string; version: string; digest: string;
  manifest_version?: number; protocol_version?: number; tool_name: string; job_id: string | null;
  attempt_id: string | null; generation: number | null; state: CapabilityInvocationState;
  host_instance_id: string; host_pid: number; host_start_time: number | null;
  permission_digest: string; effect_refs_json: string; evidence_refs_json: string;
  started_at: number; terminal_at: number | null; runtime_ms: number | null;
  exit_code: number | null; exit_signal: string | null; detail: string | null; state_version: number;
};

function parse<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function versionFromRow(row: VersionRow): InstalledCapabilityVersion {
  return {
    manifest: parse(row.manifest_json, {} as CapabilityManifest),
    installPath: row.install_path,
    installedAt: row.installed_at,
    uninstalledAt: row.uninstalled_at,
    installReceipt: parse(row.install_receipt_json, {}),
  };
}

function activeFromRow(row: ActiveRow): ActiveCapabilityVersion {
  return {
    capabilityId: row.capability_id, scopeId: row.scope_id, version: row.version,
    digest: row.digest, enabled: row.enabled === 1, stateVersion: row.state_version,
    activatedAt: row.activated_at,
  };
}

function invocationFromRow(row: InvocationRow, manifest: CapabilityManifest): CapabilityInvocationReceipt {
  return {
    invocationId: row.invocation_id,
    identity: capabilityIdentity(manifest),
    toolName: row.tool_name,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    generation: row.generation,
    hostInstanceId: row.host_instance_id,
    hostPid: row.host_pid,
    hostStartTime: row.host_start_time,
    state: row.state,
    permissionDigest: row.permission_digest,
    effectRefs: parse(row.effect_refs_json, []),
    evidenceRefs: parse(row.evidence_refs_json, []),
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    runtimeMs: row.runtime_ms,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    detail: row.detail,
    stateVersion: row.state_version,
  };
}

function terminalState(state: CapabilityInvocationState): boolean {
  return ['completed', 'failed', 'cancelled', 'timed_out', 'protocol_error', 'unknown'].includes(state);
}

export function createCapabilityStore(db: Db): CapabilityStore {
  const getVersion = (capabilityId: string, version: string, digest: string): InstalledCapabilityVersion | null => {
    const row = db.prepare('SELECT * FROM capability_versions WHERE capability_id=? AND version=? AND digest=?')
      .get(capabilityId, version, digest) as VersionRow | undefined;
    return row ? versionFromRow(row) : null;
  };
  const getInvocation = (invocationId: string): CapabilityInvocationReceipt | null => {
    const row = db.prepare('SELECT * FROM capability_invocations WHERE invocation_id=?').get(invocationId) as InvocationRow | undefined;
    if (!row) return null;
    const version = getVersion(row.capability_id, row.version, row.digest);
    return version ? invocationFromRow(row, version.manifest) : null;
  };
  return {
    registerVersion(record) {
      const manifest = record.manifest;
      const existing = getVersion(manifest.id, manifest.version, manifest.digest);
      if (existing?.uninstalledAt === null) return { inserted: false, record: existing };
      if (existing) {
        db.transaction(() => {
          db.prepare(
            `UPDATE capability_versions
                SET manifest_json=?,install_path=?,compatibility_json=?,install_receipt_json=?,installed_at=?,uninstalled_at=NULL
              WHERE capability_id=? AND version=? AND digest=? AND uninstalled_at IS NOT NULL`,
          ).run(
            JSON.stringify(manifest), record.installPath, JSON.stringify(manifest.compatibility),
            JSON.stringify(record.installReceipt), record.installedAt,
            manifest.id, manifest.version, manifest.digest,
          );
          db.prepare(
            `UPDATE capability_health
                SET state='unknown',consecutive_failures=0,last_reason=NULL,last_checked_at=?,last_invocation_id=NULL
              WHERE capability_id=? AND version=? AND digest=?`,
          ).run(record.installedAt, manifest.id, manifest.version, manifest.digest);
        }).immediate();
        return { inserted: true, record: getVersion(manifest.id, manifest.version, manifest.digest)! };
      }
      const sameVersion = db.prepare(
        'SELECT * FROM capability_versions WHERE capability_id=? AND version=? AND uninstalled_at IS NULL',
      ).get(manifest.id, manifest.version) as VersionRow | undefined;
      if (sameVersion && sameVersion.digest !== manifest.digest) {
        throw new Error(`Capability ${manifest.id}@${manifest.version} is immutable and already installed with another digest`);
      }
      db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO capability_packages(capability_id,display_name,created_at) VALUES(?,?,?)')
          .run(manifest.id, manifest.displayName, record.installedAt);
        db.prepare(
          `INSERT INTO capability_versions
             (capability_id,version,digest,manifest_json,install_path,compatibility_json,install_receipt_json,installed_at,uninstalled_at)
           VALUES(?,?,?,?,?,?,?,?,NULL)`,
        ).run(
          manifest.id, manifest.version, manifest.digest, JSON.stringify(manifest), record.installPath,
          JSON.stringify(manifest.compatibility), JSON.stringify(record.installReceipt), record.installedAt,
        );
        db.prepare(
          `INSERT INTO capability_health
             (capability_id,version,digest,state,consecutive_failures,last_reason,last_checked_at,last_invocation_id)
           VALUES(?,?,?,'unknown',0,NULL,?,NULL)`,
        ).run(manifest.id, manifest.version, manifest.digest, record.installedAt);
      }).immediate();
      return { inserted: true, record };
    },
    getVersion,
    findVersion(capabilityId, version) {
      const row = db.prepare(
        'SELECT * FROM capability_versions WHERE capability_id=? AND version=? AND uninstalled_at IS NULL ORDER BY installed_at DESC LIMIT 1',
      ).get(capabilityId, version) as VersionRow | undefined;
      return row ? versionFromRow(row) : null;
    },
    listVersions(capabilityId) {
      const rows = (capabilityId
        ? db.prepare('SELECT * FROM capability_versions WHERE capability_id=? AND uninstalled_at IS NULL ORDER BY installed_at,version,digest').all(capabilityId)
        : db.prepare('SELECT * FROM capability_versions WHERE uninstalled_at IS NULL ORDER BY capability_id,installed_at,version,digest').all()) as VersionRow[];
      return rows.map(versionFromRow);
    },
    markUninstalled(capabilityId, version, digest, now = Date.now()) {
      const active = db.prepare(
        'SELECT 1 FROM capability_active_versions WHERE capability_id=? AND version=? AND digest=? AND enabled=1',
      ).get(capabilityId, version, digest);
      if (active) throw new Error('Active capability version must be disabled before uninstall');
      return db.prepare(
        'UPDATE capability_versions SET uninstalled_at=? WHERE capability_id=? AND version=? AND digest=? AND uninstalled_at IS NULL',
      ).run(now, capabilityId, version, digest).changes === 1;
    },
    getActive(capabilityId, scopeId) {
      const row = db.prepare('SELECT * FROM capability_active_versions WHERE capability_id=? AND scope_id=?')
        .get(capabilityId, scopeId) as ActiveRow | undefined;
      return row ? activeFromRow(row) : null;
    },
    listActive(scopeId) {
      const rows = (scopeId
        ? db.prepare('SELECT * FROM capability_active_versions WHERE scope_id=? ORDER BY capability_id').all(scopeId)
        : db.prepare('SELECT * FROM capability_active_versions ORDER BY capability_id,scope_id').all()) as ActiveRow[];
      return rows.map(activeFromRow);
    },
    activate(command) {
      const now = command.now ?? Date.now();
      const record = getVersion(command.capabilityId, command.version, command.digest);
      if (!record || record.uninstalledAt !== null) throw new Error('Capability version is not installed');
      db.transaction(() => {
        db.prepare(
          `INSERT INTO capability_active_versions
             (capability_id,scope_id,version,digest,enabled,state_version,activated_at)
           VALUES(?,?,?,?,1,1,?)
           ON CONFLICT(capability_id,scope_id) DO UPDATE SET
             version=excluded.version,digest=excluded.digest,enabled=1,
             state_version=capability_active_versions.state_version+1,activated_at=excluded.activated_at`,
        ).run(command.capabilityId, command.scopeId, command.version, command.digest, now);
        db.prepare(
          'INSERT INTO capability_activation_history(capability_id,scope_id,version,digest,action,activated_at) VALUES(?,?,?,?,?,?)',
        ).run(command.capabilityId, command.scopeId, command.version, command.digest, command.action ?? 'activate', now);
      }).immediate();
      return this.getActive(command.capabilityId, command.scopeId)!;
    },
    disable(capabilityId, scopeId, now = Date.now()) {
      const existing = this.getActive(capabilityId, scopeId);
      if (!existing) return null;
      db.transaction(() => {
        db.prepare(
          'UPDATE capability_active_versions SET enabled=0,state_version=state_version+1,activated_at=? WHERE capability_id=? AND scope_id=?',
        ).run(now, capabilityId, scopeId);
        db.prepare(
          'INSERT INTO capability_activation_history(capability_id,scope_id,version,digest,action,activated_at) VALUES(?,?,?,?,?,?)',
        ).run(capabilityId, scopeId, existing.version, existing.digest, 'disable', now);
      }).immediate();
      return this.getActive(capabilityId, scopeId);
    },
    rollbackTarget(capabilityId, scopeId) {
      const active = this.getActive(capabilityId, scopeId);
      if (!active) return null;
      const row = db.prepare(
        `SELECT h.version,h.digest
           FROM capability_activation_history h
           JOIN capability_versions v ON v.capability_id=h.capability_id AND v.version=h.version AND v.digest=h.digest
          WHERE h.capability_id=? AND h.scope_id=? AND h.action IN ('activate','rollback')
            AND NOT (h.version=? AND h.digest=?) AND v.uninstalled_at IS NULL
          ORDER BY h.activation_id DESC LIMIT 1`,
      ).get(capabilityId, scopeId, active.version, active.digest) as { version: string; digest: string } | undefined;
      return row ? getVersion(capabilityId, row.version, row.digest) : null;
    },
    list({ identity, ownerId, workspaceId }) {
      const rows = db.prepare(
        `SELECT * FROM capability_grants
          WHERE capability_id=? AND version=? AND digest=? AND owner_id=? AND workspace_id=? AND revoked_at IS NULL
          ORDER BY granted_at,grant_id`,
      ).all(identity.capabilityId, identity.version, identity.digest, ownerId, workspaceId) as GrantRow[];
      return rows.map((row) => ({
        grantId: row.grant_id,
        identity: { ...identity },
        ownerId: row.owner_id,
        workspaceId: row.workspace_id,
        permission: row.permission,
        scope: parse<CapabilityPermissionScope>(row.scope_json, {}),
        grantedAt: row.granted_at,
      }));
    },
    grant(command) {
      const grantId = command.grantId ?? `grant_${randomUUID()}`;
      const grantedAt = command.grantedAt ?? Date.now();
      const scopeJson = JSON.stringify(command.scope);
      db.prepare(
        `INSERT INTO capability_grants
           (grant_id,capability_id,version,digest,owner_id,workspace_id,permission,scope_json,granted_at,revoked_at)
         VALUES(?,?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(capability_id,version,digest,owner_id,workspace_id,permission,scope_json)
         DO UPDATE SET revoked_at=NULL`,
      ).run(
        grantId, command.identity.capabilityId, command.identity.version, command.identity.digest,
        command.ownerId, command.workspaceId, command.permission, scopeJson, grantedAt,
      );
      const row = this.list({ identity: command.identity, ownerId: command.ownerId, workspaceId: command.workspaceId })
        .find((candidate) => candidate.permission === command.permission && JSON.stringify(candidate.scope) === scopeJson);
      if (!row) throw new Error('Capability grant could not be persisted');
      return row;
    },
    revoke(grantId, now = Date.now()) {
      return db.prepare('UPDATE capability_grants SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL').run(now, grantId).changes === 1;
    },
    createInvocation(command) {
      const fenceTokenHash = command.fenceToken
        ? `sha256:${createHash('sha256').update(command.fenceToken).digest('hex')}` : null;
      db.prepare(
        `INSERT INTO capability_invocations
           (invocation_id,capability_id,version,digest,tool_name,job_id,attempt_id,generation,fence_token_hash,
            host_instance_id,host_pid,host_start_time,state,
            permission_digest,effect_refs_json,evidence_refs_json,started_at,terminal_at,runtime_ms,exit_code,exit_signal,detail,state_version)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      ).run(
        command.invocationId, command.identity.capabilityId, command.identity.version, command.identity.digest,
        command.toolName, command.jobId, command.attemptId, command.generation, fenceTokenHash,
        command.hostInstanceId, command.hostPid, command.hostStartTime, command.state,
        command.permissionDigest, JSON.stringify(command.effectRefs), JSON.stringify(command.evidenceRefs),
        command.startedAt, command.terminalAt, command.runtimeMs, command.exitCode, command.exitSignal, command.detail,
      );
      return getInvocation(command.invocationId)!;
    },
    transitionInvocation(command) {
      const current = getInvocation(command.invocationId);
      if (!current) throw new Error('Capability invocation not found');
      if (current.stateVersion !== command.expectedStateVersion) throw new Error('Capability invocation state version conflict');
      if (terminalState(current.state)) throw new Error('Terminal capability invocation is immutable');
      const terminalAt = terminalState(command.state) ? (command.terminalAt ?? Date.now()) : (command.terminalAt ?? null);
      const result = db.prepare(
        `UPDATE capability_invocations SET state=?,terminal_at=?,runtime_ms=?,exit_code=?,exit_signal=?,detail=?,
           effect_refs_json=?,evidence_refs_json=?,state_version=state_version+1
          WHERE invocation_id=? AND state_version=?`,
      ).run(
        command.state, terminalAt, command.runtimeMs ?? current.runtimeMs,
        command.exitCode ?? current.exitCode, command.exitSignal ?? current.exitSignal,
        command.detail ?? current.detail, JSON.stringify(command.effectRefs ?? current.effectRefs),
        JSON.stringify(command.evidenceRefs ?? current.evidenceRefs), command.invocationId, command.expectedStateVersion,
      );
      if (result.changes !== 1) throw new Error('Capability invocation state version conflict');
      return getInvocation(command.invocationId)!;
    },
    getInvocation,
    listInvocations(capabilityId, limit = 100) {
      const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
      const rows = (capabilityId
        ? db.prepare('SELECT * FROM capability_invocations WHERE capability_id=? ORDER BY started_at DESC LIMIT ?').all(capabilityId, bounded)
        : db.prepare('SELECT * FROM capability_invocations ORDER BY started_at DESC LIMIT ?').all(bounded)) as InvocationRow[];
      return rows.flatMap((row) => {
        const version = getVersion(row.capability_id, row.version, row.digest);
        return version ? [invocationFromRow(row, version.manifest)] : [];
      });
    },
    listNonterminalInvocations() {
      const rows = db.prepare(
        `SELECT * FROM capability_invocations
          WHERE state IN ('admitted','starting','running','waiting_approval')
          ORDER BY started_at,invocation_id`,
      ).all() as InvocationRow[];
      return rows.flatMap((row) => {
        const version = getVersion(row.capability_id, row.version, row.digest);
        return version ? [invocationFromRow(row, version.manifest)] : [];
      });
    },
    recordHealth(command) {
      db.prepare(
        `INSERT INTO capability_health
           (capability_id,version,digest,state,consecutive_failures,last_reason,last_checked_at,last_invocation_id)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(capability_id,version,digest) DO UPDATE SET
           state=excluded.state,consecutive_failures=excluded.consecutive_failures,last_reason=excluded.last_reason,
           last_checked_at=excluded.last_checked_at,last_invocation_id=excluded.last_invocation_id`,
      ).run(
        command.identity.capabilityId, command.identity.version, command.identity.digest, command.state,
        command.consecutiveFailures, command.lastReason, command.lastCheckedAt, command.lastInvocationId,
      );
      return command;
    },
    getHealth(identity) {
      const row = db.prepare(
        'SELECT * FROM capability_health WHERE capability_id=? AND version=? AND digest=?',
      ).get(identity.capabilityId, identity.version, identity.digest) as {
        state: CapabilityHealthRecord['state']; consecutive_failures: number; last_reason: string | null;
        last_checked_at: number; last_invocation_id: string | null;
      } | undefined;
      return row ? {
        identity, state: row.state, consecutiveFailures: row.consecutive_failures,
        lastReason: row.last_reason, lastCheckedAt: row.last_checked_at, lastInvocationId: row.last_invocation_id,
      } : null;
    },
  };
}
