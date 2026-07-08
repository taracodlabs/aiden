/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileCopy.ts — `file_copy` wrapper.
 *
 * Copy a file or directory tree. Creates parent dirs at the
 * destination if missing.
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { isProtectedPath, protectedPathMessage } from '../utils/paths';
import { isPathAllowed, violationEnvelope } from '../../../core/v4/sandboxFs';

export const fileCopyTool: ToolHandler = {
  schema: {
    name: 'file_copy',
    description:
      'Copy a file or directory tree to a new location. Creates parent dirs at the destination.',
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
    const src = isPathAllowed(fromRaw, 'read', ctx.cwd);
    const dst = isPathAllowed(toRaw, 'write', ctx.cwd);
    let srcExists = false;
    try { await fs.stat(src.resolvedPath); srcExists = true; } catch { /* missing */ }
    if (!src.allowed) {
      return {
        tool: 'file_copy', args, riskTier: 'caution', detectedRisks: [],
        sideEffects: [{ type: 'refuse', reason: src.violation!.message }],
        summary: `Refused (source): ${src.violation!.code}`,
      };
    }
    if (!dst.allowed) {
      return {
        tool: 'file_copy', args, riskTier: 'caution', detectedRisks: [],
        sideEffects: [{ type: 'refuse', reason: dst.violation!.message }],
        summary: `Refused (dest): ${dst.violation!.code}`,
      };
    }
    return {
      tool: 'file_copy',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'copy_path', from: src.resolvedPath, to: dst.resolvedPath, src_exists: srcExists }],
      detectedRisks: [],
      summary: `Would copy ${src.resolvedPath} → ${dst.resolvedPath}${srcExists ? '' : ' (source missing)'}`,
    };
  },
  async execute(args, ctx) {
    const fromRaw = String(args.from ?? args.source ?? '').trim();
    const toRaw = String(args.to ?? args.dest ?? args.destination ?? '').trim();
    if (!fromRaw || !toRaw) {
      return { success: false, error: 'Both from and to required' };
    }
    if (isProtectedPath(fromRaw) || isProtectedPath(toRaw)) {
      return { success: false, error: protectedPathMessage(isProtectedPath(fromRaw) ? fromRaw : toRaw) };
    }
    // v4.4 Phase 2 — sandbox preflight (source = read, dest = write).
    const srcPolicy = isPathAllowed(fromRaw, 'read', ctx.cwd);
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
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.cp(from, to, { recursive: true });
      return { success: true, from, to };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, from, to };
    }
  },
};
