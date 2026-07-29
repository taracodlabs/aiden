/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { realpathWithFallback } from '../sandboxFs';

const execFileAsync = promisify(execFile);

export type WorkspacePathKind = 'windows' | 'posix' | 'unc' | 'wsl';

export interface WorkspaceDescriptor {
  id: string;
  requestedPath: string;
  canonicalPath: string;
  portablePath: string;
  pathKind: WorkspacePathKind;
  platform: NodeJS.Platform;
  exists: boolean;
  repositoryRoot?: string;
  gitDirectory?: string;
  gitCommonDirectory?: string;
  outerRepositoryRoot?: string;
  vcsKind: 'git' | 'none';
  trustPolicyDigest: string;
}

function portable(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(normalized)) return normalized[0].toUpperCase() + normalized.slice(1);
  return normalized;
}

function identityPath(value: string, platform: NodeJS.Platform): string {
  const normalized = portable(value);
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function kindOf(value: string, platform: NodeJS.Platform): WorkspacePathKind {
  if (/^(?:\\\\|\/\/)/.test(value)) return 'unc';
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(value)) return 'wsl';
  if (platform === 'win32' || /^[a-z]:[\\/]/i.test(value)) return 'windows';
  return 'posix';
}

async function gitText(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-c', 'color.ui=false', '-C', cwd, ...args], {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

async function discoverGit(canonicalPath: string): Promise<Pick<WorkspaceDescriptor,
  'repositoryRoot' | 'gitDirectory' | 'gitCommonDirectory' | 'outerRepositoryRoot' | 'vcsKind'>> {
  const root = await gitText(canonicalPath, ['rev-parse', '--show-toplevel']);
  if (!root) return { vcsKind: 'none' };
  const repositoryRoot = realpathWithFallback(root);
  const gitDirectoryRaw = await gitText(canonicalPath, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const gitCommonRaw = await gitText(canonicalPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDirectory = gitDirectoryRaw ? realpathWithFallback(gitDirectoryRaw) : undefined;
  const gitCommonDirectory = gitCommonRaw
    ? realpathWithFallback(path.isAbsolute(gitCommonRaw) ? gitCommonRaw : path.join(repositoryRoot, gitCommonRaw))
    : undefined;
  const parent = path.dirname(repositoryRoot);
  const outer = parent !== repositoryRoot ? await gitText(parent, ['rev-parse', '--show-toplevel']) : undefined;
  const outerRepositoryRoot = outer && identityPath(outer, process.platform) !== identityPath(repositoryRoot, process.platform)
    ? realpathWithFallback(outer)
    : undefined;
  return { repositoryRoot, gitDirectory, gitCommonDirectory, outerRepositoryRoot, vcsKind: 'git' };
}

/** Resolve a caller-supplied root into the one durable workspace identity. */
export async function resolveWorkspace(requestedPath: string): Promise<WorkspaceDescriptor> {
  if (typeof requestedPath !== 'string' || requestedPath.includes('\0') || requestedPath.trim().length === 0) {
    throw new Error('Workspace path must be a non-empty filesystem path');
  }
  const requested = path.resolve(requestedPath);
  const canonicalPath = realpathWithFallback(requested);
  const exists = canonicalPath === realpathWithFallback(canonicalPath)
    && await import('node:fs').then(({ existsSync }) => existsSync(canonicalPath));
  const pathKind = kindOf(requestedPath, process.platform);
  let discoveryRoot = canonicalPath;
  while (!await import('node:fs').then(({ existsSync }) => existsSync(discoveryRoot))) {
    const parent = path.dirname(discoveryRoot);
    if (parent === discoveryRoot) break;
    discoveryRoot = parent;
  }
  const git = await discoverGit(discoveryRoot);
  const portablePath = portable(canonicalPath);
  const identity = identityPath(canonicalPath, process.platform);
  const trustPolicyDigest = createHash('sha256').update(JSON.stringify({
    version: 1,
    identity,
    repositoryRoot: git.repositoryRoot ? identityPath(git.repositoryRoot, process.platform) : null,
    vcsKind: git.vcsKind,
  })).digest('hex');
  return {
    id: `workspace_${createHash('sha256').update(`${process.platform}\0${identity}`).digest('hex')}`,
    requestedPath: requested,
    canonicalPath,
    portablePath,
    pathKind,
    platform: process.platform,
    exists,
    ...git,
    trustPolicyDigest,
  };
}

export function isSameWorkspacePath(left: string, right: string, platform = process.platform): boolean {
  return identityPath(realpathWithFallback(left), platform) === identityPath(realpathWithFallback(right), platform);
}
