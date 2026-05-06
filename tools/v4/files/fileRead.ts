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
 * approval engine in Phase 9 will replace this with a structured
 * permission check, but we keep the same minimum guarantees here.
 *
 * Status: PHASE 7. Read-only.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const MAX_OUTPUT = 5000;

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
      'Read the contents of a file. Returns up to 5000 characters. Supports `~`, `Desktop/`, and `C:\\` paths; relative paths are resolved against the agent\'s working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path. Absolute or relative to cwd.',
        },
      },
      required: ['path'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'files',
  async execute(args, ctx) {
    const raw = String(args.path ?? args.file ?? '').trim();
    if (!raw) return { success: false, error: 'No path provided' };
    if (isDenied(raw)) {
      return {
        success: false,
        error: 'Access denied: protected path (credentials/keys/.env)',
      };
    }
    const resolved = expandPath(raw, ctx.cwd);
    try {
      const content = await fs.readFile(resolved, 'utf-8');
      return {
        success: true,
        path: resolved,
        content: content.slice(0, MAX_OUTPUT),
        truncated: content.length > MAX_OUTPUT,
        size: content.length,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, path: resolved };
    }
  },
};
