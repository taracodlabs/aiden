/**
 * core/v4/memoryManager.ts — Aiden v4.0.0
 *
 * Frozen-snapshot memory backed by two markdown files:
 *
 *   memories/MEMORY.md  → agent's environment notes (≤ 2200 chars)
 *   memories/USER.md    → user profile / preferences (≤ 1375 chars)
 *
 * Lifecycle (mirrors Hermes tools/memory_tool.py::MemoryStore):
 *
 *   const snap = await mgr.loadSnapshot();   // raw text injected once at
 *                                            // session start, then frozen.
 *   await mgr.add('memory', 'new note');     // disk write — does NOT
 *                                            // affect the system prompt
 *                                            // until the NEXT session.
 *   await mgr.replace('memory', old, new);
 *   await mgr.remove('memory', text);
 *
 * Why frozen: changing the system prompt mid-session invalidates the
 * Anthropic / OpenAI prefix cache for every subsequent turn. Hermes's
 * pattern keeps the prompt stable while persisting writes immediately.
 *
 * Mutation semantics: substring matching (Hermes pattern).
 *   - `add` rejects if the new content already appears in the file
 *     (substring duplicate detection — friendly to common phrasing tweaks).
 *   - `replace`/`remove` find the unique entry containing `oldText` as a
 *     substring. Zero matches → error. Multiple distinct matches → error.
 *     Multiple identical-content matches collapse and operate on the first.
 *   - Capacity is validated BEFORE writing: a doomed replace never half-
 *     applies.
 *
 * Concurrency: writes are serialised in-process via a single async lock.
 * Cross-process safety relies on `fs.promises.rename` being atomic on the
 * target filesystem (true for NTFS, ext4, APFS — adequate for v4.0.0).
 *
 * Status: PHASE 6.
 *
 * Hermes reference: tools/memory_tool.py::MemoryStore.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from './paths';
import type { MemoryProvider, MemorySnapshot } from './memoryProvider';

export type MemoryFile = 'memory' | 'user';

export interface MutationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Char budgets per arch doc Memory section. NOT tokens — char counts are
 * model-independent and easy to enforce client-side.
 */
export const MEMORY_CHAR_LIMIT = 2200;
export const USER_CHAR_LIMIT = 1375;

/** Hermes uses `\n§\n` between entries; we keep the convention. */
export const ENTRY_SEPARATOR = '\n§\n';

