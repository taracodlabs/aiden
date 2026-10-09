/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/pathLockRegistry.ts — in-memory file path overlap detection.
 *
 * Parallel subagents (core/v4/subagent/fanout.ts) share the same file tools.
 * Without a guard, two children writing the same path silently overwrite one
 * another. This registry tracks which in-flight tool calls hold a read or
 * write claim on a path, and rejects a conflicting claim *before* the second
 * tool starts (fail-fast, with a clear error the model can act on).
 *
 * Rules:
 *   - read  + read   → allowed
 *   - read  + write  → conflict
 *   - write + write  → conflict
 *   - A claim never conflicts with another claim held by the same owner.
 *
 * Scope (v1): single process, in-memory. It does not protect against other
 * processes touching the same file.
 */

import path from 'node:path';

import { realpathWithFallback } from './sandboxFs';

export type PathLockMode = 'read' | 'write';

export interface PathLockHolder {
  /** Unique id of the claim owner (a tool call id). */
  readonly owner: string;
  /** Human-readable description used in conflict messages. */
  readonly label: string;
}

export interface PathLockRequest {
  readonly path: string;
  readonly mode: PathLockMode;
}

export class PathConflictError extends Error {
  readonly conflictPath: string;
  readonly requestedMode: PathLockMode;
  readonly holder: PathLockHolder;

  constructor(conflictPath: string, requestedMode: PathLockMode, holder: PathLockHolder, holderMode: PathLockMode) {
    super(
      `Path conflict: "${conflictPath}" is currently being ${holderMode === 'write' ? 'written' : 'read'} ` +
      `by ${holder.label}; refusing to start a concurrent ${requestedMode}. ` +
      'Use a different path or retry after the other operation finishes.',
    );
    this.name = 'PathConflictError';
    this.conflictPath = conflictPath;
    this.requestedMode = requestedMode;
    this.holder = holder;
  }
}

interface PathState {
  writer: PathLockHolder | null;
  readers: Map<string, PathLockHolder>;
}

/** Resolve a tool-supplied path to a stable key (absolute, symlinks resolved). */
export function normalizeLockPath(rawPath: string, cwd: string): string {
  const absolute = path.resolve(cwd, rawPath);
  let real = absolute;
  try {
    real = realpathWithFallback(absolute);
  } catch {
    // Never let key normalization break a tool call; fall back to the lexical path.
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

export class PathLockRegistry {
  private readonly states = new Map<string, PathState>();

  /**
   * Claim every requested path atomically: either all claims are granted or
   * none are (a conflict on any path throws and leaves the registry unchanged).
   * Returns an idempotent `release()`; call it from a `finally`.
   *
   * Paths must already be normalized (see `normalizeLockPath`).
   */
  acquire(requests: readonly PathLockRequest[], holder: PathLockHolder): () => void {
    // Collapse duplicates: a write request on a path wins over a read request.
    const wanted = new Map<string, PathLockMode>();
    for (const r of requests) {
      if (wanted.get(r.path) !== 'write') wanted.set(r.path, r.mode);
    }

    // Pass 1 — check everything, mutate nothing.
    for (const [p, mode] of wanted) {
      const state = this.states.get(p);
      if (!state) continue;
      if (state.writer && state.writer.owner !== holder.owner) {
        throw new PathConflictError(p, mode, state.writer, 'write');
      }
      if (mode === 'write') {
        for (const reader of state.readers.values()) {
          if (reader.owner !== holder.owner) throw new PathConflictError(p, mode, reader, 'read');
        }
      }
    }

    // Pass 2 — record claims.
    for (const [p, mode] of wanted) {
      let state = this.states.get(p);
      if (!state) {
        state = { writer: null, readers: new Map() };
        this.states.set(p, state);
      }
      if (mode === 'write') state.writer = holder;
      else state.readers.set(holder.owner, holder);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const p of wanted.keys()) {
        const state = this.states.get(p);
        if (!state) continue;
        if (state.writer?.owner === holder.owner) state.writer = null;
        state.readers.delete(holder.owner);
        if (!state.writer && state.readers.size === 0) this.states.delete(p);
      }
    };
  }

  /** Number of paths with at least one active claim (for tests/diagnostics). */
  activePathCount(): number {
    return this.states.size;
  }
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

/**
 * Which paths a file tool will touch, and how. Mirrors the argument aliases
 * the tool wrappers in tools/v4/files/ actually accept (`path`/`file`,
 * `from`/`source`, `to`/`dest`/`destination`) — reading only `path` would let
 * an aliased argument slip past the lock. Non-file tools return `[]`.
 */
export function lockRequestsForTool(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): PathLockRequest[] {
  const single = str(args.path) ?? str(args.file);
  const from = str(args.from) ?? str(args.source);
  const to = str(args.to) ?? str(args.dest) ?? str(args.destination);
  const out: PathLockRequest[] = [];

  switch (toolName) {
    case 'file_write':
    case 'file_patch':
    case 'file_delete':
      if (single) out.push({ path: single, mode: 'write' });
      break;
    case 'file_read':
      if (single) out.push({ path: single, mode: 'read' });
      break;
    case 'file_copy':
      if (from) out.push({ path: from, mode: 'read' });
      if (to) out.push({ path: to, mode: 'write' });
      break;
    case 'file_move':
      if (from) out.push({ path: from, mode: 'write' });
      if (to) out.push({ path: to, mode: 'write' });
      break;
    default:
      break;
  }
  return out;
}

/** Process-wide registry shared by every executor built from a ToolRegistry. */
export const processPathLocks = new PathLockRegistry();
