/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memoryManager.ts — Aiden v4.0.0
 *
 * Frozen-snapshot memory backed by two markdown files:
 *
 *   memories/MEMORY.md  → agent's environment notes (≤ 2200 chars)
 *   memories/USER.md    → user profile / preferences (≤ 1375 chars)
 *
 * Lifecycle ( tools/memory_tool.py::MemoryStore):
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
 * Anthropic / OpenAI prefix cache for every subsequent turn. The pattern
 * keeps the prompt stable while persisting writes immediately.
 *
 * Mutation semantics: substring matching ().
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
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from './paths';
import type { MemoryProvider, MemorySnapshot } from './memoryProvider';
// v4.9.0 Slice 11 — namespace registry generalizes 'memory'|'user' to N.
import { getNamespace, hasNamespace, listNamespaces } from './memory/namespaceRegistry';

/**
 * Legacy two-namespace alias kept for backward compatibility with the
 * 9 v4.0-v4.8 consumers (memoryGuard, aidenAgent listeners, tools,
 * tests). Slice 11 widened `MemoryManager` methods to accept any
 * registered namespace name (`string`), of which `MemoryFile` is the
 * built-in subset. New code should pass `string` directly.
 */
export type MemoryFile = 'memory' | 'user';

export interface MutationResult {
  ok: boolean;
  reason?: string;
  /**
   * Phase 21 #2: true when add() detected the content was already present
   * (substring duplicate). The disk wasn't touched but the user's intent —
   * "make sure X is recorded" — is satisfied, so callers (MemoryGuard,
   * /memory display) treat this as success rather than a verification
   * failure. onMutation does NOT fire when this is set.
   */
  deduped?: boolean;
}

/**
 * Char budgets per arch doc Memory section. NOT tokens — char counts are
 * model-independent and easy to enforce client-side.
 */
export const MEMORY_CHAR_LIMIT = 2200;
export const USER_CHAR_LIMIT = 1375;

/** Entry separator: `\n§\n`. Distinct enough to never collide with content. */
export const ENTRY_SEPARATOR = '\n§\n';

/**
 * Phase 16d: subscriber callback fired after each successful memory mutation
 * (add / replace / remove). Receives the file that changed so listeners can
 * decide whether they care (e.g. only invalidate slots 3+4 of the system
 * prompt, not the whole rebuild). Listeners must NOT throw; failures are
 * swallowed to keep mutation paths safe.
 */
export type MemoryMutationListener = (
  // v4.9.0 Slice 11 — widened from `MemoryFile` to `string`. Existing
  // listeners (aidenAgent, chatSession) match the wider type because
  // 'memory' / 'user' string literals are assignable to `string`.
  file: string,
  action: 'add' | 'replace' | 'remove',
) => void;

export interface MemoryManagerOptions {
  paths:        AidenPaths;
  /** v4.9.0 Slice 11 — required for `project` namespace; null otherwise. */
  projectRoot?: string | null;
}

export class MemoryManager implements MemoryProvider {
  readonly name = 'builtin';
  readonly projectRoot: string | null;
  private writeQueue: Promise<unknown> = Promise.resolve();
  /**
   * Phase 16d: registered subscribers fired after each successful mutation.
   * Used by AidenAgent to drop its cached system prompt so the next turn
   * sees the fresh MEMORY.md / USER.md content. Failed mutations do NOT
   * fire listeners — preserves the "stale snapshot stays clean" invariant.
   */
  private readonly mutationListeners = new Set<MemoryMutationListener>();

  // v4.9.0 Slice 11 — constructor now accepts either the legacy
  // `AidenPaths` (back-compat) OR an options object with optional
  // `projectRoot`. Both shapes preserve `this.paths` for the rest of
  // the class.
  constructor(opts: AidenPaths | MemoryManagerOptions) {
    if ((opts as MemoryManagerOptions).paths !== undefined) {
      const o = opts as MemoryManagerOptions;
      this.paths = o.paths;
      this.projectRoot = o.projectRoot ?? null;
    } else {
      this.paths = opts as AidenPaths;
      this.projectRoot = null;
    }
  }
  // eslint-disable-next-line @typescript-eslint/explicit-member-accessibility
  private readonly paths: AidenPaths;