export class MemoryManager implements MemoryProvider {
  readonly name = 'builtin';
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly paths: AidenPaths) {}

  /**
   * Load both files from disk. Returns raw text (not parsed entries) so
   * the system-prompt assembler can splice it into a code block verbatim.
   * Empty/missing files return empty strings — `isEmpty` is true only when
   * BOTH files are absent or whitespace-only.
   */
  async loadSnapshot(): Promise<MemorySnapshot> {
    const memoryMd = await readFileOrEmpty(this.paths.memoryMd);
    const userMd = await readFileOrEmpty(this.paths.userMd);
    return {
      memoryMd,
      userMd,
      loadedAt: Date.now(),
      isEmpty: memoryMd.trim().length === 0 && userMd.trim().length === 0,
    };
  }

  add(file: MemoryFile, content: string): Promise<MutationResult> {
    return this.serialised(async () => {
      const trimmed = content.trim();
      if (!trimmed) {
        return { ok: false, reason: 'Content cannot be empty.' };
      }
      const targetPath = this.pathFor(file);
      const limit = limitFor(file);
      const entries = await readEntries(targetPath);

      // Substring-duplicate detection: if the new note is already a
      // sub-string of any existing entry (or vice-versa for trivial cases),
      // reject as duplicate.
      const isDuplicate = entries.some(
        (e) => e === trimmed || e.includes(trimmed),
      );
      if (isDuplicate) {
        return {
          ok: false,
          reason: 'Duplicate: content already present in this file.',
        };
      }

      const next = [...entries, trimmed];
      const projected = next.join(ENTRY_SEPARATOR);
      if (projected.length > limit) {
        return {
          ok: false,
          reason: `Capacity exceeded: ${projected.length}/${limit} chars. Replace or remove existing entries first.`,
        };
      }

      await atomicWrite(targetPath, projected);
      return { ok: true };
    });
  }

  replace(
    file: MemoryFile,
    oldText: string,
    newText: string,
  ): Promise<MutationResult> {
    return this.serialised(async () => {
      const oldTrim = oldText.trim();
      const newTrim = newText.trim();
      if (!oldTrim) {
        return { ok: false, reason: 'oldText cannot be empty.' };
      }
      if (!newTrim) {
        return {
          ok: false,
          reason: 'newText cannot be empty. Use remove() to delete entries.',
        };
      }
      const targetPath = this.pathFor(file);
      const limit = limitFor(file);
      const entries = await readEntries(targetPath);

      const matchIndices: number[] = [];
      for (let i = 0; i < entries.length; i += 1) {
        if (entries[i].includes(oldTrim)) matchIndices.push(i);
      }

      if (matchIndices.length === 0) {
        return { ok: false, reason: `Text not found: '${oldTrim}'.` };
      }
      if (matchIndices.length > 1) {
        const distinct = new Set(matchIndices.map((i) => entries[i]));
        if (distinct.size > 1) {
          return {
            ok: false,
            reason: `Text matches ${matchIndices.length} entries. Be more specific.`,
          };
        }
        // All identical — fine to operate on the first.
      }

      const idx = matchIndices[0];
      const projectedEntries = [...entries];
      projectedEntries[idx] = newTrim;
      const projected = projectedEntries.join(ENTRY_SEPARATOR);
      if (projected.length > limit) {
        return {
          ok: false,
          reason: `Capacity exceeded: replacement would put file at ${projected.length}/${limit} chars.`,
        };
      }

      await atomicWrite(targetPath, projected);
      return { ok: true };
    });
  }

  remove(file: MemoryFile, text: string): Promise<MutationResult> {
    return this.serialised(async () => {
      const trimmed = text.trim();
      if (!trimmed) {
        return { ok: false, reason: 'text cannot be empty.' };
      }
      const targetPath = this.pathFor(file);
      const entries = await readEntries(targetPath);

      const matchIndices: number[] = [];
      for (let i = 0; i < entries.length; i += 1) {
        if (entries[i].includes(trimmed)) matchIndices.push(i);
      }

      if (matchIndices.length === 0) {
        return { ok: false, reason: `Text not found: '${trimmed}'.` };
      }
      if (matchIndices.length > 1) {
        const distinct = new Set(matchIndices.map((i) => entries[i]));
        if (distinct.size > 1) {
          return {
            ok: false,
            reason: `Text matches ${matchIndices.length} entries. Be more specific.`,
          };
        }
      }

      const idx = matchIndices[0];
      const projectedEntries = entries.filter((_, i) => i !== idx);
      await atomicWrite(targetPath, projectedEntries.join(ENTRY_SEPARATOR));
      return { ok: true };
    });
  }

  // ── Internals ────────────────────────────────────────────────────────

  private pathFor(file: MemoryFile): string {
    return file === 'user' ? this.paths.userMd : this.paths.memoryMd;
  }

  /**
   * Serialise mutations so two concurrent add()s can't collapse into a
   * single read-modify-write race. Errors don't poison the queue.
   */
  private serialised<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function limitFor(file: MemoryFile): number {
  return file === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

async function readFileOrEmpty(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return '';
    }
    throw err;
  }
}

async function readEntries(p: string): Promise<string[]> {
  const raw = await readFileOrEmpty(p);
  if (!raw.trim()) return [];
  return raw
    .split(ENTRY_SEPARATOR)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/**
 * Write to a temp sibling and rename — gives us atomic replacement on
 * NTFS / ext4 / APFS. Failure paths leave the temp file behind (cleaned
 * up best-effort) without corrupting the original.
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore — rename may have already moved the temp away on success
    }
    throw err;
  }
}
