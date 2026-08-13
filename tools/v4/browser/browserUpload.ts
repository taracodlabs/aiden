/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserUpload.ts — v4.12 B4.2a.
 *
 * Consent-gated file upload. The file-chooser EVENT is recorded passively (never
 * auto-fulfilled); THIS is the explicit, approved action that actually sends the
 * user's file(s) to the page. mutates + dangerous → the executor's B5.2 gate
 * approves it before the filesystem is ever touched.
 */
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwUpload } from '../../../core/playwrightBridge';
import { withBrowserState } from './_observer';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

const _browserUploadTool: ToolHandler = {
  schema: {
    name: 'browser_upload',
    description:
      'Upload local file(s) to a file <input> on the page. selector = CSS for the input; paths = absolute file path(s). Sends your files to the page — confirm-gated.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the <input type="file">.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute path(s) of the file(s) to upload.' },
      },
      required: ['selector', 'paths'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  riskTier: 'dangerous',
  buildPreview(args) {
    const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
    return {
      tool: 'browser_upload',
      args,
      riskTier: 'dangerous',
      sideEffects: [{ type: 'browser_action', action: 'upload', target: String(args.selector ?? '') }],
      detectedRisks: [`Uploads ${paths.length} file(s) to the page: ${paths.join(', ')}`],
      summary: `Would upload ${paths.length} file(s) to ${String(args.selector ?? '')}`,
    };
  },
  async execute(args) {
    const selector = String(args.selector ?? '').trim();
    const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
    if (!selector || paths.length === 0) return { success: false, error: 'selector and paths are required' };
    if (paths.length > 10) return { success: false, error: 'At most 10 files may be uploaded in one action' };
    for (const file of paths) {
      if (!isAbsolute(file)) return { success: false, error: 'Upload paths must be absolute' };
      try {
        const stat = statSync(file);
        if (!stat.isFile()) return { success: false, error: 'Upload target must be a regular file' };
        if (stat.size > 25 * 1024 * 1024) return { success: false, error: 'Upload file exceeds the 25 MB safety limit' };
      } catch {
        return { success: false, error: 'Upload file is unavailable' };
      }
    }
    const r = await pwUpload(selector, paths);
    return r.ok
      ? { success: true, files: r.files, verified: r.verified === true }
      : { success: false, error: r.error, files: r.files };
  },
};

export const browserUploadTool = withBrowserState(_browserUploadTool);
