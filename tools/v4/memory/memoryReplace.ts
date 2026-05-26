/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/memory/memoryReplace.ts — `memory_replace` wrapper.
 *
 * Substring-matched replace across MEMORY.md, USER.md, or PROJECT.md.
 * Returns `verified: true` only after the post-write read confirms
 * the new text is present and the old text is absent.
 *
 * v4.10 Slice 10.1 — `project` joins the file enum. See memoryAdd.ts
 * header for the rationale + non-throw guarantee on unresolvable
 * project root.
 *
 * Status: PHASE 9 + v4.10 Slice 10.1.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { truncatePreview } from '../../../core/v4/dryRun';
import { normalizeMemoryFile, fileLabel } from './namespaceNormalize';

export const memoryReplaceTool: ToolHandler = {
  schema: {
    name: 'memory_replace',
    description:
      'Replace one entry in MEMORY.md, USER.md, or PROJECT.md with new text. Substring match — fails if old_text is ambiguous. Returns verified=true only after the change is confirmed on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['memory', 'user', 'project'],
          description: 'Which file to modify. `project` writes to <projectRoot>/.aiden/PROJECT.md and only works when Aiden detects a project root.',
        },
        old_text: { type: 'string', description: 'Substring of the entry to replace.' },
        new_text: { type: 'string', description: 'Replacement entry.' },
      },
      required: ['file', 'old_text', 'new_text'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'memory',
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    const file = normalizeMemoryFile(args.file);
    const oldText = String(args.old_text ?? args.oldText ?? '');
    const newText = String(args.new_text ?? args.newText ?? '');
    return {
      tool: 'memory_replace',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'memory_write', op: 'replace', pattern: truncatePreview(oldText, 80), bullet: truncatePreview(newText, 80) }],
      detectedRisks: [],
      summary: `Would replace in ${fileLabel(file)}: "${truncatePreview(oldText, 40)}" → "${truncatePreview(newText, 40)}"`,
    };
  },
  async execute(args, ctx) {
    if (!ctx.memoryGuard) {
      return { success: false, error: 'memory guard not configured' };
    }
    const file = normalizeMemoryFile(args.file);
    const oldText = String(args.old_text ?? args.oldText ?? '');
    const newText = String(args.new_text ?? args.newText ?? '');
    try {
      const r = await ctx.memoryGuard.guardedReplace(file, oldText, newText);
      return {
        success: r.ok,
        verified: r.verified,
        error: r.ok ? undefined : r.reason,
        file,
        fileLength: r.fileLength,
      };
    } catch (e) {
      // Synthetic failure for unresolvable namespaces — see memoryAdd
      // for the design rationale (project without projectRoot).
      return {
        success: false,
        verified: false,
        error: (e as Error).message,
        file,
      };
    }
  },
};
