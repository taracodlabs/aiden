/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import path from 'node:path';

type PathDialect = 'windows' | 'posix' | 'native';

function dialect(value: string): PathDialect {
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return 'windows';
  if (path.posix.isAbsolute(value)) return 'posix';
  return 'native';
}

function normalize(value: string, kind: PathDialect): string {
  if (kind === 'windows') return path.win32.resolve(value);
  if (kind === 'posix') return path.posix.resolve(value);
  return path.resolve(value);
}

/** Resolve a path using the syntax carried by the value or its durable base. */
export function resolvePortablePath(base: string, value: string): string {
  const valueDialect = dialect(value);
  if (valueDialect !== 'native') return normalize(value, valueDialect);
  const baseDialect = dialect(base);
  if (baseDialect === 'windows') return path.win32.resolve(base, value);
  if (baseDialect === 'posix') return path.posix.resolve(base, value);
  return path.resolve(base, value);
}

/** Compare a candidate with a durable path root without adopting the current host's syntax. */
export function isPortablePathWithin(candidate: string, root: string): boolean {
  const rootDialect = dialect(root);
  const candidateDialect = dialect(candidate);
  if (rootDialect !== 'native' && candidateDialect !== rootDialect) return false;
  const comparisonDialect = rootDialect === 'native' ? candidateDialect : rootDialect;
  const normalizedRoot = normalize(root, comparisonDialect);
  const normalizedCandidate = normalize(candidate, comparisonDialect);
  const separator = comparisonDialect === 'windows'
    ? path.win32.sep
    : comparisonDialect === 'posix' ? path.posix.sep : path.sep;
  const comparableRoot = comparisonDialect === 'windows' ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableCandidate = comparisonDialect === 'windows' ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  return comparableCandidate === comparableRoot
    || comparableCandidate.startsWith(`${comparableRoot}${separator}`);
}
