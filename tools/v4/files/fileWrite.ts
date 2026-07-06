/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileWrite.ts — `file_write` wrapper.
 *
 * Writes content to a file (creating parent dirs as needed).
 * Refuses to touch credential paths via `isProtectedPath`. Phase 9
 * adds the approval engine on top — for Phase 8, this is the only
 * gate.
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { isProtectedPath } from '../utils/paths';
import { isPathAllowed, violationEnvelope } from '../../../core/v4/sandboxFs';
import { truncatePreview } from '../../../core/v4/dryRun';
import { writeFileVerified } from '../../../core/v4/writeFileVerified';

export const fileWriteTool: ToolHandler = {
  schema: {
    name: 'file_write',
    description:
      'Write text content to a file. Creates parent directories. Overwrites if the file already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target file path.' },
        content: { type: 'string', description: 'Text content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'files',
  riskTier: 'caution',   // v4.4 Phase 1
  // v4.4 Phase 4 — dry-run preview.
  async buildPreview(args, ctx) {
    const raw = String(args.path ?? args.file ?? '').trim();
    const content = typeof args.content === 'string' ? args.content : '';
    const policy = isPathAllowed(raw, 'write', ctx.cwd);
    const resolved = policy.resolvedPath;
    let prevBytes: number | undefined;
    try { prevBytes = (await fs.stat(resolved)).size; } catch { /* didn't exist */ }
    const newBytes = Buffer.byteLength(content, 'utf-8');
    const sideEffects = policy.allowed
      ? [prevBytes !== undefined
          ? { type: 'overwrite_file' as const, path: resolved, prev_bytes: prevBytes, new_bytes: newBytes, preview: truncatePreview(content) }
          : { type: 'create_file' as const, path: resolved, bytes: newBytes, preview: truncatePreview(content) }]
      : [{ type: 'refuse' as const, reason: policy.violation!.message }];
    return {
      tool: 'file_write',
      args,
      riskTier: 'caution',
      sideEffects,
      detectedRisks: [],
      summary: policy.allowed
        ? `Would write ${newBytes} bytes to ${resolved}`
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
    const policy = isPathAllowed(raw, 'write', ctx.cwd);
    if (!policy.allowed) {
      return {
        success: false,
        error: policy.violation!.message,
        sandbox_violation: violationEnvelope(policy),
      };
    }
    const content = typeof args.content === 'string' ? args.content : '';
    const resolved = policy.resolvedPath;
    try {
      // Shared choke-point: atomic write + read-back verification. `bytes` is
      // the ACTUAL on-disk length (verified), not the intended-length guess a
      // bare fs.writeFile would let us claim. A verification failure throws and
      // is surfaced below as an honest error rather than a false success.
      const verified = await writeFileVerified(resolved, content);
      return {
        success: true,
        path: resolved,
        bytes: verified.bytes,
        verified: true,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, path: resolved };
    }
  },
};
