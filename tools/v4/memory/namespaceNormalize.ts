/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/memory/namespaceNormalize.ts — v4.10 Slice 10.1.
 *
 * Shared file-arg normalization for the three memory_* tools.
 * Replaces the per-tool inline ternary (`args.file === 'user' ? 'user'
 * : 'memory'`) which silently clamped any unknown value to 'memory'.
 *
 * The new normalizer explicitly recognizes the three first-class
 * namespaces from `core/v4/memory/namespaceRegistry.ts` — `memory`,
 * `user`, `project`. Unknown values still fall back to `'memory'`
 * for back-compat with existing fixtures that pass garbage and
 * expect the legacy clamp; the namespaceRegistry's strict-throw
 * path catches truly unreachable namespaces downstream (e.g.
 * `project` without a projectRoot).
 *
 * Inline-helpered rather than added as a new tool wrapper file —
 * matches the Aiden pattern of "extend existing tool's enum, do
 * not duplicate the tool surface" (v4.10 Slice 10.1 design lock).
 */

/** First-class memory file values the tool surface accepts. */
export type MemoryFileArg = 'memory' | 'user' | 'project';

const KNOWN: ReadonlySet<MemoryFileArg> = new Set(['memory', 'user', 'project']);

/**
 * Normalize the model-supplied `file` arg to one of the three known
 * values. Unknown / undefined / non-string inputs clamp to `'memory'`
 * for back-compat with pre-Slice-10.1 callers.
 */
export function normalizeMemoryFile(raw: unknown): MemoryFileArg {
  if (typeof raw === 'string' && KNOWN.has(raw as MemoryFileArg)) {
    return raw as MemoryFileArg;
  }
  return 'memory';
}

/** Human-readable filename label used in preview summaries. */
export function fileLabel(file: MemoryFileArg): string {
  if (file === 'user')    return 'USER.md';
  if (file === 'project') return 'PROJECT.md';
  return 'MEMORY.md';
}
