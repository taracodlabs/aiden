/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  validateCapabilityManifest,
  type CapabilityManifest,
} from '../../../packages/capability-sdk/src';
import { capabilityPermissionDiff } from './permissionAuthority';
import { validateCapabilityCompatibility } from './compatibility';
import type {
  ActiveCapabilityVersion,
  CapabilityStore,
  InstalledCapabilityVersion,
} from './store';

const MAX_PACKAGE_FILES = 256;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_COMPONENTS = new Set([
  '.git', 'node_modules', '.env', 'auth.json', 'credentials.json', 'secrets.json',
  '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519',
]);

interface PackageFile {
  relative: string;
  absolute: string;
  size: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

async function packageFiles(source: string): Promise<PackageFile[]> {
  const root = path.resolve(source);
  const result: PackageFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Capability package cannot contain symlink: ${relative}`);
      if (FORBIDDEN_COMPONENTS.has(entry.name.toLowerCase())) throw new Error(`Capability package contains forbidden file: ${relative}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        if (stat.size > MAX_FILE_BYTES) throw new Error(`Capability package file exceeds limit: ${relative}`);
        result.push({ relative, absolute, size: stat.size });
        if (result.length > MAX_PACKAGE_FILES) throw new Error('Capability package file count exceeds limit');
      } else throw new Error(`Capability package contains unsupported entry: ${relative}`);
    }
  };
  await visit(root);
  const total = result.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_PACKAGE_BYTES) throw new Error('Capability package exceeds total byte limit');
  return result;
}

