/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserFill.ts — `browser_fill` wrapper.
 *
 * Fill multiple form fields in a single call. Internally fans out to
 * `pwType` per selector. Stops at the first failing selector and
 * reports which fields succeeded.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwType } from '../../../core/playwrightBridge';

export const browserFillTool: ToolHandler = {
  schema: {
    name: 'browser_fill',
    description:
      'Fill multiple form fields. Pass `fields` as an object mapping CSS selectors to text values.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          description:
            'Object mapping CSS selectors to the text to enter in each.',
        },
      },
      required: ['fields'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  async execute(args) {
    const fields = (args.fields ?? {}) as Record<string, unknown>;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return { success: false, error: 'fields must be an object' };
    }
    const filled: string[] = [];
    for (const [selector, value] of Object.entries(fields)) {
      const text = value == null ? '' : String(value);
      const r = await pwType(selector, text);
      if (!r.ok) {
        return {
          success: false,
          error: r.error,
          selector,
          filled,
        };
      }
      filled.push(selector);
    }
    return { success: true, filled, count: filled.length };
  },
};
