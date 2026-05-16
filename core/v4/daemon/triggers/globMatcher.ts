/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/globMatcher.ts — v4.5 Phase 2.
 *
 * chokidar 4.x removed built-in glob matching. We use `picomatch`
 * (already in Aiden's transitive deps) to filter paths AFTER
 * chokidar emits — same semantics, less bundle weight.
 *
 * Match semantics (applied in order):
 *   1. ignoreTemp default deny list (editor temps, .git/, node_modules/, …)
 *   2. spec.excludeGlobs deny list
 *   3. spec.includeGlobs allow list (default ['**∕*'])
 *
 * Compiled matchers are cached per-spec so we don't recompile on
 * every event.
 */

import picomatch from 'picomatch';

/** Default ignore patterns when FileWatcherSpec.ignoreTemp = true. */
export const DEFAULT_IGNORE_PATTERNS: ReadonlyArray<string> = Object.freeze([
  // editor temps
  '**/*.swp', '**/*.swo', '**/*~',
  '**/.*.swp', '**/.*.swo',
  '**/*.tmp', '**/*.temp', '**/*.part',
  '**/.#*',                          // emacs lock
  '**/~$*',                          // MS Office temp
  // OS metadata
  '**/.DS_Store', '**/Thumbs.db', '**/desktop.ini',
  // VCS
  '**/.git/**', '**/.svn/**', '**/.hg/**',
  // dependency / build outputs
  '**/node_modules/**',
  '**/dist/**', '**/build/**', '**/.next/**',
  '**/__pycache__/**', '**/*.pyc',
  '**/.venv/**', '**/venv/**',
  '**/target/**',
]);

export interface GlobMatcher {
  /** True when `path` should be forwarded to the trigger bus. */
  match(absPath: string): boolean;
}

export interface GlobMatcherOptions {
  includeGlobs?: ReadonlyArray<string>;   // default ['**/*']
  excludeGlobs?: ReadonlyArray<string>;   // additional excludes
  ignoreTemp?:   boolean;                 // default true
}

/**
 * Normalize a glob pattern so it matches absolute paths sensibly.
 *
 * The user mental model is "`*.txt` matches `.txt` files anywhere",
 * but picomatch's `*` does NOT span path separators — so a bare
 * basename glob like `*.txt` never matches `/some/dir/foo.txt`.
 *
 * Rule: if a pattern doesn't already begin with double-star,
 * a leading slash, a Windows drive letter (`C:`), or contain a
 * `/` directory separator, treat it as a basename pattern and
 * prepend a depth-spanning prefix so it matches at any depth.
 * Patterns that already express locality (containing `/` or
 * starting with double-star) are left alone.
 */
export function normalizeGlobPattern(pat: string): string {
  if (pat.startsWith('**')) return pat;
  if (pat.startsWith('/')) return pat;
  if (/^[A-Za-z]:/.test(pat)) return pat;          // absolute Windows path
  if (pat.includes('/')) return pat;
  return '**/' + pat;
}

export function compileGlobMatcher(opts: GlobMatcherOptions): GlobMatcher {
  const include = opts.includeGlobs && opts.includeGlobs.length > 0
    ? opts.includeGlobs
    : ['**/*'];
  const exclude = [
    ...(opts.excludeGlobs ?? []),
    ...(opts.ignoreTemp !== false ? DEFAULT_IGNORE_PATTERNS : []),
  ];
  const opt = { dot: true, nocase: process.platform === 'win32' };
  const compile = (p: string): (s: string) => boolean => picomatch(normalizeGlobPattern(p), opt);
  const includeFns = include.map(compile);
  const excludeFns = exclude.map(compile);

  return {
    match(absPath: string): boolean {
      // Normalize to forward slashes for cross-platform glob matching.
      const norm = absPath.replace(/\\/g, '/');
      for (const fn of excludeFns) if (fn(norm)) return false;
      for (const fn of includeFns) if (fn(norm)) return true;
      return false;
    },
  };
}