export async function computeCapabilityPackageDigest(source: string): Promise<string> {
  const files = await packageFiles(source);
  const hash = createHash('sha256');
  for (const file of files) {
    let bytes = await fs.readFile(file.absolute);
    if (file.relative === 'capability.json') {
      let manifest: Record<string, unknown>;
      try { manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
      catch { throw new Error('Capability manifest is not valid JSON'); }
      // The digest binds every manifest field while excluding only its own
      // value, avoiding a circular self-hash.
      manifest.digest = '';
      bytes = Buffer.from(JSON.stringify(canonical(manifest)), 'utf8');
    }
    hash.update(file.relative, 'utf8');
    hash.update('\0');
    hash.update(String(bytes.length), 'utf8');
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function loadManifest(source: string): Promise<CapabilityManifest> {
  const manifestPath = path.join(source, 'capability.json');
  let raw: Buffer;
  try { raw = await fs.readFile(manifestPath); }
  catch { throw new Error('Capability package is missing capability.json'); }
  if (raw.byteLength > 256 * 1024) throw new Error('Capability manifest exceeds byte limit');
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('Capability manifest is not valid JSON'); }
  const result = validateCapabilityManifest(value);
  if (!result.ok || !result.manifest) throw new Error(`Capability manifest rejected: ${result.errors.join('; ')}`);
  return result.manifest;
}

async function copyPackage(files: PackageFile[], source: string, target: string): Promise<void> {
  for (const file of files) {
    const destination = path.join(target, ...file.relative.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(file.absolute, destination);
    if (process.platform !== 'win32') await fs.chmod(destination, 0o444);
  }
  // Directories remain owner-writable so the staged tree can be atomically
  // moved and later removed through the managed lifecycle. Package file bytes
  // remain read-only and every execution revalidates the immutable digest.
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(target);
  if (sourceRoot === targetRoot) throw new Error('Capability source and target must differ');
}

export interface CapabilityInstallResult {
  idempotent: boolean;
  record: InstalledCapabilityVersion;
}

export class CapabilityInstaller {
  private readonly storageRoot: string;
  private readonly stagingRoot: string;

  constructor(private readonly options: {
    aidenRoot: string;
    store: CapabilityStore;
    aidenVersion: string;
    nodeVersion?: string;
    platform?: NodeJS.Platform;
    architecture?: string;
  }) {
    this.storageRoot = path.join(options.aidenRoot, 'capabilities');
    this.stagingRoot = path.join(this.storageRoot, '.staging');
  }

  async install(sourcePath: string): Promise<CapabilityInstallResult> {
    const source = path.resolve(sourcePath);
    const storage = path.resolve(this.storageRoot);
    if (source === storage || source.startsWith(`${storage}${path.sep}`)) {
      throw new Error('Capability install source cannot be inside managed capability storage');
    }
    const sourceStat = await fs.stat(source).catch(() => null);
    if (!sourceStat?.isDirectory()) throw new Error('Capability install source must be a local directory');
    const manifest = await loadManifest(source);
    const digest = await computeCapabilityPackageDigest(source);
    if (manifest.digest !== digest) throw new Error(`Capability digest mismatch: manifest ${manifest.digest}, actual ${digest}`);
    const compatibility = validateCapabilityCompatibility(manifest, {
      aidenVersion: this.options.aidenVersion,
      nodeVersion: this.options.nodeVersion,
      platform: this.options.platform,
      architecture: this.options.architecture,
    });
    if (!compatibility.compatible) throw new Error(`Capability is incompatible: ${compatibility.errors.join('; ')}`);
    const entrypoint = path.join(source, ...manifest.entrypoint.split('/'));
    const entryStat = await fs.lstat(entrypoint).catch(() => null);
    if (!entryStat?.isFile() || entryStat.isSymbolicLink()) throw new Error('Capability entrypoint is missing or not a regular file');
    if (!/\.(?:c?js|mjs)$/u.test(manifest.entrypoint)) throw new Error('Capability Node entrypoint must be .js, .cjs, or .mjs');

    const sameVersion = this.options.store.findVersion(manifest.id, manifest.version);
    if (sameVersion) {
      if (sameVersion.manifest.digest !== manifest.digest) {
        throw new Error(`Capability ${manifest.id}@${manifest.version} is immutable and already installed with another digest`);
      }
      const storedDigest = await computeCapabilityPackageDigest(sameVersion.installPath).catch(() => 'missing');
      if (storedDigest !== manifest.digest) throw new Error('Installed capability bytes no longer match immutable digest');
      return { idempotent: true, record: sameVersion };
    }

    await fs.mkdir(this.stagingRoot, { recursive: true });
    const stage = path.join(this.stagingRoot, randomUUID());
    await fs.mkdir(stage, { recursive: false });
    let moved = false;
    let finalPath = '';
    try {
      const files = await packageFiles(source);
      await copyPackage(files, source, stage);
      if (await computeCapabilityPackageDigest(stage) !== manifest.digest) throw new Error('Capability staging digest changed during copy');
      finalPath = path.join(
        this.storageRoot,
        'versions',
        encodeURIComponent(manifest.id),
        encodeURIComponent(manifest.version),
        manifest.digest.slice('sha256:'.length),
      );
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      try {
        await fs.rename(stage, finalPath);
        moved = true;
      } catch (error) {
        const existing = await fs.stat(finalPath).catch(() => null);
        if (!existing?.isDirectory() || await computeCapabilityPackageDigest(finalPath) !== manifest.digest) throw error;
        await fs.rm(stage, { recursive: true, force: true });
      }
      const installedAt = Date.now();
      const record: InstalledCapabilityVersion = {
        manifest,
        installPath: finalPath,
        installedAt,
        uninstalledAt: null,
        installReceipt: {
          schemaVersion: 1,
          fileCount: files.length,
          totalBytes: files.reduce((sum, file) => sum + file.size, 0),
          verifiedAt: installedAt,
          compatibility,
        },
      };
      const registered = this.options.store.registerVersion(record);
      return { idempotent: !registered.inserted, record: registered.record };
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (moved && finalPath) await fs.rm(finalPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  activate(command: {
    capabilityId: string;
    version: string;
    digest: string;
    scopeId: string;
    permissionReviewAccepted: boolean;
  }): ActiveCapabilityVersion {
    const target = this.options.store.getVersion(command.capabilityId, command.version, command.digest);
    if (!target || target.uninstalledAt !== null) throw new Error('Capability version is not installed');
    const active = this.options.store.getActive(command.capabilityId, command.scopeId);
    const previous = active
      ? this.options.store.getVersion(command.capabilityId, active.version, active.digest)
      : null;
    const diff = capabilityPermissionDiff(previous?.manifest ?? { permissions: [] }, target.manifest);
    if (diff.added.length > 0 && !command.permissionReviewAccepted) {
      throw new Error('Capability permission review is required before activation');
    }
    return this.options.store.activate({
      capabilityId: command.capabilityId,
      version: command.version,
      digest: command.digest,
      scopeId: command.scopeId,
    });
  }

  permissionDiff(capabilityId: string, version: string, digest: string, scopeId: string) {
    const target = this.options.store.getVersion(capabilityId, version, digest);
    if (!target) throw new Error('Capability version is not installed');
    const active = this.options.store.getActive(capabilityId, scopeId);
    const previous = active ? this.options.store.getVersion(capabilityId, active.version, active.digest) : null;
    return capabilityPermissionDiff(previous?.manifest ?? { permissions: [] }, target.manifest);
  }

  rollback(capabilityId: string, scopeId: string): ActiveCapabilityVersion {
    const target = this.options.store.rollbackTarget(capabilityId, scopeId);
    if (!target) throw new Error('No prior immutable capability version is available for rollback');
    return this.options.store.activate({
      capabilityId,
      version: target.manifest.version,
      digest: target.manifest.digest,
      scopeId,
      action: 'rollback',
    });
  }

  listVersions(capabilityId?: string): InstalledCapabilityVersion[] {
    return this.options.store.listVersions(capabilityId);
  }

  async inspectStaging(): Promise<{ pending: number }> {
    const entries = await fs.readdir(this.stagingRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return { pending: entries.length };
  }

  async cleanupStaging(): Promise<number> {
    await fs.mkdir(this.stagingRoot, { recursive: true });
    const entries = await fs.readdir(this.stagingRoot, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      const target = path.join(this.stagingRoot, entry.name);
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}
