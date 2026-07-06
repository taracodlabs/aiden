/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/writeFileVerified.ts — the single shared choke-point for TRUSTED text
 * file writes.
 *
 * Every content-writing file tool (`file_write`, `file_patch`) routes through
 * here instead of calling `fs.writeFile` directly, so a "success" result is
 * actually *verified* rather than "the write call didn't throw".
 *
 * Two guarantees:
 *   1. CRASH-SAFE ATOMIC WRITE — content goes to a temp file in the same
 *      directory, is fsync'd, then atomically renamed onto the destination
 *      (atomic on POSIX and on NTFS ReplaceFile semantics). A crash mid-write
 *      never leaves a half-written file at the destination. Symlink-aware (the
 *      link target is written, not replaced) and mode-preserving on overwrite.
 *      This is the general-purpose sibling of `core/v4/cron/atomicWrite.ts`
 *      (which is JSON/cron-scoped) — kept separate so neither couples to the
 *      other.
 *   2. READ-BACK VERIFICATION — after the rename, the file is read back from
 *      disk and compared to the intended content. On a match the result carries
 *      the ACTUAL on-disk byte length. On mismatch or read failure it THROWS
 *      `WriteVerificationError` — callers must surface that, never claim success.
 *
 * A per-path in-process mutex serialises concurrent writers to the same file so
 * two racing writes produce one valid final state, not an interleaved one.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** A verified write outcome — `bytes` is the length read back from disk. */
export interface VerifiedWriteResult {
  /** The path actually written (symlink-resolved when the target was a link). */
  path: string;
  /** Actual on-disk byte length, measured from the read-back — not a guess. */
  bytes: number;
}

/** Thrown when the on-disk content does not match what we intended to write, or
 *  the read-back itself fails. Signals the write cannot be trusted. */
export class WriteVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteVerificationError';
  }
}

export interface WriteVerifiedOpts {
  /**
   * Test seam — override the read-back reader to simulate a corrupt / lying
   * filesystem (a disk that reports a write succeeded but stored something
   * else). Production callers never set this. Default: `fsp.readFile(p,'utf8')`.
   */
  readBackImpl?: (resolvedPath: string) => Promise<string>;
}

const inflight = new Map<string, Promise<VerifiedWriteResult>>();

/**
 * Write `content` to `filePath` atomically, then verify it landed by reading it
 * back. Returns the verified on-disk byte length. Throws `WriteVerificationError`
 * (or the underlying fs error) if the write cannot be trusted — never returns a
 * result for an unverified write.
 */
export async function writeFileVerified(
  filePath: string,
  content: string,
  opts?: WriteVerifiedOpts,
): Promise<VerifiedWriteResult> {
  const previous = inflight.get(filePath) ?? Promise.resolve<VerifiedWriteResult | undefined>(undefined);
  const next = previous.catch(() => undefined).then(() => doVerifiedWrite(filePath, content, opts));
  inflight.set(filePath, next);
  try {
    return await next;
  } finally {
    if (inflight.get(filePath) === next) inflight.delete(filePath);
  }
}

async function doVerifiedWrite(
  filePath: string,
  content: string,
  opts?: WriteVerifiedOpts,
): Promise<VerifiedWriteResult> {
  // Symlink-aware: resolve so we write THROUGH a link to its target instead of
  // replacing the link with a regular file (matches fs.writeFile's follow
  // behaviour). realpath throws for a new/non-existent path — use it as-is.
  let resolvedPath = filePath;
  try {
    resolvedPath = await fsp.realpath(filePath);
  } catch {
    /* new file or non-symlink — keep the original path */
  }

  // Preserve the existing file's mode on overwrite. temp+rename creates a new
  // inode with default perms, which would otherwise silently drop +x /
  // read-only etc. that plain fs.writeFile (in-place truncate) would keep.
  let priorMode: number | undefined;
  try {
    priorMode = (await fsp.stat(resolvedPath)).mode;
  } catch {
    /* new file — no mode to preserve */
  }

  const dir = path.dirname(resolvedPath);
  const tmpPath = path.join(dir, `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.mkdir(dir, { recursive: true });

  const fh = await fsp.open(tmpPath, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    // Force bytes to disk before the rename — without this, a crash between
    // rename() and writeback can still leave an empty file at the destination.
    try { await fh.sync(); } catch { /* best-effort fsync on platforms without it */ }
  } finally {
    await fh.close();
  }

  try {
    await fsp.rename(tmpPath, resolvedPath);
  } catch (err) {
    try { await fsp.unlink(tmpPath); } catch { /* clean up the orphan temp file */ }
    throw err;
  }
  if (priorMode !== undefined) {
    try { await fsp.chmod(resolvedPath, priorMode); } catch { /* non-POSIX best-effort */ }
  }

  // ── Verify: read the file back and compare to what we intended to write ────
  const readBack = opts?.readBackImpl ?? ((p: string) => fsp.readFile(p, 'utf8'));
  let onDisk: string;
  try {
    onDisk = await readBack(resolvedPath);
  } catch (err) {
    throw new WriteVerificationError(
      `write to ${resolvedPath} could not be verified — read-back failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (onDisk !== content) {
    throw new WriteVerificationError(
      `write to ${resolvedPath} failed verification — on-disk content differs from intended ` +
        `(intended ${Buffer.byteLength(content, 'utf8')} bytes, on disk ${Buffer.byteLength(onDisk, 'utf8')} bytes)`,
    );
  }
  return { path: resolvedPath, bytes: Buffer.byteLength(onDisk, 'utf8') };
}
