/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileMove.ts — `file_move` wrapper.
 *
 * Move/rename a file or directory. Creates parent dirs at the
 * destination if missing. Falls back to copy+delete if `fs.rename`
 * fails with EXDEV (cross-device move).
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { isProtectedPath } from '../utils/paths';
import { isPathAllowed, violationEnvelope } from '../../../core/v4/sandboxFs';

export const fileMoveTool: ToolHandler = {
  schema: {
    name: 'file_move',
    description:
      'Move or rename a file or directory. Creates parent dirs at the destination.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path.' },
        to: { type: 'string', description: 'Destination path.' },
      },
      required: ['from', 'to'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'files',
  riskTier: 'caution',   // v4.4 Phase 1
  // v4.4 Phase 4 — dry-run preview.
  async buildPreview(args, ctx) {
    const fromRaw = String(args.from ?? args.source ?? '').trim();
    const toRaw = String(args.to ?? args.dest ?? args.destination ?? '').trim();
    const src = isPathAllowed(fromRaw, 'write', ctx.cwd);
    const dst = isPathAllowed(toRaw, 'write', ctx.cwd);
    let srcExists = false;
    try { await fs.stat(src.resolvedPath); srcExists = true; } catch { /* missing */ }
    if (!src.allowed) {
      return {
        tool: 'file_move', args, riskTier: 'caution', detectedRisks: [],
        sideEffects: [{ type: 'refuse', reason: src.violation!.message }],
        summary: `Refused (source): ${src.violation!.code}`,
      };
    }
    if (!dst.allowed) {
      return {
        tool: 'file_move', args, riskTier: 'caution', detectedRisks: [],
        sideEffects: [{ type: 'refuse', reason: dst.violation!.message }],
        summary: `Refused (dest): ${dst.violation!.code}`,
      };
    }
    return {
      tool: 'file_move',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'move_path', from: src.resolvedPath, to: dst.resolvedPath, src_exists: srcExists }],
      detectedRisks: [],
      summary: `Would move ${src.resolvedPath} → ${dst.resolvedPath}${srcExists ? '' : ' (source missing)'}`,
    };
  },
  async execute(args, ctx) {
    const fromRaw = String(args.from ?? args.source ?? '').trim();
    const toRaw = String(args.to ?? args.dest ?? args.destination ?? '').trim();
    if (!fromRaw || !toRaw) {
      return { success: false, error: 'Both from and to required' };
    }
    if (isProtectedPath(fromRaw) || isProtectedPath(toRaw)) {
      return { success: false, error: 'Access denied: protected path' };
    }
    // v4.4 Phase 2 — sandbox preflight. Move = read source + write dest;
    // since the source is also being deleted, this could arguably be
    // 'delete' on source — but delete and write share the same allowlist
    // semantics in the policy. 'read' on source matches copy's shape.
    const srcPolicy = isPathAllowed(fromRaw, 'write', ctx.cwd);
    if (!srcPolicy.allowed) {
      return {
        success: false,
        error: srcPolicy.violation!.message,
        sandbox_violation: violationEnvelope(srcPolicy),
      };
    }
    const dstPolicy = isPathAllowed(toRaw, 'write', ctx.cwd);
    if (!dstPolicy.allowed) {
      return {
        success: false,
        error: dstPolicy.violation!.message,
        sandbox_violation: violationEnvelope(dstPolicy),
      };
    }
    const from = srcPolicy.resolvedPath;
    const to   = dstPolicy.resolvedPath;
    // v4.13 — batch-staleness guard. An approved plan may reference a
    // source an EARLIER operation already relocated/deleted (the plan
    // goes stale as it executes). An absent source is a benign SKIP —
    // a decision-record, not a failure, never a hallucination — and we
    // never auto-redirect to a guessed location; the model can re-list
    // if it cares.
    try {
      await fs.access(from);
    } catch {
      return {
        success: true,
        skipped: true,
        reason:  'source_absent',
        likely:  'already handled by an earlier operation',
        from,
        to,
      };
    }
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      try {
        await fs.rename(from, to);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EXDEV') {
          await fs.cp(from, to, { recursive: true });
          await fs.rm(from, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
      return { success: true, from, to };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, from, to };
    }
  },
};
