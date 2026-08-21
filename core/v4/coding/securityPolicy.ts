/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

const REQUIRED_PROTECTED_PATHS = [
  '.git', '.git/**',
  '.aiden', '.aiden/**',
  '.env', '.env.*', '**/.env', '**/.env.*',
  '.npmrc', '**/.npmrc',
  '.pnpm-store', '.pnpm-store/**',
  '.ssh', '.ssh/**',
  'release-notes-v4.16.0.md',
] as const;

function normalizePolicy(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!normalized || /[\0\r\n]/.test(normalized) || /^[A-Za-z]:\//.test(normalized)
    || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('External coding protected paths must be safe repository-relative policies');
  }
  return normalized.replace(/\/$/, '');
}

/** Compile the non-negotiable host/repository denylist with task-specific paths. */
export function compileExternalCodingProtectedPaths(values: readonly string[]): string[] {
  return [...new Set([...REQUIRED_PROTECTED_PATHS, ...values].map(normalizePolicy))].sort();
}

