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

import type { ToolHandler } from '../../../core/v4/toolRegistry';

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
      },
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'files',
  async execute(args, ctx) {
    const raw = String(args.path ?? args.dir ?? ctx.cwd).trim();
    const resolved = expandPath(raw || ctx.cwd, ctx.cwd);
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const items = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }));
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
