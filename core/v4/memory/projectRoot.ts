/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memory/projectRoot.ts — v4.9.0 Slice 11.
 *
 * Walk-up project-root detection. Returns the first ancestor of
 * `cwd` containing any of the standard project anchors:
 *
 *   .git/                    most repos
 *   package.json             Node
 *   pyproject.toml           Python
 *   Cargo.toml               Rust
 *   go.mod                   Go
 *   .aiden/PROJECT.md        explicit Aiden-managed project
 *
 * Returns `null` when the walk reaches the filesystem root without
 * finding any anchor. Result is cached per-process keyed on the
 * normalised cwd; the cache is cleared via `_resetProjectRootCacheForTests`.
 */

import fs from 'node:fs';
import path from 'node:path';

const ANCHORS: readonly string[] = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  path.join('.aiden', 'PROJECT.md'),
];

const _cache: Map<string, string | null> = new Map();

/**
 * Walk up from `cwd` looking for an anchor. Returns the absolute path
 * of the directory holding the first anchor, or `null` when nothing
 * is found before filesystem root. Cached per `cwd`.
 */
export function findProjectRoot(cwd: string = process.cwd()): string | null {
  const startedAt = path.resolve(cwd);
  if (_cache.has(startedAt)) return _cache.get(startedAt)!;

  let current = startedAt;
  // Cap the walk at 64 levels — pathological symlink loops shouldn't burn.
  for (let i = 0; i < 64; i += 1) {
    for (const anchor of ANCHORS) {
      const probe = path.join(current, anchor);
      try {
        const stat = fs.statSync(probe);
        if (stat.isFile() || stat.isDirectory()) {
          _cache.set(startedAt, current);
          return current;
        }
      } catch { /* ENOENT — keep looking */ }
    }
    const parent = path.dirname(current);
    if (parent === current) break;  // reached filesystem root
    current = parent;
  }
  _cache.set(startedAt, null);
  return null;
}

/** Test seam — clear the per-process cache. */
export function _resetProjectRootCacheForTests(): void {
  _cache.clear();
}
