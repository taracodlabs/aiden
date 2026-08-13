/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserClose.ts — `browser_close` wrapper.
 *
 * Close the persistent browser context. The next browser tool that
 * runs will spin up a fresh context — `pwClose` is reentrant.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwClose } from '../../../core/playwrightBridge';
import { withBrowserState } from './_observer';

const _browserCloseTool: ToolHandler = {
  schema: {
    name: 'browser_close',
    description:
      'Close the persistent browser session. The next browser tool will start a new one.',
    inputSchema: { type: 'object', properties: {} },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    return {
      tool: 'browser_close',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'browser_action', action: 'close' }],
      detectedRisks: [],
      summary: 'Would close the browser session',
    };
  },
  async execute() {
    try {
      await pwClose();
      return { success: true, verified: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  },
};

// v4.3 Phase 1 — observer HOC. After close the post-snapshot will
// either spin up a fresh context (and return null on the first call
// since the page is blank) or fail cleanly — either way the sidecar
// just doesn't embed. Tiny overhead, uniform pattern.
export const browserCloseTool = withBrowserState(_browserCloseTool);
