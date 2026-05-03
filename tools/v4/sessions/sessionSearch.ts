/**
 * tools/v4/sessions/sessionSearch.ts — `session_search` wrapper.
 *
 * NEW IN V4: surfaces FTS5 keyword search across all stored
 * conversations (Phase 6's `SessionStore`). The agent reaches
 * for this when the user asks "what did we decide about X" and
 * the answer might be in a previous session.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export const sessionSearchTool: ToolHandler = {
  schema: {
    name: 'session_search',
    description:
      'Search past conversation sessions by keyword (FTS5 full-text). Returns matching message snippets with the session id and timestamp. Use to recall something the user said in an earlier conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords or phrase to search for.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of matches to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
        },
      },
      required: ['query'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'sessions',
  async execute(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) return { success: false, error: 'No query provided' };
    if (!ctx.sessions) {
      return {
        success: false,
        error: 'Session manager not available in this context',
      };
    }
    const requested = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)));
    const results = ctx.sessions.search(query, limit);
    return {
      success: true,
      query,
      count: results.length,
      results,
    };
  },
};
