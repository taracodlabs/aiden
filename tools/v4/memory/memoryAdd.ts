/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/memory/memoryAdd.ts — `memory_add` wrapper.
 *
 * Append an entry to MEMORY.md, USER.md, or PROJECT.md. Calls through
 * MemoryGuard so the result includes `verified: true` only after the
 * post-write read confirms the content landed on disk. Phase 12
 * HonestyEnforcement uses that flag to catch fabricated "I remembered X"
 * claims.
 *
 * v4.10 Slice 10.1 — `project` joins the file enum as a first-class
 * value. The plumbing (namespaceRegistry + MemoryManager.pathFor +
 * MemoryGuard's namespace-agnostic pickFile) was shipped in v4.9.0
 * Slice 11 Phase 2; this slice finishes the wiring by exposing
 * `project` to the model. PROJECT.md lives at
 * `<projectRoot>/.aiden/PROJECT.md` — when no project root is
 * detected, the call returns a synthetic failure (does NOT throw).
 *
 * Status: PHASE 9 + v4.10 Slice 10.1.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { truncatePreview } from '../../../core/v4/dryRun';
import { normalizeMemoryFile, fileLabel } from './namespaceNormalize';

export const memoryAddTool: ToolHandler = {
  schema: {
    name: 'memory_add',
    description:
      'Append a new entry to MEMORY.md (global notes), USER.md (preferences), or PROJECT.md (per-repo context). Returns verified=true only after the change is confirmed on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['memory', 'user', 'project'],
          description: 'Which file to append to. `project` writes to <projectRoot>/.aiden/PROJECT.md and only works when Aiden detects a project root.',
        },
        content: { type: 'string', description: 'New entry to add.' },
      },
      required: ['file', 'content'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'memory',
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    const file = normalizeMemoryFile(args.file);
    const content = String(args.content ?? '');
    return {
      tool: 'memory_add',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'memory_write', op: 'add', bullet: truncatePreview(content) }],
      detectedRisks: [],
      summary: `Would append to ${fileLabel(file)}: "${truncatePreview(content, 80)}"`,
    };
  },
  async execute(args, ctx) {
    if (!ctx.memoryGuard) {
      return { success: false, error: 'memory guard not configured' };
    }
    const file = normalizeMemoryFile(args.file);
    const content = String(args.content ?? '');
    try {
      const r = await ctx.memoryGuard.guardedAdd(file, content);
      return {
        success: r.ok,
        verified: r.verified,
        error: r.ok ? undefined : r.reason,
        file,
        fileLength: r.fileLength,
      };
    } catch (e) {
      // Synthetic failure for unresolvable namespaces (e.g. `project`
      // without a detected project root). MemoryManager.pathFor throws
      // via namespaceRegistry.resolve; we catch here so the model
      // receives a structured error rather than an exception.
      return {
        success: false,
        verified: false,
        error: (e as Error).message,
        file,
      };
    }
  },
};
