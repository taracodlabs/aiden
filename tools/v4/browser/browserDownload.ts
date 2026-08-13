/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwDownload } from '../../../core/playwrightBridge';
import { currentBrowserLeaseStore } from '../../../core/v4/browser/browserLeaseScope';
import { withBrowserState } from './_observer';

const _browserDownloadTool: ToolHandler = {
  schema: {
    name: 'browser_download',
    description: 'Click one download control and verify the completed file in Aiden artifact storage.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
        selector: { type: 'string', description: 'CSS selector when ref is not supplied.' },
      },
    },
  },
  category: 'browser', mutates: true, toolset: 'browser', riskTier: 'caution',
  buildPreview(args) {
    const target = String(args.ref ?? args.selector ?? 'download control');
    return {
      tool: 'browser_download', args, riskTier: 'caution',
      sideEffects: [{ type: 'browser_action', action: 'download', target }],
      detectedRisks: [], summary: `Would download from ${target} into Aiden artifact storage`,
    };
  },
  async execute(args) {
    const ref = String(args.ref ?? '').trim();
    const lease = ref ? currentBrowserLeaseStore().get(ref) : undefined;
    if (ref && !lease) return { success: false, error: `Element ref ${ref} is stale. Run browser_snapshot before retrying.` };
    const selector = lease?.css_path ?? String(args.selector ?? '').trim();
    if (!selector) return { success: false, error: 'ref or selector is required' };
    const result = await pwDownload(selector);
    return result.ok
      ? {
          success: true, verified: result.verified === true, path: result.path,
          artifactPath: result.path, filename: result.filename, size: result.size,
          bytes: result.size, sha256: result.sha256,
        }
      : { success: false, error: result.error };
  },
};

export const browserDownloadTool = withBrowserState(_browserDownloadTool);
