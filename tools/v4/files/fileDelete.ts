/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileDelete.ts — `file_delete` wrapper.
 *
 * Deletes a file or (with `recursive=true`) a directory tree.
 * Refuses filesystem roots and protected paths. Phase 9's approval
 * engine wraps every call so the user OKs deletions before they
 * happen — for Phase 8 the deny-list is the only safeguard.
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { isProtectedPath, isFilesystemRoot } from '../utils/paths';
import { isPathAllowed, violationEnvelope } from '../../../core/v4/sandboxFs';

export const fileDeleteTool: ToolHandler = {
  schema: {
    name: 'file_delete',
    description:
      'Delete a file. Pass recursive=true to delete a directory tree. Refuses filesystem roots and credential paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target path.' },
        recursive: {
          type: 'boolean',
          description: 'Delete a directory tree (default false).',
        },
      },
      required: ['path'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'files',
  riskTier: 'dangerous',   // v4.4 Phase 1 — irreversible filesystem mutation
  // v4.4 Phase 4 — dry-run preview.
  async buildPreview(args, ctx) {
    const raw = String(args.path ?? args.file ?? '').trim();
    const recursive = args.recursive === true;
    const policy = isPathAllowed(raw, 'delete', ctx.cwd);
    const resolved = policy.resolvedPath;
    let exists = false;
    try { await fs.stat(resolved); exists = true; } catch { /* missing */ }
    const sideEffects = policy.allowed
      ? [{ type: 'delete_file' as const, path: resolved, exists, recursive }]
      : [{ type: 'refuse' as const, reason: policy.violation!.message }];
    return {
      tool: 'file_delete',
      args,
      riskTier: 'dangerous',
      sideEffects,
      detectedRisks: policy.allowed && recursive ? ['recursive_delete'] : [],
      summary: policy.allowed
        ? `Would ${recursive ? 'recursively ' : ''}delete ${resolved}${exists ? '' : ' (does not exist)'}`
        : `Refused: ${policy.violation!.code}`,
    };
  },
  async execute(args, ctx) {
    const raw = String(args.path ?? args.file ?? '').trim();
    if (!raw) return { success: false, error: 'No path provided' };
    if (isProtectedPath(raw)) {
      return { success: false, error: 'Access denied: protected path' };
    }
    // v4.4 Phase 2 — sandbox preflight (no-op when AIDEN_SANDBOX!=1).
    const policy = isPathAllowed(raw, 'delete', ctx.cwd);
    if (!policy.allowed) {
      return {
        success: false,
        error: policy.violation!.message,
        sandbox_violation: violationEnvelope(policy),
      };
    }
    const resolved = policy.resolvedPath;
    if (isFilesystemRoot(resolved)) {
      return { success: false, error: 'Refusing to delete filesystem root' };
    }
    const recursive = args.recursive === true;
    // v4.13 — batch-staleness guard. An approved plan may reference a
    // path an EARLIER operation already moved/deleted. An absent target
    // for a delete is a benign SKIP (the end state — "gone" — already
    // holds); a decision-record, not a failure.
    try {
      await fs.access(resolved);
    } catch {
      return {
        success: true,
        skipped: true,
        reason:  'source_absent',
        likely:  'already handled by an earlier operation',
        path:    resolved,
      };
    }
    try {
      await fs.rm(resolved, { recursive, force: false });
      return { success: true, path: resolved };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, path: resolved };
    }
  },
};
