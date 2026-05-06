/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserType.ts — `browser_type` wrapper.
 *
 * Type/fill text into a single input element identified by selector.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwType } from '../../../core/playwrightBridge';

export const browserTypeTool: ToolHandler = {
  schema: {
    name: 'browser_type',
    description:
      'Type text into a browser input identified by CSS selector. Replaces existing value.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the input field.',
        },
        text: { type: 'string', description: 'Text to enter.' },
      },
      required: ['selector', 'text'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  async execute(args) {
    const selector = String(args.selector ?? 'input').trim();
    const text = String(args.text ?? '');
    const r = await pwType(selector, text);
    if (r.ok) return { success: true, selector };
    return { success: false, error: r.error, selector };
  },
};
