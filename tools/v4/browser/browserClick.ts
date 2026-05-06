/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserClick.ts — `browser_click` wrapper.
 *
 * Click an element by CSS selector or visible text. Pass
 * `target: "first_result"` for the search-result shortcut on
 * Google/YouTube/DuckDuckGo/Bing.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwClick, pwClickFirstResult } from '../../../core/playwrightBridge';

export const browserClickTool: ToolHandler = {
  schema: {
    name: 'browser_click',
    description:
      'Click an element by CSS selector or visible text. Use target="first_result" to click the first organic search result on supported engines.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'CSS selector, visible text, or "first_result".',
        },
      },
      required: ['target'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  async execute(args) {
    const target = String(args.target ?? args.selector ?? '').trim();
    if (!target) return { success: false, error: 'No target provided' };
    if (target === 'first_result') {
      const r = await pwClickFirstResult();
      if (r.ok) return { success: true, url: r.url };
      return { success: false, error: r.error };
    }
    const r = await pwClick(target);
    if (r.ok) return { success: true, target };
    return { success: false, error: r.error, target };
  },
};
