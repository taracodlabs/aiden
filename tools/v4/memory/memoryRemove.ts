/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/memory/memoryRemove.ts — `memory_remove` wrapper.
 *
 * Delete an entry from MEMORY.md, USER.md, or PROJECT.md by substring
 * match. Returns `verified: true` only after the post-write read
 * confirms the text is gone from the file.
 *
 * Phase v4.1.2-bug-X: user-approved durable facts (anything in
 * MEMORY.md `## Durable facts`) are protected from autonomous
 * deletion. A subsequent session on a weak model (llama-3.3 in the
 * smoke test) called memory_remove on a Phase-D-promoted fact with
 * reasoning "outdated" — violating Phase D's opt-in trust contract.
 *
 * The guard is STRICT: if the requested substring appears ANYWHERE
 * in the `## Durable facts` body, the call is rejected. Substring
 * removal operates whole-file, so partial protection would still
 * nuke the durable copy as side-effect. Hard rejection (vs propose-
 * and-defer) is honest: model must surface to user; only the user
 * (editing MEMORY.md directly, or via a future `/forget` slash
 * command) can revoke durable content.
 *
 * v4.10 Slice 10.1 — `project` joins the file enum. Durable-facts
 * protection REMAINS scoped to global `'memory'` only — PROJECT.md
 * is iteration-friendly by design; if project-scoped durable facts
 * become a real need later, a separate design slice will widen the
 * protection.
 *
 * Status: PHASE 9 (PHASE v4.1.2-bug-X: section protection) + v4.10 Slice 10.1.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { containsInSection } from '../../../moat/memoryGuard';
import { truncatePreview } from '../../../core/v4/dryRun';
import { normalizeMemoryFile, fileLabel } from './namespaceNormalize';

/** Section in MEMORY.md that Phase D promotion writes to. */
const DURABLE_FACTS_HEADER = '## Durable facts';

export const memoryRemoveTool: ToolHandler = {
  schema: {
    name: 'memory_remove',
    description:
      'Remove an entry from MEMORY.md, USER.md, or PROJECT.md by substring match. ' +
      'CANNOT remove entries in MEMORY.md `## Durable facts` — those are ' +
      'user-approved facts the user explicitly promoted; only the user ' +
      'can revoke them by editing MEMORY.md directly. If you think a ' +
      'durable fact is outdated, surface that to the user and ask them ' +
      'to confirm; do not propose autonomous removal. (PROJECT.md is ' +
      'iteration-friendly and has no durable-facts protection.) Returns ' +
      'verified=true only after the change is confirmed on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['memory', 'user', 'project'],
          description: 'Which file to modify. `project` writes to <projectRoot>/.aiden/PROJECT.md and only works when Aiden detects a project root.',
        },
        text: { type: 'string', description: 'Substring of the entry to remove.' },
      },
      required: ['file', 'text'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'memory',
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    const file = normalizeMemoryFile(args.file);
    const text = String(args.text ?? '');
    return {
      tool: 'memory_remove',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'memory_write', op: 'remove', pattern: truncatePreview(text, 80) }],
      detectedRisks: [],
      summary: `Would remove from ${fileLabel(file)}: "${truncatePreview(text, 80)}"`,
    };
  },
  async execute(args, ctx) {
    if (!ctx.memoryGuard) {
      return { success: false, error: 'memory guard not configured' };
    }
    const file = normalizeMemoryFile(args.file);
    const text = String(args.text ?? '');

    // Phase v4.1.2-bug-X: durable-section protection. Only applies
    // to MEMORY.md (USER.md has no section structure; PROJECT.md is
    // intentionally iteration-friendly per v4.10 Slice 10.1 design).
    // The check requires snapshot access — when ctx.memory is not
    // wired (test contexts, future surface refactors), we fall
    // through to the existing guardedRemove behavior. Real CLI
    // sessions wire memoryManager, so production paths get the
    // guard. Documented intentional fall-through.
    if (file === 'memory' && ctx.memory) {
      try {
        const snap = await ctx.memory.loadSnapshot();
        const memoryMd = snap?.memoryMd ?? '';
        if (memoryMd && containsInSection(memoryMd, text, DURABLE_FACTS_HEADER)) {
          const preview = text.length > 60
            ? `${text.slice(0, 60)}…`
            : text;
          return {
            success: false,
            verified: false,
            error:
              `Cannot remove "${preview}" — it's in MEMORY.md ` +
              `\`${DURABLE_FACTS_HEADER}\`, which holds user-approved facts. ` +
              `Only the user can revoke these. Ask them to confirm removal ` +
              `in their next message; do not propose autonomous deletion.`,
            file,
            protectedSection: DURABLE_FACTS_HEADER,
          };
        }
      } catch {
        // Snapshot read failed — fall through to old behavior rather
        // than block legitimate removals on transient I/O errors.
      }
    }

    try {
      const r = await ctx.memoryGuard.guardedRemove(file, text);
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
