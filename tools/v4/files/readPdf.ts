/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/readPdf.ts — `read_pdf`. v4.13 Phase D.
 *
 * Extract text from a local PDF so the model can summarize it. Thin
 * wrapper over the existing channel-side extractor
 * (core/channels/pdf-extract.ts — pdf-parse under the hood, 20 MB size
 * cap, hard char cap with honest truncation flags). Read-only; same
 * path expansion + sandbox preflight discipline as file_read.
 */

import path from 'node:path';
import os from 'node:os';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { isPathAllowed, violationEnvelope } from '../../../core/v4/sandboxFs';
import { extractPdfForChannel, MAX_PDF_BYTES } from '../../../core/channels/pdf-extract';

function expandPath(input: string, cwd: string): string {
  const home = os.homedir();
  let p = input;
  if (/^~[\\/]/i.test(p)) p = home + p.slice(1);
  if (path.isAbsolute(p)) return p;
  if (/^[A-Z]:/i.test(p)) return p;
  return path.join(cwd, p);
}

export const readPdfTool: ToolHandler = {
  schema: {
    name: 'read_pdf',
    description:
      'Extract the text of a local PDF file (for summarizing/analyzing). ' +
      `Size-capped at ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB; long documents are truncated with an honest flag.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PDF file path. Absolute or relative to cwd.' },
      },
      required: ['path'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'files',
  riskTier: 'safe',
  async execute(args, ctx) {
    const raw = String(args.path ?? '').trim();
    if (!raw) return { success: false, error: 'path is required' };
    const expanded = expandPath(raw, ctx.cwd);
    const policy = isPathAllowed(expanded, 'read', ctx.cwd);
    if (!policy.allowed) {
      return {
        success: false,
        error: policy.violation!.message,
        sandbox_violation: violationEnvelope(policy),
      };
    }
    const result = await extractPdfForChannel({ filePath: policy.resolvedPath });
    if (!result.success) {
      return { success: false, error: result.error ?? 'pdf extraction failed', path: policy.resolvedPath };
    }
    return {
      success:   true,
      path:      policy.resolvedPath,
      pageCount: result.pageCount,
      wordCount: result.wordCount,
      truncated: result.truncated === true,
      text:      result.text ?? '',
    };
  },
};
