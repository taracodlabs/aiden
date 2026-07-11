/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/fsSnapshot.ts — P1B-2B: real, FAIL-SAFE filesystem capture.
 *
 * Produces P1B-2A `SnapshotObservation`s from real files. The one invariant:
 * a snapshot must NEVER affect command execution. Every failure mode — a throw,
 * a hang, a timeout, a permission error, an unanticipated error code, a slow
 * hash — is caught and recorded as `unknown{cause}`, and the command proceeds
 * exactly as it does today. Proven by the fail-safe teeth, not assumed.
 *
 * The stale-artifact-laundering boundary is an ALLOWLIST, not a denylist:
 * ONLY `ENOENT` maps to `absent`. Every other code (`EACCES`, `EPERM`, a
 * timeout, and any code we did not anticipate) maps to `unknown` — so a new
 * error code can never slip through and make a pre-existing file look created.
 */

import { promises as fsp, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SnapshotObservation, CaptureError, Fingerprint, SnapshotPair } from './temporalEvidence';

/** Pre-state latency budget — a FAIL-SAFE timeout, not a perf knob. On exceed
 *  we record `unknown` and the command spawns immediately. */
export const DEFAULT_SNAPSHOT_BUDGET_MS = 25;
/** Files above this size are never hashed (the hash would blow the budget). */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

/** A sink the execution gate hands finished pairs to. Shadow, non-authoritative. */
export type SnapshotSink = (pair: SnapshotPair) => void;

export interface SnapshotOptions {
  budgetMs?: number;
  /** Compute a content hash for present files (default true). */
  hash?: boolean;
  /** Test seam ONLY — inject the stat implementation to exercise hang/error
   *  paths deterministically. Production always uses async `fs.promises.stat`. */
  _stat?: (absPath: string) => Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
}

/** Map a NON-ENOENT error to a capture cause. Best-effort label — the OBSERVATION
 *  is `unknown` regardless; only the cause string varies. */
function causeOf(err: unknown): CaptureError {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'access_denied';
  return 'inspection_error';
}

/**
 * THE stale-artifact-laundering boundary — an ALLOWLIST, not a denylist. ONLY
 * `ENOENT` (the file provably isn't there) maps to `absent`. EVERY other code —
 * `EACCES`, `EPERM`, a timeout, and any code we did not anticipate — maps to
 * `unknown`. A new/unexpected error code can never slip through and make a
 * pre-existing file look created. A bug here is catastrophic, so it is one line.
 */
export function classifyStatError(err: unknown): SnapshotObservation {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown', cause: causeOf(err) };
}

/** Hash a file within a budget. Resolves `undefined` on ANY error/timeout —
 *  never rejects, never blocks past the budget. */
function hashWithin(absPath: string, budgetMs: number): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    let done = false;
    const finish = (v: string | undefined): void => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(undefined), Math.max(1, budgetMs));
    try {
      const h = createHash('sha256');
      const s = createReadStream(absPath);
      s.on('data', (c: Buffer | string) => h.update(c));
      s.on('error', () => { clearTimeout(timer); finish(undefined); });
      s.on('end', () => { clearTimeout(timer); finish(h.digest('hex')); });
    } catch {
      clearTimeout(timer);
      finish(undefined);
    }
  });
}

/**
 * Observe one file, fail-safe. Uses ASYNC stat (a hung stat cannot block the
 * event loop, so the budget timer can always win). Never throws.
 */
export async function fileSnapshot(absPath: string, opts: SnapshotOptions = {}): Promise<SnapshotObservation> {
  const budgetMs = opts.budgetMs ?? DEFAULT_SNAPSHOT_BUDGET_MS;
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SnapshotObservation>((res) => {
    timer = setTimeout(() => res({ kind: 'unknown', cause: 'timeout' }), Math.max(1, budgetMs));
  });
  const statFn = opts._stat ?? ((p: string) => fsp.stat(p));
  const work: Promise<SnapshotObservation> = (async (): Promise<SnapshotObservation> => {
    let st: { size: number; mtimeMs: number; isFile(): boolean };
    try {
      st = await statFn(absPath);
    } catch (err) {
      return classifyStatError(err); // ENOENT → absent; everything else → unknown
    }
    const fp: Fingerprint = { size: st.size, mtimeMs: st.mtimeMs };
    if (opts.hash !== false && st.isFile() && st.size <= MAX_HASH_BYTES) {
      const remaining = budgetMs - (Date.now() - start);
      if (remaining > 2) {
        const hash = await hashWithin(absPath, remaining);
        if (hash) fp.contentHash = hash;
      }
    }
    return { kind: 'present', fingerprint: fp };
  })().catch((err): SnapshotObservation => ({ kind: 'unknown', cause: causeOf(err) }));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The DECLARED file targets of a tool, from its args (available pre-spawn). Only
 * the exact-path file tools this slice covers; shell + everything else returns
 * `[]` (their target isn't structured in args — never guessed).
 */
export function snapshotTargetsForTool(toolName: string, args: Record<string, unknown>): string[] {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  switch (toolName) {
    case 'file_write':
    case 'file_delete': {
      const p = str(args.path);
      return p ? [p] : [];
    }
    case 'file_move': {
      return [str(args.from), str(args.to)].filter((x): x is string => x !== null);
    }
    default:
      return [];
  }
}

/** file path → resource id, matching executionContract's `file://<path>` scheme. */
export function resourceIdForPath(path: string): string {
  return `file://${path}`;
}

/**
 * A bounded, in-memory collector — the production shadow store. Holds recent
 * pairs so the capture path is exercised on real commands; consumed by no
 * authoritative path. Self-bounding, so it never grows without limit.
 */
export class BoundedSnapshotLedger {
  private readonly buf: SnapshotPair[] = [];
  constructor(private readonly cap = 200) {}
  readonly sink: SnapshotSink = (pair) => {
    this.buf.push(pair);
    if (this.buf.length > this.cap) this.buf.shift();
  };
  recent(): readonly SnapshotPair[] {
    return this.buf;
  }
}
