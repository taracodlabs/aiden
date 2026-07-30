/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Pure terminal projection for already-authoritative file effects.
 */
import path from 'node:path';

export type FileEffectOperation = 'create' | 'modify' | 'patch' | 'delete' | 'move' | 'rename';

export interface FileEffectPresentation {
  marker: 'A' | 'M' | 'D' | 'R' | '=' | '!';
  label: 'Created' | 'Modified' | 'Deleted' | 'Moved' | 'Renamed' | 'Unchanged' | 'Conflict blocked';
  path: string;
  destination?: string;
  verified: boolean;
  blocked: boolean;
}

export interface RepositoryStatePresentation {
  branch: string;
  head: string;
  state: 'repository' | 'unborn repository' | 'non-Git directory';
}

export function projectRepositoryState(input: {
  vcsKind: 'git' | 'none';
  branch: string | null;
  headCommit: string | null;
}): RepositoryStatePresentation {
  if (input.vcsKind === 'none') {
    return { branch: 'not applicable', head: 'not applicable', state: 'non-Git directory' };
  }
  return {
    branch: input.branch ?? 'detached',
    head: input.headCommit ? input.headCommit.slice(0, 12) : 'no commits yet',
    state: input.headCommit ? 'repository' : 'unborn repository',
  };
}

function relativeDisplayPath(cwd: string, value: string): string {
  if (!value) return value;
  const pathApi = /^[A-Za-z]:[\\/]/u.test(value) || /^[A-Za-z]:[\\/]/u.test(cwd)
    ? path.win32 : path;
  if (!pathApi.isAbsolute(value)) return value.replace(/\\/gu, '/');
  const relative = pathApi.relative(pathApi.resolve(cwd), pathApi.resolve(value));
  return (relative && !relative.startsWith(`..${pathApi.sep}`) && relative !== '..'
    ? relative : value).replace(/\\/gu, '/');
}

export function projectFileEffect(input: {
  toolName: string;
  result: unknown;
  cwd: string;
}): FileEffectPresentation | null {
  if (!['file_write', 'file_patch', 'file_delete', 'file_move'].includes(input.toolName)) return null;
  if (!input.result || typeof input.result !== 'object') return null;
  const result = input.result as Record<string, unknown>;
  const operation = typeof result.operation === 'string'
    ? result.operation as FileEffectOperation : null;
  const rawPath = typeof result.path === 'string' ? result.path
    : typeof result.from === 'string' ? result.from : '';
  const destination = typeof result.destination === 'string' ? result.destination
    : typeof result.to === 'string' ? result.to : undefined;
  const conflict = typeof result.conflict === 'string' ? result.conflict
    : typeof result.error === 'string' && /source changed|stale.*(?:source|snapshot)|conflict/iu.test(result.error)
      ? result.error : null;

  if (conflict && rawPath) {
    return {
      marker: '!', label: 'Conflict blocked', path: relativeDisplayPath(input.cwd, rawPath),
      verified: false, blocked: true,
    };
  }
  if (result.success !== true || !rawPath) return null;
  if (result.skipped === true) {
    return {
      marker: '=', label: 'Unchanged', path: relativeDisplayPath(input.cwd, rawPath),
      verified: result.verified === true, blocked: false,
    };
  }
  const projection = operation === 'create' ? { marker: 'A' as const, label: 'Created' as const }
    : operation === 'modify' || operation === 'patch' ? { marker: 'M' as const, label: 'Modified' as const }
      : operation === 'delete' ? { marker: 'D' as const, label: 'Deleted' as const }
        : operation === 'rename' ? { marker: 'R' as const, label: 'Renamed' as const }
          : operation === 'move' ? { marker: 'R' as const, label: 'Moved' as const }
            : null;
  if (!projection) return null;
  return {
    ...projection,
    path: relativeDisplayPath(input.cwd, rawPath),
    ...(destination ? { destination: relativeDisplayPath(input.cwd, destination) } : {}),
    verified: result.verified === true,
    blocked: false,
  };
}
