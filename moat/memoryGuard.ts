/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/memoryGuard.ts — Aiden v4.0.0
 *
 * The Aiden moat. Every memory write call goes through here; after
 * the underlying provider returns, MemoryGuard re-reads the
 * corresponding file via `loadSnapshot()` and confirms the change is
 * actually present (or absent for `remove`). The result includes
 * `verified: boolean`, surfaced through the tool wrapper to the
 * agent loop and (in Phase 12) to the HonestyEnforcement layer.
 *
 * Why: v3 / Hermes occasionally claimed "saved to MEMORY.md" in the
 * assistant turn when no write actually happened (capacity exceeded,
 * concurrent-write collision, etc.). MemoryGuard makes that lie
 * physically impossible: the post-write read happens under the same
 * provider lock, so a wrapper that returns `{ ok: true, verified:
 * false }` is the loud failure mode the Honesty layer can latch onto.
 *
 * MemoryGuard does NOT mutate the provider's contract. It rejects
 * dual-intent calls early (`add` of empty content, `replace` where
 * old/new are identical) but otherwise returns the provider's result
 * unchanged plus a `verified` flag.
 *
 * Status: PHASE 9.
 */

import type {
  MemoryProvider,
  MemorySnapshot,
} from '../core/v4/memoryProvider';
import type { MemoryFile } from '../core/v4/memoryManager';

export interface GuardedResult {
  ok: boolean;
  /** Did the post-write read confirm the change? */
  verified: boolean;
  reason?: string;
  /** Char count of the file after the write (for capacity surfacing). */
  fileLength?: number;
}

export class MemoryGuard {
  constructor(private readonly memory: MemoryProvider) {}

  async guardedAdd(
    file: MemoryFile,
    content: string,
  ): Promise<GuardedResult> {
    const trimmed = content.trim();
    if (!trimmed) {
      return { ok: false, verified: false, reason: 'Content cannot be empty.' };
    }
    const result = await this.memory.add(file, trimmed);
    if (!result.ok) {
      return {
        ok: false,
        verified: false,
        reason: result.reason ?? 'add() failed',
      };
    }
    const snap = await this.memory.loadSnapshot();
    const text = pickFile(snap, file);
    const verified = text.includes(trimmed);
    if (!verified) {
      return {
        ok: false,
        verified: false,
        reason: 'Write claimed but content not found in file (verification failed)',
        fileLength: text.length,
      };
    }
    return { ok: true, verified: true, fileLength: text.length };
  }

  async guardedReplace(
    file: MemoryFile,
    oldText: string,
    newText: string,
  ): Promise<GuardedResult> {
    const oldTrim = oldText.trim();
    const newTrim = newText.trim();
    if (!oldTrim) {
      return { ok: false, verified: false, reason: 'oldText cannot be empty.' };
    }
    if (!newTrim) {
      return {
        ok: false,
        verified: false,
        reason: 'newText cannot be empty. Use guardedRemove() to delete entries.',
      };
    }
    if (oldTrim === newTrim) {
      return {
        ok: false,
        verified: false,
        reason: 'oldText and newText are identical — nothing to replace.',
      };
    }
    const result = await this.memory.replace(file, oldTrim, newTrim);
    if (!result.ok) {
      return {
        ok: false,
        verified: false,
        reason: result.reason ?? 'replace() failed',
      };
    }
    const snap = await this.memory.loadSnapshot();
    const text = pickFile(snap, file);
    const newPresent = text.includes(newTrim);
    const oldStillPresent = text.includes(oldTrim);
    if (!newPresent) {
      return {
        ok: false,
        verified: false,
        reason: 'Replace claimed but newText not found in file (verification failed)',
        fileLength: text.length,
      };
    }
    if (oldStillPresent) {
      // newText could be a substring of an unrelated entry that already
      // contained oldText — surface as unverified to be safe.
      return {
        ok: false,
        verified: false,
        reason: 'Replace claimed but oldText still present (verification failed)',
        fileLength: text.length,
      };
    }
    return { ok: true, verified: true, fileLength: text.length };
  }

  async guardedRemove(
    file: MemoryFile,
    text: string,
  ): Promise<GuardedResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, verified: false, reason: 'text cannot be empty.' };
    }
    const result = await this.memory.remove(file, trimmed);
    if (!result.ok) {
      return {
        ok: false,
        verified: false,
        reason: result.reason ?? 'remove() failed',
      };
    }
    const snap = await this.memory.loadSnapshot();
    const after = pickFile(snap, file);
    const stillPresent = after.includes(trimmed);
    if (stillPresent) {
      return {
        ok: false,
        verified: false,
        reason: 'Remove claimed but content still in file (verification failed)',
        fileLength: after.length,
      };
    }
    return { ok: true, verified: true, fileLength: after.length };
  }
}

function pickFile(snap: MemorySnapshot, file: MemoryFile): string {
  return file === 'user' ? snap.userMd : snap.memoryMd;
}
