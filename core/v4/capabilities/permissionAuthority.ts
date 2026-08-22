/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

import type {
  CapabilityIdentity,
  CapabilityManifest,
  CapabilityPermissionDeclaration,
  CapabilityPermissionKind,
  CapabilityPermissionScope,
} from '../../../packages/capability-sdk/src';

export interface CapabilityGrant {
  grantId: string;
  identity: CapabilityIdentity;
  ownerId: string;
  workspaceId: string;
  permission: CapabilityPermissionKind;
  scope: CapabilityPermissionScope;
  grantedAt: number;
}

export interface CapabilityGrantReader {
  list(input: {
    identity: CapabilityIdentity;
    ownerId: string;
    workspaceId: string;
  }): CapabilityGrant[];
}

export interface CapabilityJobResourcePort {
  authorize(command: {
    jobId: string;
    kind: 'tool' | 'path' | 'host' | 'application' | 'connection' | 'account' | 'worker' | 'effect';
    value: string;
  }): boolean;
}

export type CapabilityPermissionDenial =
  | 'permission_not_declared'
  | 'permission_not_granted'
  | 'runtime_policy_denied'
  | 'outside_workspace'
  | 'declared_scope_denied'
  | 'grant_scope_denied'
  | 'job_resource_denied'
  | 'unsupported_resource';

export type CapabilityPermissionDecision =
  | { allowed: true; permissionDigest: string; relativeResource?: string }
  | { allowed: false; reason: CapabilityPermissionDenial };

const DEFAULT_RUNTIME_PERMISSIONS: readonly CapabilityPermissionKind[] = [
  'filesystem.read',
  'filesystem.write',
  'artifact.create',
];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

function sameIdentity(left: CapabilityIdentity, right: CapabilityIdentity): boolean {
  return left.capabilityId === right.capabilityId
    && left.version === right.version
    && left.manifestVersion === right.manifestVersion
    && left.protocolVersion === right.protocolVersion
    && left.digest === right.digest;
}

