/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Db } from '../daemon/db/connection';

export interface SecretBackendHealth {
  available: boolean;
  protectedByOs: boolean;
  detail: string;
}

export interface SecretBackend {
  readonly id: string;
  protect(value: string): Promise<string>;
  unprotect(value: string): Promise<string>;
  health(): SecretBackendHealth;
}

export interface SecretNamespace {
  workspaceId: string;
  ownerId: string;
  providerId: string;
  accountId?: string;
}

interface SecretRow {
  secret_handle: string;
  workspace_id: string;
  owner_id: string;
  provider_id: string;
  account_id: string | null;
  label: string;
  backend: string;
  storage_ref: string;
  status: 'active' | 'revoked';
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SECRET_KEY_SALT = Buffer.from('aiden-integration-secrets-v1', 'utf8');

function opaqueHandle(): string {
  return `secret_${randomBytes(18).toString('base64url')}`;
}

function normalizeSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_ID.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

function fallbackKey(): Buffer {
  const override = process.env.AIDEN_SECRET_KEY;
  const identity = override && override.length > 0
    ? override
    : `${os.hostname()}::${os.userInfo().username}::${process.platform}`;
  return scryptSync(identity, SECRET_KEY_SALT, 32);
}

/** Strongest dependency-free fallback when a platform secret API is unavailable. */
export class MachineBoundSecretBackend implements SecretBackend {
  readonly id = 'machine-bound-aes-gcm';

  async protect(value: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', fallbackKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({
      version: 1,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    });
  }

  async unprotect(value: string): Promise<string> {
    const record = JSON.parse(value) as { version: number; iv: string; ciphertext: string; authTag: string };
    if (record.version !== 1) throw new Error('Unsupported secret record');
    const decipher = createDecipheriv('aes-256-gcm', fallbackKey(), Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  health(): SecretBackendHealth {
    return {
      available: true,
      protectedByOs: false,
      detail: 'Machine-bound authenticated encryption; same-user processes remain trusted',
    };
  }
}

async function invokeWindowsProtection(script: string, input: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best effort */ }
      reject(new Error('Platform secret operation timed out'));
    }, 10_000);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024) chunks.push(chunk);
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Platform secret protection is unavailable'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || size > 2 * 1024 * 1024) {
        reject(new Error('Platform secret protection failed'));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

/** Windows CurrentUser DPAPI boundary. Plaintext is passed only over private child pipes. */
export class WindowsDpapiSecretBackend implements SecretBackend {
  readonly id = 'windows-dpapi-current-user';

  async protect(value: string): Promise<string> {
    return invokeWindowsProtection(
      "$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);" +
      "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
      '[Console]::Out.Write([Convert]::ToBase64String($p))',
      value,
    );
  }

  async unprotect(value: string): Promise<string> {
    return invokeWindowsProtection(
      "$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);" +
      "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
      '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))',
      value,
    );
  }

  health(): SecretBackendHealth {
    return {
      available: process.platform === 'win32',
      protectedByOs: process.platform === 'win32',
      detail: process.platform === 'win32' ? 'Windows CurrentUser protection' : 'Windows protection is unavailable',
    };
  }
}

export function createPlatformSecretBackend(): SecretBackend {
  return process.platform === 'win32' ? new WindowsDpapiSecretBackend() : new MachineBoundSecretBackend();
}

export class SecretAuthority {
  private readonly db: Db;
  private readonly rootDir: string;
  private readonly backend: SecretBackend;

  constructor(options: { db: Db; rootDir: string; backend?: SecretBackend }) {
    this.db = options.db;
    this.rootDir = path.resolve(options.rootDir);
    this.backend = options.backend ?? createPlatformSecretBackend();
  }

  backendHealth(): SecretBackendHealth & { backend: string } {
    return { backend: this.backend.id, ...this.backend.health() };
  }

