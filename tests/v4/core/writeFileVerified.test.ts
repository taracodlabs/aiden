/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14.x — the shared verified-write choke-point. Proves: an atomic write is
 * read back and byte-compared so "success" means the bytes are actually on disk;
 * a read-back that doesn't match (a lying disk) fails LOUDLY instead of claiming
 * success; and the temp+rename discipline leaves no half-written / orphan files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeFileVerified, WriteVerificationError } from '../../../core/v4/writeFileVerified';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-wfv-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('writeFileVerified — happy path', () => {
  it('writes, reads back, and returns the ACTUAL on-disk byte length', async () => {
    const p = path.join(dir, 'a.txt');
    const content = 'hello — ünîçödé ✓';
    const r = await writeFileVerified(p, content);
    expect(r.bytes).toBe(Buffer.byteLength(content, 'utf8'));   // real byte length, not char count
    expect(await fs.readFile(p, 'utf8')).toBe(content);         // it's actually on disk
  });

  it('creates missing parent directories', async () => {
    const p = path.join(dir, 'nested', 'deep', 'c.txt');
    await writeFileVerified(p, 'deep');
    expect(await fs.readFile(p, 'utf8')).toBe('deep');
  });

  it('overwrites cleanly and leaves NO orphan .tmp file behind', async () => {
    const p = path.join(dir, 'b.txt');
    await writeFileVerified(p, 'first');
    const r = await writeFileVerified(p, 'second, longer content');
    expect(await fs.readFile(p, 'utf8')).toBe('second, longer content');
    expect(r.bytes).toBe(Buffer.byteLength('second, longer content', 'utf8'));
    const leftovers = (await fs.readdir(dir)).filter((e) => e.includes('.tmp'));
    expect(leftovers).toEqual([]);                              // temp+rename cleaned up
  });

  it('serialises concurrent writes to the same path into one valid final state', async () => {
    const p = path.join(dir, 'race.txt');
    await Promise.all([
      writeFileVerified(p, 'A'.repeat(500)),
      writeFileVerified(p, 'B'.repeat(500)),
      writeFileVerified(p, 'C'.repeat(500)),
    ]);
    const final = await fs.readFile(p, 'utf8');
    // Exactly one writer's content — never an interleaved / truncated blend.
    expect([`${'A'.repeat(500)}`, `${'B'.repeat(500)}`, `${'C'.repeat(500)}`]).toContain(final);
  });
});

describe('writeFileVerified — fails LOUDLY when the write cannot be trusted', () => {
  it('throws WriteVerificationError when the read-back does not match (lying disk)', async () => {
    const p = path.join(dir, 'corrupt.txt');
    await expect(
      writeFileVerified(p, 'intended content', { readBackImpl: async () => 'something ELSE on disk' }),
    ).rejects.toBeInstanceOf(WriteVerificationError);
  });

  it('the mismatch error names the byte discrepancy (no silent success)', async () => {
    const p = path.join(dir, 'corrupt2.txt');
    await expect(
      writeFileVerified(p, 'abcde', { readBackImpl: async () => 'ab' }),
    ).rejects.toThrow(/failed verification.*intended 5 bytes.*on disk 2 bytes/);
  });

  it('throws when the read-back itself fails', async () => {
    const p = path.join(dir, 'unreadable.txt');
    await expect(
      writeFileVerified(p, 'x', { readBackImpl: async () => { throw new Error('EIO'); } }),
    ).rejects.toThrow(/read-back failed/);
  });
});
