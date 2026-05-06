/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/web/webSearch.ts — `web_search` wrapper.
 *
 * Delegates to the v3 `reliableWebSearch` fallback chain
 * (SearxNG → Brave → DuckDuckGo → Wikipedia) — the chain is
 * battle-tested and the moat we're keeping verbatim.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { reliableWebSearch } from '../../../core/webSearch';

export const webSearchTool: ToolHandler = {
  schema: {
    name: 'web_search',
    description:
      'Search the web for current information. Returns a synthesised text answer drawn from search snippets, Wikipedia summaries, and (when available) full page content from the top results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
  },
  category: 'network',
  mutates: false,
  toolset: 'web',
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return { success: false, error: 'No query provided' };
    }
    return reliableWebSearch(query);
  },
};
