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

export const browserCloseTool: ToolHandler = {
  schema: {
    name: 'browser_close',
    description:
      'Close the persistent browser session. The next browser tool will start a new one.',
    inputSchema: { type: 'object', properties: {} },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  async execute() {
    try {
      await pwClose();
      return { success: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  },
};
