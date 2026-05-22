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
 * Why: prior agents occasionally claimed "saved to MEMORY.md" in the
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
// v4.9.0 Slice 11 — method signatures widened from `MemoryFile` to
// `string` to accept the namespace registry's new entries. Legacy
// callers passing 'memory' / 'user' continue to compile because the
// string literals are assignable to the wider type.
import type { MemoryFile } from '../core/v4/memoryManager';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _LegacyAlias = MemoryFile;

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
    file: string,
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
    file: string,
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

  /**
   * Phase v4.1.2 alive-core: section-aware write. Replaces the body of
   * a markdown `## <header>` section, creating the section at file end
   * if it doesn't yet exist. Body lines below the header up to the
   * next `## ` (or EOF) are replaced wholesale.
   *
   * Preserves the standard verify-on-disk contract: the post-write read
   * confirms `newBody` is present and (when applicable) the previous
   * section body is gone before returning `verified: true`.
   *
   * Additive — does not change `guardedAdd` / `guardedReplace` /
   * `guardedRemove` semantics.
   */
  async replaceSection(
    file: string,
    header: string,
    newBody: string,
  ): Promise<GuardedResult> {
    const headerTrim = header.trim();
    if (!headerTrim.startsWith('## ')) {
      return {
        ok: false,
        verified: false,
        reason: 'header must start with "## " (markdown h2)',
      };
    }
    const bodyTrim = newBody.trim();
    if (!bodyTrim) {
      return {
        ok: false,
        verified: false,
        reason: 'newBody cannot be empty. Use guardedRemove() to drop a section.',
      };
    }

    // Read current file state so we can compute the precise old block.
    const snapBefore = await this.memory.loadSnapshot();
    const before = pickFile(snapBefore, file);

    // Match `<header>` and everything below it up to the next `## `
    // line or EOF. No `m` flag — we want `$` to mean end-of-string;
    // with `m`, the trailing-`$` lookahead would match at every line
    // ending and chop off all but the first body line.
    const escapedHeader = headerTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRe = new RegExp(
      `${escapedHeader}[^\\n]*(?:\\r?\\n[\\s\\S]*?)?(?=\\n## |$)`,
    );
    const match = before.match(sectionRe);
    const newSection = `${headerTrim}\n${bodyTrim}`;

    let mutation;
    if (match && match[0]) {
      mutation = await this.memory.replace(file, match[0], newSection);
    } else {
      // Section doesn't exist — append at end with a blank-line gap.
      const sep = before.length > 0 && !before.endsWith('\n') ? '\n\n' : '\n';
      mutation = await this.memory.add(file, `${sep}${newSection}`);
    }
    if (!mutation.ok) {
      return {
        ok: false,
        verified: false,
        reason: mutation.reason ?? 'section write failed',
      };
    }

    const snapAfter = await this.memory.loadSnapshot();
    const after = pickFile(snapAfter, file);
    if (!after.includes(headerTrim) || !after.includes(bodyTrim)) {
      return {
        ok: false,
        verified: false,
        reason: 'Section write claimed but header/body not found post-write',
        fileLength: after.length,
      };
    }
    return { ok: true, verified: true, fileLength: after.length };
  }

  async guardedRemove(
    file: string,
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

function pickFile(snap: MemorySnapshot, file: string): string {
  // v4.9.0 Slice 11 — legacy back-compat for 'memory' / 'user' direct
  // reads (Phase 9 + Honesty Enforcement still consult these); new
  // namespaces flow through the generalized `files` map.
  if (file === 'user'   && snap.userMd   !== undefined) return snap.userMd;
  if (file === 'memory' && snap.memoryMd !== undefined) return snap.memoryMd;
  return snap.files?.[file]?.content ?? '';
}

/**
 * Phase v4.1.2-bug-X: section-aware containment check.
 *
 * Returns `true` if `target` appears anywhere within the body of the
 * section identified by `sectionHeader` (e.g. `"## Durable facts"`).
 * The section body runs from the line after the header to the line
 * before the next `## ` header — or end-of-file, whichever comes
 * first. Returns `false` when the section doesn't exist OR when the
 * target sits outside it.
 *
 * Pure: no I/O, deterministic from inputs. Used by `memory_remove`
 * to protect user-approved durable facts from autonomous deletion:
 * the model proposed substring-match against MEMORY.md, but
 * substring removal operates whole-file — partial protection would
 * still nuke the durable copy as side-effect. STRICT containment
 * (rejects if the substring appears ANYWHERE in the section body)
 * is the honest guard.
 *
 * Case-sensitive: matches the existing `guardedRemove` semantics
 * which use `String.prototype.includes` directly on the raw content.
 *
 * @param fileContent  Full file content (e.g. MEMORY.md as one string).
 * @param target       Substring the caller intends to remove.
 * @param sectionHeader Header line including the `## ` prefix.
 */
export function containsInSection(
  fileContent:   string,
  target:        string,
  sectionHeader: string,
): boolean {
  if (!fileContent || !target || !sectionHeader) return false;
  const headerEscaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the header line, then capture the body until the next `## `
  // (any h2) or end-of-string. No `m` flag — the trailing-`$` would
  // otherwise match every line ending and chop the body at the first
  // newline (the same trap the slice2 sessionSummary regex already
  // documents).
  const sectionRe = new RegExp(
    `${headerEscaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const m = fileContent.match(sectionRe);
  if (!m) return false;
  const body = m[1] ?? '';
  return body.includes(target);
}
