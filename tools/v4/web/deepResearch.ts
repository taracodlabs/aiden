/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/web/deepResearch.ts — `deep_research` wrapper.
 *
 * Three-pass research using v3's `deepResearch` fallback chain.
 * Returns a multi-source synthesised answer. Slow (60s timeout
 * advertised by v3) — Phase 9 will surface budget warnings to
 * the user before the agent picks this over `web_search`.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { deepResearch } from '../../../core/webSearch';

export const deepResearchTool: ToolHandler = {
  schema: {
    name: 'deep_research',
    description:
      'Conduct multi-pass research on a topic. Drives the same fallback chain as web_search but synthesises across multiple queries — slower than web_search; reach for it when one query won\'t cut it.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The research topic or question.',
        },
      },
      required: ['topic'],
    },
  },
  category: 'network',
  mutates: false,
  toolset: 'web',
  async execute(args) {
    const topic = String(args.topic ?? '').trim();
    if (!topic) return { success: false, error: 'No topic provided' };
    return deepResearch(topic);
  },
};