function relativeWithin(root: string, target: string): string | null {
  const relative = path.relative(root, target);
  if (relative === '' || relative === '.') return '';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function canonicalPathWithMissingTail(value: string): string | null {
  let cursor = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.resolve(realpathSync.native(cursor), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function normalizeRelativePath(workspaceRoot: string, resource: string): string | null {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(resource);
  const logicalRelative = relativeWithin(root, target);
  if (logicalRelative === null) return null;
  const physicalRoot = canonicalPathWithMissingTail(root);
  const physicalTarget = canonicalPathWithMissingTail(target);
  if (!physicalRoot || !physicalTarget || relativeWithin(physicalRoot, physicalTarget) === null) return null;
  return logicalRelative;
}

function pathAllowed(patterns: readonly string[] | undefined, relative: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => {
    if (pattern === '*' || pattern === '**' || pattern === '**/*') return true;
    if (pattern.includes('\\') || pattern.startsWith('/') || /^[A-Za-z]:/u.test(pattern)
        || pattern.split('/').some((part) => part === '..')) return false;
    return picomatch(pattern, { dot: true, nocase: process.platform === 'win32' })(relative);
  });
}

function resourceAllowed(
  permission: CapabilityPermissionKind,
  scope: CapabilityPermissionScope,
  resource: string,
  relativePath?: string,
): boolean {
  if (permission === 'filesystem.read' || permission === 'filesystem.write' || permission === 'artifact.create') {
    return relativePath !== undefined && pathAllowed(scope.paths, relativePath);
  }
  if (permission === 'network.egress') return (scope.hosts ?? []).includes(resource.toLowerCase());
  if (permission === 'secret.use') return (scope.secretSlots ?? []).includes(resource);
  if (permission === 'app.action') return (scope.applications ?? []).includes(resource);
  return false;
}

function jobResourceKind(permission: CapabilityPermissionKind): CapabilityJobResourcePort['authorize'] extends (command: infer C) => boolean
  ? C extends { kind: infer K } ? K : never : never {
  if (permission.startsWith('filesystem.') || permission === 'artifact.create') return 'path';
  if (permission === 'network.egress') return 'host';
  if (permission === 'secret.use') return 'account';
  if (permission === 'app.action') return 'application';
  return 'effect';
}

function declarationKey(value: CapabilityPermissionDeclaration): string {
  return JSON.stringify(canonical(value));
}

export function capabilityPermissionDiff(
  previous: Pick<CapabilityManifest, 'permissions'>,
  next: Pick<CapabilityManifest, 'permissions'>,
): {
  added: CapabilityPermissionDeclaration[];
  removed: CapabilityPermissionDeclaration[];
  unchanged: CapabilityPermissionDeclaration[];
} {
  const before = new Map(previous.permissions.map((item) => [declarationKey(item), item]));
  const after = new Map(next.permissions.map((item) => [declarationKey(item), item]));
  return {
    added: [...after].filter(([key]) => !before.has(key)).map(([, item]) => item),
    removed: [...before].filter(([key]) => !after.has(key)).map(([, item]) => item),
    unchanged: [...after].filter(([key]) => before.has(key)).map(([, item]) => item),
  };
}

export function capabilityPermissionDigest(input: {
  identity: CapabilityIdentity;
  ownerId: string;
  workspaceId: string;
  grants: CapabilityGrant[];
  runtimePermissions: readonly CapabilityPermissionKind[];
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')}`;
}

export class CapabilityPermissionAuthority {
  private readonly runtimePermissions: ReadonlySet<CapabilityPermissionKind>;

  constructor(private readonly options: {
    grants: CapabilityGrantReader;
    runtimePermissions?: readonly CapabilityPermissionKind[];
    jobResources?: CapabilityJobResourcePort;
    jobId?: string;
  }) {
    this.runtimePermissions = new Set(options.runtimePermissions ?? DEFAULT_RUNTIME_PERMISSIONS);
  }

  authorize(input: {
    identity: CapabilityIdentity;
    manifest: CapabilityManifest;
    ownerId: string;
    workspaceId: string;
    workspaceRoot: string;
    permission: CapabilityPermissionKind;
    resource: string;
  }): CapabilityPermissionDecision {
    const declaration = input.manifest.permissions.find((candidate) => candidate.kind === input.permission);
    if (!declaration) return { allowed: false, reason: 'permission_not_declared' };
    if (!this.runtimePermissions.has(input.permission)) return { allowed: false, reason: 'runtime_policy_denied' };

    const filesystem = input.permission.startsWith('filesystem.') || input.permission === 'artifact.create';
    const relative = filesystem ? normalizeRelativePath(input.workspaceRoot, input.resource) : undefined;
    if (filesystem && relative === null) return { allowed: false, reason: 'outside_workspace' };
    if (!resourceAllowed(input.permission, declaration.scope, input.resource, relative ?? undefined)) {
      return { allowed: false, reason: 'declared_scope_denied' };
    }

    const grants = this.options.grants.list({
      identity: input.identity,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
    }).filter((candidate) => sameIdentity(candidate.identity, input.identity));
    const matching = grants.filter((candidate) => candidate.permission === input.permission);
    if (matching.length === 0) return { allowed: false, reason: 'permission_not_granted' };
    if (!matching.some((candidate) => resourceAllowed(input.permission, candidate.scope, input.resource, relative ?? undefined))) {
      return { allowed: false, reason: 'grant_scope_denied' };
    }

    if (this.options.jobResources && this.options.jobId
        && !this.options.jobResources.authorize({
          jobId: this.options.jobId,
          kind: jobResourceKind(input.permission),
          value: input.resource,
        })) {
      return { allowed: false, reason: 'job_resource_denied' };
    }
    if (input.permission === 'process.spawn') return { allowed: false, reason: 'runtime_policy_denied' };
    return {
      allowed: true,
      ...(relative === undefined ? {} : { relativeResource: relative }),
      permissionDigest: capabilityPermissionDigest({
        identity: input.identity,
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        grants,
        runtimePermissions: [...this.runtimePermissions],
      }),
    };
  }
}
