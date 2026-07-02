/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileList.ts — `file_list` wrapper.
 *
 * Lists directory contents. Same path expansion as `file_read`
 * (`~`, `Desktop/`, drive letters). Returns one entry per line
 * to match the v3 format the prompt has been training models on.
 *
 * Status: PHASE 7. Read-only.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { isPathAllowed, violationEnvelope } from '../../../core/v4/sandboxFs';

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

export const fileListTool: ToolHandler = {
  schema: {
    name: 'file_list',
    description:
      'List the entries (files and subdirectories) of a directory. Defaults to the agent\'s working directory when no path is given.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory path. Absolute or relative to cwd. Defaults to cwd when omitted.',
        },
        stat: {
          type: 'boolean',
          description:
            'When true, include size (bytes) and mtimeMs per entry. Useful for grouping and duplicate pre-filtering by size.',
        },
        hash: {
          type: 'boolean',
          description:
            'When true, include sha256 per FILE entry (implies stat). Content identity for duplicate detection. Files over 50 MB are skipped (hash omitted, hashSkipped: true).',
        },
      },
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'files',
  riskTier: 'safe',   // v4.4 Phase 1
  async execute(args, ctx) {
    const raw = String(args.path ?? args.dir ?? ctx.cwd).trim();
    // v4.4 Phase 2 — sandbox preflight (no-op when AIDEN_SANDBOX!=1).
    const policy = isPathAllowed(raw || ctx.cwd, 'read', ctx.cwd);
    if (!policy.allowed) {
      return {
        success: false,
        error: policy.violation!.message,
        sandbox_violation: violationEnvelope(policy),
      };
    }
    const resolved = policy.resolvedPath;
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      // v4.13 Phase D — optional stat + content hash. `hash` implies
      // `stat`; sha256 is size-guarded (files over the cap get
      // hashSkipped: true instead of stalling the turn on a huge blob).
      // Read-only additions: the tool stays a primitive — grouping,
      // duplicate grouping, and screenshot heuristics are the model's job.
      const wantHash = args.hash === true;
      const wantStat = wantHash || args.stat === true;
      const HASH_MAX_BYTES = 50 * 1024 * 1024;
      const items: Array<Record<string, unknown>> = [];
      for (const e of entries) {
        const item: Record<string, unknown> = {
          name: e.name,
          type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
        };
        if (wantStat && item.type === 'file') {
          try {
            const st = await fs.stat(path.join(resolved, e.name));
            item.size = st.size;
            item.mtimeMs = st.mtimeMs;
            if (wantHash) {
              if (st.size > HASH_MAX_BYTES) {
                item.hashSkipped = true;
              } else {
                const buf = await fs.readFile(path.join(resolved, e.name));
                item.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
              }
            }
          } catch { /* per-entry stat/hash failure — entry stays listed */ }
        }
        items.push(item);
      }
      return {
        success: true,
        path: resolved,
        count: items.length,
        entries: items,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, path: resolved };
    }
  },
};
