/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/filePatch.ts — `file_patch` wrapper.
 *
 * String-replacement patch. Reads the file, replaces the literal
 * `find` string with `replace`, writes back. Fails cleanly when
 * `find` does not appear in the file. v3 has no equivalent — this
 * is a v4-native string-replace editor.
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { isProtectedPath } from '../utils/paths';
import { isPathAllowed, violationEnvelope } from '../../../core/v4/sandboxFs';
import { writeFileVerified } from '../../../core/v4/writeFileVerified';

export const filePatchTool: ToolHandler = {
  schema: {
    name: 'file_patch',
    description:
      "Replace a literal string in a file. Fails if `find` does not appear. Use `replace_all=true` to replace every occurrence; otherwise the find string must be unique.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to patch.' },
        find: { type: 'string', description: 'Literal string to find.' },
        replace: { type: 'string', description: 'Replacement text.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence (default false — must be unique).',
        },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'files',
  riskTier: 'caution',   // v4.4 Phase 1
  // v4.4 Phase 4 — dry-run preview.
  async buildPreview(args, ctx) {
    const raw = String(args.path ?? args.file ?? '').trim();
    const find = typeof args.find === 'string' ? args.find : '';
    const replace = typeof args.replace === 'string' ? args.replace : '';
    const policy = isPathAllowed(raw, 'write', ctx.cwd);
    const resolved = policy.resolvedPath;
    let matches = 0;
    let bytesDelta = 0;
    if (policy.allowed && find) {
      try {
        const txt = await fs.readFile(resolved, 'utf-8');
        matches = txt.split(find).length - 1;
        bytesDelta = matches * (Buffer.byteLength(replace, 'utf-8') - Buffer.byteLength(find, 'utf-8'));
      } catch { /* file may not exist — surfaced as 0 matches */ }
    }
    const sideEffects = policy.allowed
      ? [{ type: 'patch_file' as const, path: resolved, matches, bytes_delta: bytesDelta }]
      : [{ type: 'refuse' as const, reason: policy.violation!.message }];
    return {
      tool: 'file_patch',
      args,
      riskTier: 'caution',
      sideEffects,
      detectedRisks: [],
      summary: policy.allowed
        ? `Would patch ${resolved} (${matches} match${matches === 1 ? '' : 'es'}, Δ ${bytesDelta} bytes)`
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
    const find = typeof args.find === 'string' ? args.find : '';
    const replace = typeof args.replace === 'string' ? args.replace : '';
    if (!find) return { success: false, error: 'Empty find string' };
    const replaceAll = args.replace_all === true;
    const resolved = policy.resolvedPath;

    // v4.13 — batch-staleness guard. Patching a file an earlier batch
    // operation already moved/deleted is a benign SKIP, not a failure.
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
      const original = await fs.readFile(resolved, 'utf-8');
      const occurrences = original.split(find).length - 1;
      if (occurrences === 0) {
        return {
          success: false,
          error: `find string not found in ${resolved}`,
          path: resolved,
        };
      }
      if (occurrences > 1 && !replaceAll) {
        return {
          success: false,
          error: `find string is not unique (${occurrences} occurrences); set replace_all=true to replace every match`,
          path: resolved,
        };
      }
      const next = replaceAll
        ? original.split(find).join(replace)
        : original.replace(find, replace);
      // Shared choke-point: atomic write + read-back verification. `bytes` is
      // the verified on-disk length; a verification failure throws and is
      // surfaced below as an error, never a false success.
      const verified = await writeFileVerified(resolved, next);
      return {
        success: true,
        path: resolved,
        replacements: replaceAll ? occurrences : 1,
        bytes: verified.bytes,
        verified: true,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, path: resolved };
    }
  },
};