  async create(input: { namespace: SecretNamespace; label: string; value: string; now?: number }): Promise<string> {
    const workspaceId = normalizeSegment(input.namespace.workspaceId, 'workspace id');
    const ownerId = normalizeSegment(input.namespace.ownerId, 'owner id');
    const providerId = normalizeSegment(input.namespace.providerId, 'provider id');
    const accountId = input.namespace.accountId
      ? normalizeSegment(input.namespace.accountId, 'account id')
      : null;
    if (!input.value) throw new Error('Secret value is required');
    const handle = opaqueHandle();
    const storageRef = path.join('integrations', `${handle}.secret`);
    const absolute = path.join(this.rootDir, storageRef);
    const protectedValue = await this.backend.protect(input.value);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, protectedValue, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, absolute);
    if (process.platform !== 'win32') await fs.chmod(absolute, 0o600).catch(() => undefined);
    const now = input.now ?? Date.now();
    try {
      this.db.prepare(
        `INSERT INTO integration_secret_handles
           (secret_handle,workspace_id,owner_id,provider_id,account_id,label,backend,storage_ref,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'active',?,?)`,
      ).run(handle, workspaceId, ownerId, providerId, accountId, input.label.trim() || 'credential', this.backend.id, storageRef, now, now);
    } catch (error) {
      await fs.rm(absolute, { force: true }).catch(() => undefined);
      throw error;
    }
    return handle;
  }

  exists(handle: string): boolean {
    return this.db.prepare('SELECT 1 FROM integration_secret_handles WHERE secret_handle=?').get(handle) !== undefined;
  }

  health(handle: string): { exists: boolean; status?: string; backend?: string; available: boolean; protectedByOs: boolean } {
    const row = this.row(handle);
    const backend = this.backendHealth();
    return row
      ? { exists: true, status: row.status, backend: row.backend, available: backend.available, protectedByOs: backend.protectedByOs }
      : { exists: false, available: backend.available, protectedByOs: backend.protectedByOs };
  }

  async resolve(handle: string, scope: { workspaceId: string; ownerId: string }): Promise<string> {
    const row = this.requireScoped(handle, scope);
    if (row.status !== 'active') throw new Error('Secret handle is revoked');
    if (row.backend !== this.backend.id) throw new Error('Secret backend is unavailable for this handle');
    const absolute = this.absoluteStoragePath(row.storage_ref);
    let protectedValue: string;
    try {
      protectedValue = await fs.readFile(absolute, 'utf8');
    } catch {
      throw new Error('Secret material is unavailable');
    }
    try {
      return await this.backend.unprotect(protectedValue);
    } catch {
      throw new Error('Secret material could not be resolved');
    }
  }

  async replace(handle: string, value: string, scope: { workspaceId: string; ownerId: string }, now = Date.now()): Promise<void> {
    if (!value) throw new Error('Secret value is required');
    const row = this.requireScoped(handle, scope);
    if (row.status !== 'active') throw new Error('Secret handle is revoked');
    const absolute = this.absoluteStoragePath(row.storage_ref);
    const protectedValue = await this.backend.protect(value);
    const temporary = `${absolute}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, protectedValue, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, absolute);
    this.db.prepare('UPDATE integration_secret_handles SET updated_at=? WHERE secret_handle=?').run(now, handle);
  }

  async revoke(handle: string, scope: { workspaceId: string; ownerId: string }, now = Date.now()): Promise<void> {
    this.requireScoped(handle, scope);
    this.db.prepare(
      `UPDATE integration_secret_handles SET status='revoked',revoked_at=?,updated_at=? WHERE secret_handle=?`,
    ).run(now, now, handle);
  }

  async delete(handle: string, scope: { workspaceId: string; ownerId: string }): Promise<void> {
    const row = this.requireScoped(handle, scope);
    const absolute = this.absoluteStoragePath(row.storage_ref);
    await fs.rm(absolute, { force: true });
    this.db.prepare('DELETE FROM integration_secret_handles WHERE secret_handle=?').run(handle);
  }

  private row(handle: string): SecretRow | undefined {
    return this.db.prepare('SELECT * FROM integration_secret_handles WHERE secret_handle=?').get(handle) as SecretRow | undefined;
  }

  private requireScoped(handle: string, scope: { workspaceId: string; ownerId: string }): SecretRow {
    const row = this.row(handle);
    if (!row) throw new Error('Secret handle does not exist');
    if (row.workspace_id !== scope.workspaceId || row.owner_id !== scope.ownerId) {
      throw new Error('Secret handle is outside the requested scope');
    }
    return row;
  }

  private absoluteStoragePath(storageRef: string): string {
    const absolute = path.resolve(this.rootDir, storageRef);
    if (absolute !== this.rootDir && !absolute.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error('Secret storage reference is invalid');
    }
    return absolute;
  }
}
