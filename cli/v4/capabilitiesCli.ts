/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { CapabilityInstaller } from '../../core/v4/capabilities/installer';
import { CapabilityManagementAuthority, type CapabilityDoctorProjection } from '../../core/v4/capabilities/management';
import { DockerCapabilityProcessHost } from '../../core/v4/capabilities/processHost';
import { createCapabilityStore } from '../../core/v4/capabilities/store';
import { closeDaemonDb, openDaemonDb, type Db } from '../../core/v4/daemon/db/connection';
import { daemonDbPath } from '../../core/v4/daemon/daemonConfig';
import { runMigrations } from '../../core/v4/daemon/db/migrations';

export type CapabilityCliAction =
  | 'list' | 'inspect' | 'install' | 'activate' | 'rollback' | 'disable' | 'test' | 'uninstall';

export interface CapabilityCliInput {
  action: CapabilityCliAction;
  target?: string;
  json?: boolean;
  acceptPermissions?: boolean;
}

function managementFor(db: Db, options: {
  aidenRoot: string;
  aidenVersion: string;
  workspaceRoot?: string;
  ownerId?: string;
}): { installer: CapabilityInstaller; management: CapabilityManagementAuthority } {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const store = createCapabilityStore(db);
  const installer = new CapabilityInstaller({
    aidenRoot: options.aidenRoot,
    store,
    aidenVersion: options.aidenVersion,
  });
  return {
    installer,
    management: new CapabilityManagementAuthority({
      store,
      installer,
      processHost: new DockerCapabilityProcessHost(),
      scopeId: workspaceRoot,
      ownerId: options.ownerId ?? 'local-user',
      workspaceId: workspaceRoot,
    }),
  };
}

export async function readCapabilityDoctor(options: {
  aidenRoot: string;
  aidenVersion: string;
  workspaceRoot?: string;
  ownerId?: string;
}): Promise<CapabilityDoctorProjection> {
  const dbPath = daemonDbPath(options.aidenRoot);
  const existing = existsSync(dbPath);
  const db: Db = existing ? openDaemonDb(dbPath) : new Database(':memory:');
  if (!existing) runMigrations(db);
  try {
    return await managementFor(db, options).management.doctor();
  } finally {
    if (existing) closeDaemonDb(dbPath);
    else db.close();
  }
}

function splitVersionTarget(target: string): { capabilityId: string; version: string } {
  const separator = target.lastIndexOf('@');
  if (separator <= 0 || separator === target.length - 1) {
    throw new Error('Expected an exact capability identity in the form <id>@<version>');
  }
  return { capabilityId: target.slice(0, separator), version: target.slice(separator + 1) };
}

function safeProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeProjection);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/installPath|fence|secret|token|environment/iu.test(key))
      .map(([key, item]) => [key, safeProjection(item)]));
  }
  return value;
}

function renderText(action: CapabilityCliAction, result: unknown): string {
  if (action === 'list' && Array.isArray(result)) {
    if (result.length === 0) return 'No capabilities installed.\n';
    return `${result.map((item) => {
      const value = item as { capabilityId: string; active: { version: string; enabled: boolean } | null; health: { state: string } | null };
      return `${value.capabilityId}  ${value.active ? `v${value.active.version} ${value.active.enabled ? 'active' : 'disabled'}` : 'inactive'}  ${value.health?.state ?? 'unknown'}`;
    }).join('\n')}\n`;
  }
  return `${JSON.stringify(safeProjection(result), null, 2)}\n`;
}

export async function runCapabilitiesCli(input: CapabilityCliInput, options: {
  aidenRoot: string;
  aidenVersion: string;
  workspaceRoot?: string;
  ownerId?: string;
  db?: Db;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
}): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const writeError = options.writeError ?? ((text: string) => process.stderr.write(text));
  const dbPath = daemonDbPath(options.aidenRoot);
  const ownsDb = !options.db;
  const db = options.db ?? openDaemonDb(dbPath);
  try {
    const { installer, management } = managementFor(db, options);
    await installer.cleanupStaging();
    let result: unknown;
    switch (input.action) {
      case 'list': result = management.list(); break;
      case 'inspect':
        if (!input.target) throw new Error('Capability id is required');
        result = management.inspect(input.target);
        break;
      case 'install':
        if (!input.target) throw new Error('A local capability folder is required');
        result = await management.install(input.target);
        break;
      case 'activate': {
        if (!input.target) throw new Error('Capability identity is required');
        const exact = splitVersionTarget(input.target);
        result = management.activate({ ...exact, acceptPermissions: input.acceptPermissions === true });
        break;
      }
      case 'rollback':
        if (!input.target) throw new Error('Capability id is required');
        result = management.rollback(input.target);
        break;
      case 'disable':
        if (!input.target) throw new Error('Capability id is required');
        result = management.disable(input.target);
        break;
      case 'test':
        if (!input.target) throw new Error('Capability id is required');
        result = await management.test(input.target);
        break;
      case 'uninstall': {
        if (!input.target) throw new Error('Capability identity is required');
        result = { removed: await management.uninstall(splitVersionTarget(input.target)) };
        break;
      }
    }
    write(input.json ? `${JSON.stringify(safeProjection(result), null, 2)}\n` : renderText(input.action, result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (input.json) write(`${JSON.stringify({ error: message })}\n`);
    else writeError(`Capability command failed: ${message}\n`);
    return 1;
  } finally {
    if (ownsDb) closeDaemonDb(dbPath);
  }
}
