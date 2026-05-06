/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserScroll.ts — `browser_scroll` wrapper.
 *
 * Scroll the page or a specific element. Direction is one of
 * `up | down | top | bottom`. `amount` (px) only applies for
 * up/down; ignored for top/bottom.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwScroll } from '../../../core/playwrightBridge';

export const browserScrollTool: ToolHandler = {
  schema: {
    name: 'browser_scroll',
    description:
      'Scroll the browser page (or a specific element via `selector`). `direction` ∈ up|down|top|bottom; `amount` is pixels for up/down (default 500).',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down', 'top', 'bottom'],
          description: 'Scroll direction (default: down).',
        },
        amount: {
          type: 'number',
          description: 'Pixels for up/down (default 500).',
        },
        selector: {
          type: 'string',
          description: 'Optional CSS selector to scroll a specific element.',
        },
      },
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  async execute(args) {
    const directionRaw = String(args.direction ?? 'down').toLowerCase();
    const direction = (
      ['up', 'down', 'top', 'bottom'] as const
    ).includes(directionRaw as never)
      ? (directionRaw as 'up' | 'down' | 'top' | 'bottom')
      : 'down';
    const amount = typeof args.amount === 'number' ? args.amount : 500;
    const selector =
      typeof args.selector === 'string' && args.selector ? args.selector : undefined;
    const r = await pwScroll(direction, amount, selector);
    if (r.ok) return { success: true, direction, amount, selector };
    return { success: false, error: r.error };
  },
};