  /**
   * Phase 16d: subscribe to successful memory mutations. Returns an
   * unsubscribe function so callers can detach on shutdown / hot-reload.
   * Multiple subscriptions of the same listener are deduped via Set.
   */
  onMutation(listener: MemoryMutationListener): () => void {
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  /** Phase 16d: internal — fire listeners. Errors are swallowed. */
  private fireMutation(file: string, action: 'add' | 'replace' | 'remove'): void {
    for (const listener of this.mutationListeners) {
      try {
        listener(file, action);
      } catch {
        // Listeners must not break the mutation path.
      }
    }
  }

  /**
   * Load both files from disk. Returns raw text (not parsed entries) so
   * the system-prompt assembler can splice it into a code block verbatim.
   * Empty/missing files return empty strings — `isEmpty` is true only when
   * BOTH files are absent or whitespace-only.
   */
  async loadSnapshot(): Promise<MemorySnapshot> {
    const memoryMd = await readFileOrEmpty(this.paths.memoryMd);
    const userMd = await readFileOrEmpty(this.paths.userMd);
    // v4.9.0 Slice 11 — collect every registered namespace's content
    // into the generalized `files` map. Legacy `memoryMd` / `userMd`
    // fields stay populated for back-compat with the 9 v4 consumers
    // that read them directly (memoryGuard, aidenAgent listeners, ...).
    const files: Record<string, { content: string; charCount: number; charLimit: number; path: string }> = {};
    let anyContent = memoryMd.trim().length > 0 || userMd.trim().length > 0;
    for (const ns of listNamespaces()) {
      let p: string;
      try { p = ns.resolve(this.paths, this.projectRoot); }
      catch { continue;  /* requiresProject + no root — silently skip */ }
      const content = await readFileOrEmpty(p);
      files[ns.name] = {
        content, charCount: content.length, charLimit: ns.charLimit, path: p,
      };
      if (content.trim().length > 0) anyContent = true;
    }
    return { memoryMd, userMd, loadedAt: Date.now(), isEmpty: !anyContent, files };
  }

  add(file: string, content: string): Promise<MutationResult> {
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
      // skip the disk write but treat as success — the post-write state
      // (content present in file) matches the caller's intent. Phase 21
      // #2: this used to return ok=false, which surfaced as a spurious
      // "attempted but not verified" warning when the model re-issued
      // the same memory_add inside one turn.
      const isDuplicate = entries.some(
        (e) => e === trimmed || e.includes(trimmed),
      );
      if (isDuplicate) {
        return { ok: true, deduped: true };
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
      this.fireMutation(file, 'add');
      return { ok: true };
    });
  }

  replace(
    file: string,
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
      this.fireMutation(file, 'replace');
      return { ok: true };
    });
  }

  remove(file: string, text: string): Promise<MutationResult> {
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
      this.fireMutation(file, 'remove');
      return { ok: true };
    });
  }

  // ── Internals ────────────────────────────────────────────────────────

  // v4.9.0 Slice 11 — resolve via namespace registry. Legacy callers
  // passing 'memory' / 'user' hit the built-in resolvers; new namespaces
  // (project, future plugin namespaces) flow through the same path.
  private pathFor(file: string): string {
    if (!hasNamespace(file)) {
      throw new Error(`unknown memory namespace '${file}'`);
    }
    return getNamespace(file).resolve(this.paths, this.projectRoot);
  }

  /**
   * v4.9.0 Slice 11 — public char-limit lookup for any namespace.
   * Replaces the legacy file-local `limitFor` switch with a registry hit.
   */
  charLimitFor(namespace: string): number {
    return getNamespace(namespace).charLimit;
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

// v4.9.0 Slice 11 — registry-aware. Legacy two-namespace callers
// (memoryGuard, tools) hit this via the existing add/replace/remove
// paths; the constants above stay exported for any consumer still
// importing them directly.
function limitFor(file: string): number {
  return getNamespace(file).charLimit;
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
