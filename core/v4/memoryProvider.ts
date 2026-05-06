/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memoryProvider.ts — Aiden v4.0.0
 *
 * Pluggable memory provider interface. v4.0.0 ships only the built-in
 * file-backed `MemoryManager`. v4.1.0 will ship at least Honcho + Mem0
 * adapters that implement this same surface, swappable via the
 * `memory.provider` key in config.yaml.
 *
 * Status: PHASE 6 — interface + shared types only. Plugins land in v4.1.
 *
 * Hermes reference: agent/memory_provider.py::MemoryProvider (full ABC
 * with prefetch/sync_turn/tool_schemas hooks). v4.0.0 trims to the
 * minimal CRUD surface — prefetch and tool schemas are reintroduced when
 * we wire the first external plugin.
 */

import type { MemoryFile, MutationResult } from './memoryManager';

/**
 * Snapshot of the two memory files at session start. Frozen in the
 * sense that the system prompt assembled from this object is not mutated
 * mid-session even when add/replace/remove are called — preserves the
 * Anthropic / OpenAI prefix cache across turns.
 */
export interface MemorySnapshot {
  /** Raw MEMORY.md content (~800 tokens budget). */
  memoryMd: string;
  /** Raw USER.md content (~500 tokens budget). */
  userMd: string;
  /** Unix-epoch ms — useful for cache-bust comparisons. */
  loadedAt: number;
  /** True when both files were missing or whitespace-only at load time. */
  isEmpty: boolean;
}

/**
 * Implemented by the built-in `MemoryManager` and (in v4.1+) by external
 * plugins like Honcho, Mem0, Hindsight, RetainDB, etc.
 */
export interface MemoryProvider {
  /** Short identifier — used in logs and the `memory.provider` config key. */
  readonly name: string;

  /** Load both files. Called once at session start. */
  loadSnapshot(): Promise<MemorySnapshot>;

  /** Append a new entry. Rejected (returns `ok:false`) on duplicate or capacity overflow. */
  add(file: MemoryFile, content: string): Promise<MutationResult>;

  /** Substring-matched replace. `ok:false` on zero or ambiguous matches. */
  replace(
    file: MemoryFile,
    oldText: string,
    newText: string,
  ): Promise<MutationResult>;

  /** Substring-matched remove. `ok:false` on zero or ambiguous matches. */
  remove(file: MemoryFile, text: string): Promise<MutationResult>;
}
