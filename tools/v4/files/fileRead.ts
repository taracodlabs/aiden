/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileRead.ts — `file_read` wrapper.
 *
 * Reads up to 5000 chars from a file. Resolves `~` and `Desktop/`
 * shorthand against the OS home dir. Path-deny rules (.ssh, .aws,
 * credentials, *.pem, *.key, id_rsa*) are enforced inline — the
 * approval engine layers a structured permission check on mutating
 * tools; these inline read guards stay as the enforced minimum.
 *
 * Status: PHASE 7. Read-only.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { isPathAllowed, violationEnvelope } from '../../../core/v4/sandboxFs';
import { fileReadHandle } from '../../../core/v4/toolOutputCap';
import { protectedPathMessage } from '../utils/paths';

const MAX_OUTPUT = 5000;

// v4.12 TOC.1 — repeated-identical-read stub. Maps a read (path|offset|limit) to
// the content hash last returned; a second identical read returns a lightweight
// stub instead of re-sending the same bytes. Keyed by hash so a changed file
// (different hash) re-sends. Module-scoped = per session/process.
const _lastReads = new Map<string, string>();
/** Test seam — reset the repeated-read cache. */
export function __resetFileReadCache(): void { _lastReads.clear(); }

const DENY_PATTERNS: RegExp[] = [
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.aws[\\/]/i,
  /[\\/]\.gnupg[\\/]/i,
  /[\\/]\.env(\.|$|\\|\/)/i,
  /credentials/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa\b/i,
  /id_ed25519\b/i,
];

function isDenied(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return DENY_PATTERNS.some((re) => re.test(norm));
}

function expandPath(input: string, cwd: string): string {
  const home = os.homedir();
  let p = input;
  if (/^~[\\/]/i.test(p)) p = home + p.slice(1);
  else if (/^Desktop[\\/]?$/i.test(p)) p = path.join(home, 'Desktop');
  else if (/^Desktop[\\/]/i.test(p)) p = path.join(home, 'Desktop', p.slice(8));
  if (path.isAbsolute(p)) return p;
  if (/^[A-Z]:/i.test(p)) return p;
  return path.join(cwd, p);
}

export const fileReadTool: ToolHandler = {
  schema: {
    name: 'file_read',
    description:
      'Read the contents of a file. Returns up to 5000 characters per page. Supports `~`, `Desktop/`, and `C:\\` paths; relative paths are resolved against the agent\'s working directory. For large files, page with `offset`/`limit` (a truncated result carries the next offset in full_output_ref).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path. Absolute or relative to cwd.',
        },
        offset: {
          type: 'number',
          description: 'Character offset to start reading from (default 0). Use full_output_ref.offset from a truncated result to page onward.',
        },
        limit: {
          type: 'number',
          description: `Max characters to return this page (default ${MAX_OUTPUT}).`,
        },
      },
      required: ['path'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'files',
  riskTier: 'safe',   // v4.4 Phase 1
  async execute(args, ctx) {
    const raw = String(args.path ?? args.file ?? '').trim();
    if (!raw) return { success: false, error: 'No path provided' };
    if (isDenied(raw)) {
      return {
        success: false,
        error: protectedPathMessage(raw),
      };
    }
    // v4.4 Phase 2 — sandbox preflight (no-op when AIDEN_SANDBOX!=1).
    const policy = isPathAllowed(raw, 'read', ctx.cwd);
    if (!policy.allowed) {
      return {
        success: false,
        error: policy.violation!.message,
        sandbox_violation: violationEnvelope(policy),
      };
    }
    const resolved = policy.resolvedPath;
    // v4.12 TOC.1 — pagination: offset/limit page a large file (default page = MAX_OUTPUT).
    const offset = Math.max(0, typeof args.offset === 'number' ? Math.floor(args.offset) : 0);
    const limit = Math.max(1, typeof args.limit === 'number' ? Math.floor(args.limit) : MAX_OUTPUT);
    try {
      const content = await fs.readFile(resolved, 'utf-8');
      const page = content.slice(offset, offset + limit);
      const more = offset + limit < content.length;
      // Repeated-identical-read stub: same (path|offset|limit) yielding the same
      // bytes twice → don't re-send the content.
      const key = `${resolved}|${offset}|${limit}`;
      const hash = crypto.createHash('sha256').update(page).digest('hex');
      if (_lastReads.get(key) === hash) {
        return {
          success: true,
          path: resolved,
          stub: true,
          note: 'Identical to a prior read this session (same path + range + content) — content omitted to save context. Re-read a different range or re-run only if you expect it changed.',
          size: content.length,
        };
      }
      _lastReads.set(key, hash);
      return {
        success: true,
        path: resolved,
        content: page,
        offset,
        size: content.length,
        ...(more ? fileReadHandle(resolved, offset + limit, limit, content.length) : { truncated: false }),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, path: resolved };
    }
  },
};
